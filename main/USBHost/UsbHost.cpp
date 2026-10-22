#include "UsbHost.h"

#if CONFIG_CELEROS_USB_HOST

#include <esp_err.h>
#include <esp_intr_alloc.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <usb/usb_host.h>

// ============================================================================
// USB Host core (API 48). Ver UsbHost.h para o contrato publico.
//
// Modelo de concorrencia:
//   - usblib: task que drena os eventos da pilha do IDF (install/enum/root).
//   - usbcli: task que drena os eventos do NOSSO client (NEW_DEV/DEV_GONE) e
//     roda os callbacks de transferencia. JS NUNCA e chamado daqui.
//   - s_mux protege registry, claims, fila de hotplug e o ring dos listeners.
//     NUNCA e segurado enquanto se espera uma transferencia (o callback roda
//     na usbcli e precisa do mutex).
//   - Pool de 6 transfers: cada slot tem um semaforo binario. Timeout devolve
//     erro e marca o slot "abandoned"; o callback libera quando a pilha
//     devolver o URB (nunca free antes da conclusao).
// ============================================================================

namespace {

constexpr const char* kTag = "celer.usbhost";

constexpr int kMaxDevices = 8;
constexpr int kMaxSlots = 6;
constexpr int kMaxListeners = 4;
constexpr int kEventRing = 8;
constexpr size_t kCtrlSetup = 8;
constexpr size_t kFileChunk = 2048;

struct DevSlot {
    bool used = false;
    bool gone = false;
    uint8_t addr = 0;
    usb_device_handle_t hdl = nullptr;
    usbdesc::DevDesc desc;
    uint8_t speed = 0;
    uint8_t nClaims = 0;
    UsbHost::Claim claims[usbdesc::kMaxIfaces];
};

struct XferSlot {
    bool busy = false;
    bool abandoned = false;
    usb_transfer_t* x = nullptr;
    SemaphoreHandle_t sem = nullptr;
    int resStatus = -1;
    int resActual = 0;
};

// Ring de um endpoint IN continuo. `len` fixo por listener (report HID,
// pacote de status...) e depth registros. Se o ring enche, o registro novo
// e descartado (o driver le no ritmo dele; o device continua NAKando).
struct Listener {
    bool used = false;
    bool stopping = false;
    uint8_t addr = 0;
    uint8_t ep = 0;
    uint16_t len = 0;
    uint8_t depth = 0;
    uint8_t head = 0;
    uint8_t tail = 0;
    uint8_t count = 0;
    char owner[32] = {0};
    uint8_t* ring = nullptr;
    uint16_t* lens = nullptr;
    usb_transfer_t* x = nullptr;
};

SemaphoreHandle_t s_mux = nullptr;
usb_host_client_handle_t s_client = nullptr;
bool s_inited = false;

DevSlot s_devs[kMaxDevices];
XferSlot s_slots[kMaxSlots];
Listener s_listeners[kMaxListeners];

UsbHost::Event s_events[kEventRing];
uint8_t s_evHead = 0;
uint8_t s_evTail = 0;

// ------------------------------------------------------------------ helpers

DevSlot* findDevLocked(uint8_t addr) {
    for (auto& d : s_devs) {
        if (d.used && !d.gone && d.addr == addr) return &d;
    }
    return nullptr;
}

usb_device_handle_t handleFor(uint8_t addr) {
    usb_device_handle_t h = nullptr;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    DevSlot* d = findDevLocked(addr);
    if (d != nullptr) h = d->hdl;
    xSemaphoreGive(s_mux);
    return h;
}

void pushEventLocked(uint8_t type, uint8_t addr, uint16_t vid, uint16_t pid) {
    uint8_t next = (uint8_t)((s_evHead + 1) % kEventRing);
    if (next == s_evTail) s_evTail = (uint8_t)((s_evTail + 1) % kEventRing);  // cheio: derruba o mais velho
    s_events[s_evHead].type = type;
    s_events[s_evHead].addr = addr;
    s_events[s_evHead].vid = vid;
    s_events[s_evHead].pid = pid;
    s_evHead = next;
}

const char* statusName(int st) {
    switch (st) {
        case USB_TRANSFER_STATUS_COMPLETED: return "ok";
        case USB_TRANSFER_STATUS_ERROR: return "error";
        case USB_TRANSFER_STATUS_TIMED_OUT: return "timeout";
        case USB_TRANSFER_STATUS_CANCELED: return "canceled";
        case USB_TRANSFER_STATUS_STALL: return "stall";
        case USB_TRANSFER_STATUS_OVERFLOW: return "overflow";
        case USB_TRANSFER_STATUS_SKIPPED: return "skipped";
        case USB_TRANSFER_STATUS_NO_DEVICE: return "gone";
        default: return "error";
    }
}

UsbHost::Result resultFrom(int st, size_t n) {
    UsbHost::Result r;
    r.ok = (st == USB_TRANSFER_STATUS_COMPLETED);
    r.status = statusName(st);
    r.transferred = n;
    return r;
}

// ------------------------------------------------------------------- slots

XferSlot* acquireSlot() {
    XferSlot* out = nullptr;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    for (auto& s : s_slots) {
        if (!s.busy) {
            s.busy = true;
            s.abandoned = false;
            s.x = nullptr;
            s.resStatus = -1;
            s.resActual = 0;
            out = &s;
            break;
        }
    }
    xSemaphoreGive(s_mux);
    return out;
}

void releaseSlot(XferSlot* s, usb_transfer_t* x) {
    if (x != nullptr) usb_host_transfer_free(x);
    xSemaphoreTake(s_mux, portMAX_DELAY);
    s->x = nullptr;
    s->abandoned = false;
    s->busy = false;
    xSemaphoreGive(s_mux);
}

// Callback de transferencia (roda na usbcli). So copia o resultado e acorda
// quem espera; se o dono desistiu (timeout), libera o URB aqui.
void xferCb(usb_transfer_t* x) {
    XferSlot* s = (XferSlot*)x->context;
    if (s == nullptr) return;
    s->resStatus = (int)x->status;
    s->resActual = x->actual_num_bytes;
    xSemaphoreGive(s->sem);
    xSemaphoreTake(s_mux, portMAX_DELAY);
    if (s->abandoned && s->x == x) {
        usb_host_transfer_free(x);
        s->x = nullptr;
        s->abandoned = false;
        s->busy = false;
    }
    xSemaphoreGive(s_mux);
}

// Espera a conclusao. `inBuf` != nullptr copia o payload IN antes de liberar
// o URB (offset 8 nos transfers de controle). Nunca segura s_mux esperando.
UsbHost::Result waitSlot(XferSlot* s, uint32_t timeoutMs, uint8_t* inBuf, size_t inCap,
                         size_t dataOffset) {
    bool got = (xSemaphoreTake(s->sem, pdMS_TO_TICKS(timeoutMs)) == pdTRUE);
    xSemaphoreTake(s_mux, portMAX_DELAY);
    if (!got) {
        // Corrida: completou entre o timeout e o mutex?
        got = (xSemaphoreTake(s->sem, 0) == pdTRUE);
        if (!got) {
            s->abandoned = true;  // callback libera quando a pilha devolver
            xSemaphoreGive(s_mux);
            UsbHost::Result r;
            r.ok = false;
            r.status = "timeout";
            r.transferred = 0;
            return r;
        }
    }
    const int st = s->resStatus;
    const int actual = s->resActual;
    size_t copied = 0;
    if (st == USB_TRANSFER_STATUS_COMPLETED && inBuf != nullptr && inCap > 0) {
        copied = (actual > 0) ? (size_t)actual : 0;
        if (copied > inCap) copied = inCap;
        if (s->x != nullptr && copied > 0) {
            memcpy(inBuf, s->x->data_buffer + dataOffset, copied);
        }
    }
    if (s->x != nullptr) {
        usb_host_transfer_free(s->x);
        s->x = nullptr;
    }
    s->abandoned = false;
    s->busy = false;
    xSemaphoreGive(s_mux);
    UsbHost::Result r = resultFrom(st, copied);
    return r;
}

// ------------------------------------------------------------------ events

void addDevice(uint8_t addr) {
    usb_device_handle_t hdl = nullptr;
    esp_err_t e = usb_host_device_open(s_client, addr, &hdl);
    if (e != ESP_OK || hdl == nullptr) {
        ESP_LOGW(kTag, "open addr %u falhou (%s)", addr, esp_err_to_name(e));
        return;
    }

    usb_device_info_t info = {};
    usb_host_device_info(hdl, &info);

    usbdesc::DevDesc desc;
    const usb_device_desc_t* dd = nullptr;
    if (usb_host_get_device_descriptor(hdl, &dd) == ESP_OK && dd != nullptr) {
        desc.vid = dd->idVendor;
        desc.pid = dd->idProduct;
        desc.cls = dd->bDeviceClass;
        desc.subcls = dd->bDeviceSubClass;
        desc.proto = dd->bDeviceProtocol;
        desc.mps0 = dd->bMaxPacketSize0;
    }
    const usb_config_desc_t* cd = nullptr;
    if (usb_host_get_active_config_descriptor(hdl, &cd) == ESP_OK && cd != nullptr) {
        if (!usbdesc::parseConfig((const uint8_t*)cd, cd->wTotalLength, desc)) {
            ESP_LOGW(kTag, "addr %u: config descriptor sem interface", addr);
        }
    }
    desc.speed = (uint8_t)info.speed;

    xSemaphoreTake(s_mux, portMAX_DELAY);
    DevSlot* slot = nullptr;
    for (auto& d : s_devs) {
        if (!d.used) {
            slot = &d;
            break;
        }
    }
    if (slot == nullptr) {
        xSemaphoreGive(s_mux);
        ESP_LOGW(kTag, "sem slot para addr %u (max %d)", addr, kMaxDevices);
        usb_host_device_close(s_client, hdl);
        return;
    }
    slot->used = true;
    slot->gone = false;
    slot->addr = addr;
    slot->hdl = hdl;
    slot->desc = desc;
    slot->speed = (uint8_t)info.speed;
    slot->nClaims = 0;
    pushEventLocked(UsbHost::kEventAdd, addr, desc.vid, desc.pid);
    xSemaphoreGive(s_mux);

    ESP_LOGI(kTag, "add addr %u vid=%04x pid=%04x class=%u ifs=%u", addr, desc.vid, desc.pid,
             desc.cls, desc.nIfs);
}

void goneDevice(usb_device_handle_t hdl) {
    xSemaphoreTake(s_mux, portMAX_DELAY);
    for (auto& d : s_devs) {
        if (!d.used || d.hdl != hdl) continue;
        const uint8_t addr = d.addr;
        pushEventLocked(UsbHost::kEventRemove, addr, d.desc.vid, d.desc.pid);
        // Device sumiu: a pilha ja invalida o handle; claims/listeners morrem
        // junto (os URBs pendentes completam com NO_DEVICE).
        d.used = false;
        d.gone = true;
        d.hdl = nullptr;
        d.nClaims = 0;
        for (auto& L : s_listeners) {
            if (L.used && L.addr == addr) L.stopping = true;
        }
        ESP_LOGI(kTag, "remove addr %u", addr);
        break;
    }
    xSemaphoreGive(s_mux);
}

// Callback do client (roda na usbcli).
void clientCb(const usb_host_client_event_msg_t* msg, void*) {
    if (msg == nullptr) return;
    switch (msg->event) {
        case USB_HOST_CLIENT_EVENT_NEW_DEV:
            addDevice(msg->new_dev.address);
            break;
        case USB_HOST_CLIENT_EVENT_DEV_GONE:
            goneDevice(msg->dev_gone.dev_hdl);
            break;
        default:
            break;
    }
}

// ------------------------------------------------------------------- tasks

void hostLibTask(void*) {
    while (true) {
        uint32_t flags = 0;
        usb_host_lib_handle_events(portMAX_DELAY, &flags);
    }
}

void clientTask(void*) {
    while (true) {
        usb_host_client_handle_events(s_client, portMAX_DELAY);
    }
}

// --------------------------------------------------------------- listeners

void cleanupListenerLocked(Listener& L) {
    if (L.ring != nullptr) free(L.ring);
    if (L.lens != nullptr) free(L.lens);
    L.ring = nullptr;
    L.lens = nullptr;
    L.x = nullptr;
    L.used = false;
    L.stopping = false;
    L.count = 0;
    L.head = L.tail = 0;
}

void listenCb(usb_transfer_t* x) {
    Listener* L = (Listener*)x->context;
    if (L == nullptr) return;
    bool stop = false;

    if (L->stopping) {
        stop = true;
    } else if (x->status == USB_TRANSFER_STATUS_COMPLETED) {
        size_t n = (x->actual_num_bytes > 0) ? (size_t)x->actual_num_bytes : 0;
        if (n > L->len) n = L->len;
        if (n > 0) {
            xSemaphoreTake(s_mux, portMAX_DELAY);
            uint8_t next = (uint8_t)((L->head + 1) % L->depth);
            if (next != L->tail && L->ring != nullptr) {
                memcpy(L->ring + (size_t)L->head * L->len, x->data_buffer, n);
                L->lens[L->head] = (uint16_t)n;
                L->head = next;
                L->count++;
            }
            xSemaphoreGive(s_mux);
        }
        x->num_bytes = L->len;
        if (usb_host_transfer_submit(x) != ESP_OK) stop = true;
    } else if (x->status == USB_TRANSFER_STATUS_TIMED_OUT ||
               x->status == USB_TRANSFER_STATUS_SKIPPED) {
        x->num_bytes = L->len;
        if (usb_host_transfer_submit(x) != ESP_OK) stop = true;
    } else {
        stop = true;  // stall/erro/cancelado/sem device
    }

    if (stop) {
        usb_host_transfer_free(x);
        xSemaphoreTake(s_mux, portMAX_DELAY);
        cleanupListenerLocked(*L);
        xSemaphoreGive(s_mux);
    }
}

}  // namespace

