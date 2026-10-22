#pragma once

// ============================================================================
// USB Host (API 48) — core generico em C++
//
// Nenhum driver de dispositivo mora aqui: o modulo entrega ao JS o que o
// hardware expoe (devices/descritores, claim de interface, transfers
// control/bulk/interrupt, IN continuo e envio de arquivo). Quem sabe o que
// e uma impressora ESC/POS ou um report HID e a dep JS.
//
// Fora do CONFIG_CELEROS_USB_HOST tudo vira no-op (as fontes so entram no
// build com a flag; main.cpp chama init() sem #if).
// ============================================================================

#include "sdkconfig.h"

#include <stddef.h>
#include <stdint.h>

#include "UsbDesc.h"

namespace UsbHost {

// Teto de uma transferencia pedida pelo JS (array de bytes). Maior que isso
// so por sendFile (streaming de arquivo em chunks internos).
constexpr size_t kMaxTransfer = 4096;
// Teto do buffer de controle do IDF (CONFIG_USB_HOST_CONTROL_TRANSFER_MAX_SIZE
// menos o setup packet de 8 bytes). Limitado de novo no init.
constexpr size_t kMaxControl = 2040;
// Teto de um job de sendFile.
constexpr size_t kMaxFileJob = 512 * 1024;
// Teto de um listener de endpoint IN (tamanho de um report/registro).
constexpr uint16_t kMaxListenLen = 256;

enum EventType : uint8_t {
    kEventAdd = 1,
    kEventRemove = 2,
};

struct Event {
    uint8_t type = 0;
    uint8_t addr = 0;
    uint16_t vid = 0;
    uint16_t pid = 0;
};

struct Result {
    bool ok = false;
    const char* status = "error";
    size_t transferred = 0;
};

struct Claim {
    uint8_t iface = 0;
    char owner[32] = {0};
};

// Snapshot de um device (copiado do registry sob lock).
struct DeviceInfo {
    uint8_t addr = 0;
    uint16_t vid = 0;
    uint16_t pid = 0;
    uint8_t cls = 0;
    uint8_t subcls = 0;
    uint8_t proto = 0;
    uint8_t speed = 0;
    uint8_t nClaims = 0;
    Claim claims[usbdesc::kMaxIfaces];
    usbdesc::DevDesc desc;  // interfaces + endpoints da config ativa
};

#if CONFIG_CELEROS_USB_HOST

void init();
bool available();

int deviceCount();
bool deviceAt(int index, DeviceInfo& out);
bool deviceByAddr(uint8_t addr, DeviceInfo& out);

// Fila de hotplug (add/remove). Devolve false quando vazia.
bool pollEvent(Event& out);

Result controlIn(uint8_t addr, uint8_t bmRequestType, uint8_t bRequest,
                 uint16_t wValue, uint16_t wIndex, uint8_t* buf, size_t len,
                 uint32_t timeoutMs);
Result controlOut(uint8_t addr, uint8_t bmRequestType, uint8_t bRequest,
                  uint16_t wValue, uint16_t wIndex, const uint8_t* data, size_t len,
                  uint32_t timeoutMs);
Result out(uint8_t addr, uint8_t ep, const uint8_t* data, size_t len, uint32_t timeoutMs);
Result in(uint8_t addr, uint8_t ep, uint8_t* buf, size_t cap, uint32_t timeoutMs);
Result sendFile(uint8_t addr, uint8_t ep, const char* path, size_t maxBytes,
                uint32_t timeoutMs);

bool claim(const char* owner, uint8_t addr, uint8_t iface, uint8_t alt);
bool release(const char* owner, uint8_t addr, uint8_t iface);
void releaseOwner(const char* owner);

bool listen(const char* owner, uint8_t addr, uint8_t ep, uint16_t maxLen, uint8_t depth);
// >0 = bytes copiados; 0 = fila vazia; -1 = sem listener; -2 = buffer curto.
int read(uint8_t addr, uint8_t ep, uint8_t* out, size_t cap);
bool unlisten(uint8_t addr, uint8_t ep);

bool flush(uint8_t addr, uint8_t ep);

#else  // !CONFIG_CELEROS_USB_HOST

inline void init() {}
inline bool available() { return false; }
inline int deviceCount() { return 0; }
inline bool deviceAt(int, DeviceInfo&) { return false; }
inline bool deviceByAddr(uint8_t, DeviceInfo&) { return false; }
inline bool pollEvent(Event&) { return false; }
inline Result controlIn(uint8_t, uint8_t, uint8_t, uint16_t, uint16_t, uint8_t*, size_t,
                        uint32_t) { return Result{}; }
inline Result controlOut(uint8_t, uint8_t, uint8_t, uint16_t, uint16_t, const uint8_t*,
                         size_t, uint32_t) { return Result{}; }
inline Result out(uint8_t, uint8_t, const uint8_t*, size_t, uint32_t) { return Result{}; }
inline Result in(uint8_t, uint8_t, uint8_t*, size_t, uint32_t) { return Result{}; }
inline Result sendFile(uint8_t, uint8_t, const char*, size_t, uint32_t) { return Result{}; }
inline bool claim(const char*, uint8_t, uint8_t, uint8_t) { return false; }
inline bool release(const char*, uint8_t, uint8_t) { return false; }
inline void releaseOwner(const char*) {}
inline bool listen(const char*, uint8_t, uint8_t, uint16_t, uint8_t) { return false; }
inline int read(uint8_t, uint8_t, uint8_t*, size_t) { return -1; }
inline bool unlisten(uint8_t, uint8_t) { return false; }
inline bool flush(uint8_t, uint8_t) { return false; }

#endif  // CONFIG_CELEROS_USB_HOST

}  // namespace UsbHost