namespace UsbHost {

void init() {
    if (s_inited) return;
    s_mux = xSemaphoreCreateMutex();
    if (s_mux == nullptr) return;
    for (auto& s : s_slots) s.sem = xSemaphoreCreateBinary();
    for (auto& s : s_slots) {
        if (s.sem == nullptr) return;
    }

    usb_host_config_t cfg = {};
    cfg.skip_phy_setup = false;       // PHY interno do S3 (GPIO19/20)
    cfg.intr_flags = ESP_INTR_FLAG_LOWMED;
    cfg.peripheral_map = 0;           // default do alvo
    esp_err_t e = usb_host_install(&cfg);
    if (e != ESP_OK) {
        ESP_LOGE(kTag, "usb_host_install falhou (%s)", esp_err_to_name(e));
        return;
    }

    usb_host_client_config_t ccfg = {};
    ccfg.is_synchronous = false;
    ccfg.max_num_event_msg = 5;
    ccfg.async.client_event_callback = clientCb;
    ccfg.async.callback_arg = nullptr;
    e = usb_host_client_register(&ccfg, &s_client);
    if (e != ESP_OK) {
        ESP_LOGE(kTag, "client_register falhou (%s)", esp_err_to_name(e));
        usb_host_uninstall();
        return;
    }

    BaseType_t ok1 = xTaskCreatePinnedToCore(hostLibTask, "usblib", 4096, nullptr, 3, nullptr, 0);
    BaseType_t ok2 = xTaskCreatePinnedToCore(clientTask, "usbcli", 5120, nullptr, 4, nullptr, 0);
    if (ok1 != pdPASS || ok2 != pdPASS) {
        ESP_LOGE(kTag, "tasks do USB host nao nasceram");
        return;
    }

    s_inited = true;
    ESP_LOGI(kTag, "USB host instalado (PHY interno)");
}

bool available() { return s_inited; }

int deviceCount() {
    if (!s_inited) return 0;
    int n = 0;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    for (auto& d : s_devs) {
        if (d.used && !d.gone) n++;
    }
    xSemaphoreGive(s_mux);
    return n;
}

bool deviceAt(int index, DeviceInfo& out) {
    if (!s_inited || index < 0) return false;
    bool ok = false;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    int i = 0;
    for (auto& d : s_devs) {
        if (!d.used || d.gone) continue;
        if (i++ != index) continue;
        out.addr = d.addr;
        out.vid = d.desc.vid;
        out.pid = d.desc.pid;
        out.cls = d.desc.cls;
        out.subcls = d.desc.subcls;
        out.proto = d.desc.proto;
        out.speed = d.speed;
        out.desc = d.desc;
        out.nClaims = d.nClaims;
        for (int c = 0; c < d.nClaims && c < usbdesc::kMaxIfaces; c++) out.claims[c] = d.claims[c];
        ok = true;
        break;
    }
    xSemaphoreGive(s_mux);
    return ok;
}

bool deviceByAddr(uint8_t addr, DeviceInfo& out) {
    if (!s_inited) return false;
    bool ok = false;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    DevSlot* d = findDevLocked(addr);
    if (d != nullptr) {
        out.addr = d->addr;
        out.vid = d->desc.vid;
        out.pid = d->desc.pid;
        out.cls = d->desc.cls;
        out.subcls = d->desc.subcls;
        out.proto = d->desc.proto;
        out.speed = d->speed;
        out.desc = d->desc;
        out.nClaims = d->nClaims;
        for (int c = 0; c < d->nClaims && c < usbdesc::kMaxIfaces; c++) out.claims[c] = d->claims[c];
        ok = true;
    }
    xSemaphoreGive(s_mux);
    return ok;
}

bool pollEvent(Event& out) {
    if (!s_inited) return false;
    bool ok = false;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    if (s_evTail != s_evHead) {
        out = s_events[s_evTail];
        s_evTail = (uint8_t)((s_evTail + 1) % kEventRing);
        ok = true;
    }
    xSemaphoreGive(s_mux);
    return ok;
}

Result controlIn(uint8_t addr, uint8_t bmRequestType, uint8_t bRequest, uint16_t wValue,
                 uint16_t wIndex, uint8_t* buf, size_t len, uint32_t timeoutMs) {
    Result bad;
    if (!s_inited || buf == nullptr) return bad;
    if (len > kMaxControl || len + kCtrlSetup > CONFIG_USB_HOST_CONTROL_TRANSFER_MAX_SIZE) return bad;
    usb_device_handle_t hdl = handleFor(addr);
    if (hdl == nullptr) {
        bad.status = "gone";
        return bad;
    }
    XferSlot* s = acquireSlot();
    if (s == nullptr) {
        bad.status = "busy";
        return bad;
    }
    usb_transfer_t* x = nullptr;
    if (usb_host_transfer_alloc(kCtrlSetup + len, 0, &x) != ESP_OK || x == nullptr) {
        releaseSlot(s, nullptr);
        return bad;
    }
    usb_setup_packet_t* setup = (usb_setup_packet_t*)x->data_buffer;
    setup->bmRequestType = bmRequestType;
    setup->bRequest = bRequest;
    setup->wValue = wValue;
    setup->wIndex = wIndex;
    setup->wLength = (uint16_t)len;
    x->device_handle = hdl;
    x->bEndpointAddress = 0;
    x->num_bytes = (int)(kCtrlSetup + len);
    x->callback = xferCb;
    x->context = s;
    s->x = x;

    if (usb_host_transfer_submit_control(s_client, x) != ESP_OK) {
        releaseSlot(s, x);
        return bad;
    }
    return waitSlot(s, timeoutMs, buf, len, kCtrlSetup);
}

Result controlOut(uint8_t addr, uint8_t bmRequestType, uint8_t bRequest, uint16_t wValue,
                  uint16_t wIndex, const uint8_t* data, size_t len, uint32_t timeoutMs) {
    Result bad;
    if (!s_inited) return bad;
    if (len > kMaxControl || len + kCtrlSetup > CONFIG_USB_HOST_CONTROL_TRANSFER_MAX_SIZE) return bad;
    usb_device_handle_t hdl = handleFor(addr);
    if (hdl == nullptr) {
        bad.status = "gone";
        return bad;
    }
    XferSlot* s = acquireSlot();
    if (s == nullptr) {
        bad.status = "busy";
        return bad;
    }
    usb_transfer_t* x = nullptr;
    if (usb_host_transfer_alloc(kCtrlSetup + len, 0, &x) != ESP_OK || x == nullptr) {
        releaseSlot(s, nullptr);
        return bad;
    }
    usb_setup_packet_t* setup = (usb_setup_packet_t*)x->data_buffer;
    setup->bmRequestType = bmRequestType;
    setup->bRequest = bRequest;
    setup->wValue = wValue;
    setup->wIndex = wIndex;
    setup->wLength = (uint16_t)len;
    if (data != nullptr && len > 0) memcpy(x->data_buffer + kCtrlSetup, data, len);
    x->device_handle = hdl;
    x->bEndpointAddress = 0;
    x->num_bytes = (int)(kCtrlSetup + len);
    x->callback = xferCb;
    x->context = s;
    s->x = x;

    if (usb_host_transfer_submit_control(s_client, x) != ESP_OK) {
        releaseSlot(s, x);
        return bad;
    }
    return waitSlot(s, timeoutMs, nullptr, 0, 0);
}

Result out(uint8_t addr, uint8_t ep, const uint8_t* data, size_t len, uint32_t timeoutMs) {
    Result bad;
    if (!s_inited || len > kMaxTransfer || (ep & 0x80) != 0) return bad;
    usb_device_handle_t hdl = handleFor(addr);
    if (hdl == nullptr) {
        bad.status = "gone";
        return bad;
    }
    XferSlot* s = acquireSlot();
    if (s == nullptr) {
        bad.status = "busy";
        return bad;
    }
    usb_transfer_t* x = nullptr;
    const size_t bufLen = (len > 0) ? len : 1;
    if (usb_host_transfer_alloc(bufLen, 0, &x) != ESP_OK || x == nullptr) {
        releaseSlot(s, nullptr);
        return bad;
    }
    if (data != nullptr && len > 0) memcpy(x->data_buffer, data, len);
    x->device_handle = hdl;
    x->bEndpointAddress = ep;
    x->num_bytes = (int)len;
    x->callback = xferCb;
    x->context = s;
    s->x = x;

    if (usb_host_transfer_submit(x) != ESP_OK) {
        releaseSlot(s, x);
        return bad;
    }
    return waitSlot(s, timeoutMs, nullptr, 0, 0);
}

Result in(uint8_t addr, uint8_t ep, uint8_t* buf, size_t cap, uint32_t timeoutMs) {
    Result bad;
    if (!s_inited || buf == nullptr || cap == 0 || cap > kMaxTransfer || (ep & 0x80) == 0) return bad;
    usb_device_handle_t hdl = handleFor(addr);
    if (hdl == nullptr) {
        bad.status = "gone";
        return bad;
    }
    XferSlot* s = acquireSlot();
    if (s == nullptr) {
        bad.status = "busy";
        return bad;
    }
    usb_transfer_t* x = nullptr;
    if (usb_host_transfer_alloc(cap, 0, &x) != ESP_OK || x == nullptr) {
        releaseSlot(s, nullptr);
        return bad;
    }
    x->device_handle = hdl;
    x->bEndpointAddress = ep;
    x->num_bytes = (int)cap;
    x->callback = xferCb;
    x->context = s;
    s->x = x;

    if (usb_host_transfer_submit(x) != ESP_OK) {
        releaseSlot(s, x);
        return bad;
    }
    return waitSlot(s, timeoutMs, buf, cap, 0);
}

Result sendFile(uint8_t addr, uint8_t ep, const char* path, size_t maxBytes, uint32_t timeoutMs) {
    Result r;
    if (!s_inited || path == nullptr || (ep & 0x80) != 0) return r;
    if (maxBytes == 0 || maxBytes > kMaxFileJob) maxBytes = kMaxFileJob;

    FILE* f = fopen(path, "rb");
    if (f == nullptr) return r;
    uint8_t* chunk = (uint8_t*)malloc(kFileChunk);
    if (chunk == nullptr) {
        fclose(f);
        return r;
    }

    size_t sent = 0;
    while (sent < maxBytes) {
        size_t want = maxBytes - sent;
        if (want > kFileChunk) want = kFileChunk;
        const size_t n = fread(chunk, 1, want, f);
        if (n == 0) break;
        Result one = out(addr, ep, chunk, n, timeoutMs);
        if (!one.ok) {
            r.ok = false;
            r.status = one.status;
            r.transferred = sent;
            free(chunk);
            fclose(f);
            return r;
        }
        sent += one.transferred;
        if (one.transferred != n) {
            // Short write em bulk: o device recusou o resto (stall/limite).
            r.ok = false;
            r.status = "short";
            r.transferred = sent;
            free(chunk);
            fclose(f);
            return r;
        }
    }
    free(chunk);
    fclose(f);
    r.ok = true;
    r.status = "ok";
    r.transferred = sent;
    return r;
}

bool claim(const char* owner, uint8_t addr, uint8_t iface, uint8_t alt) {
    if (!s_inited || owner == nullptr) return false;
    usb_device_handle_t hdl = nullptr;
    bool already = false;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    DevSlot* d = findDevLocked(addr);
    if (d != nullptr) {
        hdl = d->hdl;
        for (int i = 0; i < d->nClaims; i++) {
            if (d->claims[i].iface != iface) continue;
            already = (strncmp(d->claims[i].owner, owner, sizeof(d->claims[i].owner)) == 0);
            xSemaphoreGive(s_mux);
            return already;  // mesma dona = idempotente; outra = busy
        }
    }
    xSemaphoreGive(s_mux);
    if (hdl == nullptr) return false;

    if (usb_host_interface_claim(s_client, hdl, iface, alt) != ESP_OK) return false;

    bool ok = false;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    d = findDevLocked(addr);
    if (d != nullptr && d->nClaims < usbdesc::kMaxIfaces) {
        d->claims[d->nClaims].iface = iface;
        snprintf(d->claims[d->nClaims].owner, sizeof(d->claims[d->nClaims].owner), "%s", owner);
        d->nClaims++;
        ok = true;
    }
    xSemaphoreGive(s_mux);
    if (!ok) usb_host_interface_release(s_client, hdl, iface);
    return ok;
}

bool release(const char* owner, uint8_t addr, uint8_t iface) {
    if (!s_inited || owner == nullptr) return false;
    usb_device_handle_t hdl = nullptr;
    bool found = false;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    DevSlot* d = findDevLocked(addr);
    if (d != nullptr) {
        hdl = d->hdl;
        for (int i = 0; i < d->nClaims; i++) {
            if (d->claims[i].iface != iface) continue;
            if (strncmp(d->claims[i].owner, owner, sizeof(d->claims[i].owner)) != 0) break;
            d->claims[i] = d->claims[d->nClaims - 1];
            d->nClaims--;
            found = true;
            break;
        }
    }
    xSemaphoreGive(s_mux);
    if (!found || hdl == nullptr) return false;
    return usb_host_interface_release(s_client, hdl, iface) == ESP_OK;
}

void releaseOwner(const char* owner) {
    if (!s_inited || owner == nullptr || *owner == '\0') return;
    struct Pending {
        usb_device_handle_t hdl;
        uint8_t ep;
        bool isIface;
    };
    Pending pend[kMaxDevices * usbdesc::kMaxIfaces + kMaxListeners];
    int n = 0;

    xSemaphoreTake(s_mux, portMAX_DELAY);
    for (auto& d : s_devs) {
        if (!d.used || d.gone) continue;
        for (int i = d.nClaims - 1; i >= 0; i--) {
            if (strncmp(d.claims[i].owner, owner, sizeof(d.claims[i].owner)) != 0) continue;
            if (n < (int)(sizeof(pend) / sizeof(pend[0]))) {
                pend[n++] = {d.hdl, d.claims[i].iface, true};
            }
            d.claims[i] = d.claims[d.nClaims - 1];
            d.nClaims--;
        }
    }
    // Listeners do app que saiu: sem isso o endpoint seguiria drenando para
    // um ring que ninguem le (e o device reclamaria a interface para sempre).
    for (auto& L : s_listeners) {
        if (!L.used || strncmp(L.owner, owner, sizeof(L.owner)) != 0) continue;
        L.stopping = true;
        DevSlot* d = findDevLocked(L.addr);
        if (d != nullptr && n < (int)(sizeof(pend) / sizeof(pend[0]))) {
            pend[n++] = {d->hdl, L.ep, false};
        }
    }
    xSemaphoreGive(s_mux);

    for (int i = 0; i < n; i++) {
        if (pend[i].hdl == nullptr) continue;
        if (pend[i].isIface) {
            usb_host_interface_release(s_client, pend[i].hdl, pend[i].ep);
        } else {
            usb_host_endpoint_flush(pend[i].hdl, pend[i].ep);
        }
    }
    if (n > 0) ESP_LOGI(kTag, "releaseOwner %s: %d recurso(s)", owner, n);
}

bool listen(const char* owner, uint8_t addr, uint8_t ep, uint16_t maxLen, uint8_t depth) {
    if (!s_inited || (ep & 0x80) == 0) return false;
    if (maxLen == 0 || maxLen > kMaxListenLen) return false;
    if (depth == 0) depth = 4;
    if (depth > 8) depth = 8;
    usb_device_handle_t hdl = handleFor(addr);
    if (hdl == nullptr) return false;

    Listener* L = nullptr;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    for (auto& l : s_listeners) {
        if (!l.used) {
            L = &l;
            break;
        }
    }
    if (L == nullptr) {
        xSemaphoreGive(s_mux);
        return false;
    }
    L->used = true;
    L->stopping = false;
    L->addr = addr;
    L->ep = ep;
    L->len = maxLen;
    L->depth = depth;
    L->head = L->tail = L->count = 0;
    L->x = nullptr;
    snprintf(L->owner, sizeof(L->owner), "%s", owner != nullptr ? owner : "");
    L->ring = (uint8_t*)malloc((size_t)depth * maxLen);
    L->lens = (uint16_t*)malloc((size_t)depth * sizeof(uint16_t));
    if (L->ring == nullptr || L->lens == nullptr) {
        cleanupListenerLocked(*L);
        xSemaphoreGive(s_mux);
        return false;
    }
    xSemaphoreGive(s_mux);

    usb_transfer_t* x = nullptr;
    if (usb_host_transfer_alloc(maxLen, 0, &x) != ESP_OK || x == nullptr) {
        xSemaphoreTake(s_mux, portMAX_DELAY);
        cleanupListenerLocked(*L);
        xSemaphoreGive(s_mux);
        return false;
    }
    x->device_handle = hdl;
    x->bEndpointAddress = ep;
    x->num_bytes = maxLen;
    x->callback = listenCb;
    x->context = L;
    L->x = x;

    if (usb_host_transfer_submit(x) != ESP_OK) {
        usb_host_transfer_free(x);
        xSemaphoreTake(s_mux, portMAX_DELAY);
        cleanupListenerLocked(*L);
        xSemaphoreGive(s_mux);
        return false;
    }
    return true;
}

int read(uint8_t addr, uint8_t ep, uint8_t* out, size_t cap) {
    if (!s_inited || out == nullptr) return -1;
    int r = -1;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    Listener* L = nullptr;
    for (auto& l : s_listeners) {
        if (l.used && l.addr == addr && l.ep == ep) {
            L = &l;
            break;
        }
    }
    if (L == nullptr) {
        r = -1;
    } else if (L->count == 0) {
        r = 0;
    } else {
        const uint16_t n = L->lens[L->tail];
        if (n > cap) {
            r = -2;
        } else {
            memcpy(out, L->ring + (size_t)L->tail * L->len, n);
            L->tail = (uint8_t)((L->tail + 1) % L->depth);
            L->count--;
            r = (int)n;
        }
    }
    xSemaphoreGive(s_mux);
    return r;
}

bool unlisten(uint8_t addr, uint8_t ep) {
    if (!s_inited) return false;
    usb_device_handle_t hdl = nullptr;
    bool found = false;
    xSemaphoreTake(s_mux, portMAX_DELAY);
    for (auto& l : s_listeners) {
        if (l.used && l.addr == addr && l.ep == ep) {
            l.stopping = true;
            found = true;
            break;
        }
    }
    DevSlot* d = findDevLocked(addr);
    if (d != nullptr) hdl = d->hdl;
    xSemaphoreGive(s_mux);
    if (!found) return false;
    // Flush forca a conclusao do URB pendente (CANCELED) -> listenCb libera.
    if (hdl != nullptr) usb_host_endpoint_flush(hdl, ep);
    return true;
}

bool flush(uint8_t addr, uint8_t ep) {
    if (!s_inited) return false;
    usb_device_handle_t hdl = handleFor(addr);
    if (hdl == nullptr) return false;
    return usb_host_endpoint_flush(hdl, ep) == ESP_OK;
}

}  // namespace UsbHost

#endif  // CONFIG_CELEROS_USB_HOST
