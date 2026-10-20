#include "Reflex.h"

#include <math.h>
#include <stdlib.h>
#include <strings.h>

#include "esp_log.h"
#include "nvs.h"

#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"
#include "../Kernel/Notifications.h"
#include "Resources.h"
#include "SensorRes.h"

// Reflexos nativos (API 47): tabela de regras no NVS do no, avaliada a 1 Hz
// no tick do Resources. As acoes usam os caminhos ja existentes: rele local
// por BoardIO (com localClaim, o uso local ganha) e atuador remoto por uma
// sessao do sistema no proprio cliente de recursos (auto-off no params).

namespace reflex {
namespace {

const char* TAG = "celer.reflex";
const char* NVS_NS = "reflex";

Rule s_r[MAX];
bool s_inited = false;

uint32_t nowMs() { return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS); }

int freeSlot() {
    for (int i = 0; i < MAX; i++) {
        if (!s_r[i].used) return i;
    }
    return -1;
}

void saveSlot(int i) {
    char key[4] = {'r', (char)('0' + i), '\0', '\0'};
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    if (s_r[i].used) {
        Wire w;
        ruleToWire(s_r[i], &w);
        nvs_set_blob(h, key, &w, sizeof(w));
    } else {
        nvs_erase_key(h, key);
    }
    nvs_commit(h);
    nvs_close(h);
}

void load() {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    for (int i = 0; i < MAX; i++) {
        char key[4] = {'r', (char)('0' + i), '\0', '\0'};
        Wire w;
        size_t len = sizeof(w);
        if (nvs_get_blob(h, key, &w, &len) != ESP_OK || len != sizeof(w)) continue;
        wireToRule(w, &s_r[i]);
    }
    nvs_close(h);
}

void applyLocal(Rule& r, bool on) {
    if (strncasecmp(r.target, "rele", 4) != 0) {
        ESP_LOGW(TAG, "regra %u: alvo local \"%s\" nao suportado (so releN)", r.id, r.target);
        return;
    }
    const int n = atoi(r.target + 4);
    if (n < 1 || n > Board::profile().relay.count) {
        ESP_LOGW(TAG, "regra %u: %s nao existe nesta placa", r.id, r.target);
        return;
    }
    Resources::localClaim(resproto::TYPE_GPIO);  // o uso local sempre ganha
    BoardIO::setRelay(n, on);
    ESP_LOGI(TAG, "regra %u: %s %s (local)", r.id, r.target, on ? "on" : "off");
}

// Maquina do alvo remoto: abre a sessao com auto-off, escreve o nivel quando
// o ACCEPT chega e fecha quando a condicao cai (desfazendo). Backoff de 5 s
// quando o dono recusa/esta offline — nao martela a malha.
void serviceRemote(Rule& r, uint32_t now) {
    if (!r.wantOn) {
        if (r.handle >= 0) {
            Resources::HandleInfo hi;
            if (Resources::info(r.handle, &hi) && hi.state == Resources::ST_OPEN) {
                const uint8_t b[2] = {resproto::GPIO_WRITE, 0};
                Resources::write(r.handle, b, 2);
            }
            Resources::close(r.handle);
            r.handle = -1;
            r.written = false;
            ESP_LOGI(TAG, "regra %u: %04X/%s off (remota)", r.id, r.targetNode, r.target);
        }
        return;
    }
    if (r.handle < 0) {
        if (r.lastTryMs != 0 && now - r.lastTryMs < OPEN_BACKOFF_MS) return;
        r.lastTryMs = now;
        r.handle = (int8_t)Resources::open(r.targetNode, r.target,
                                           (const uint8_t*)"{\"off\":1}", 9);
        r.written = false;
        return;
    }
    Resources::HandleInfo hi;
    if (!Resources::info(r.handle, &hi)) {
        r.handle = -1;
        return;
    }
    if (hi.state == Resources::ST_OPEN) {
        if (!r.written) {
            const uint8_t b[2] = {resproto::GPIO_WRITE, 1};
            Resources::write(r.handle, b, 2);
            r.written = true;
            ESP_LOGI(TAG, "regra %u: %04X/%s on (remota)", r.id, r.targetNode, r.target);
        }
    } else if (hi.state != Resources::ST_OPENING) {
        // refused/lost/closed: reabre com backoff no proximo giro
        r.handle = -1;
        r.written = false;
        r.lastTryMs = now;
    }
}

void apply(Rule& r, bool on) {
    if (r.action == ACT_NOTIFY) {
        if (on) {
            ESP_LOGI(TAG, "regra %u: %s", r.id, r.text);
            Notifications::push(r.text, std::string("reflexo: ") + r.sensor, "reflexo",
                                0x52454600u + r.id);
        }
        return;
    }
    if (r.targetNode == 0) {
        applyLocal(r, on);
        return;
    }
    r.wantOn = on;
    serviceRemote(r, nowMs());
}

}  // namespace

void init() {
    if (s_inited) return;
    s_inited = true;
    for (int i = 0; i < MAX; i++) {
        s_r[i] = Rule{};
        s_r[i].handle = -1;
    }
    load();
    int n = 0;
    for (int i = 0; i < MAX; i++) n += s_r[i].used ? 1 : 0;
    ESP_LOGI(TAG, "%d regra(s) carregada(s) do NVS", n);
}

void tick() {
    if (!s_inited) return;
    static uint32_t s_last = 0;
    const uint32_t now = nowMs();
    if (s_last != 0 && now - s_last < 1000) return;
    s_last = now;
    for (int i = 0; i < MAX; i++) {
        Rule& r = s_r[i];
        if (!r.used || !r.enabled) continue;
        if (r.action == ACT_WRITE && r.targetNode != 0) serviceRemote(r, now);
        if (r.sensorNode != 0) continue;  // v1: a regra mora no no do sensor
        if (strcasecmp(r.sensor, "adc") == 0) continue;  // exige pino no OPEN
        const int idx = SensorRes::indexOf(r.sensor);
        if (idx < 0 || !SensorRes::available(idx)) continue;
        uint8_t p[8];
        if (SensorRes::sampleOnce(idx, p) <= 0) continue;
        float v;
        memcpy(&v, p + 4, 4);
        const uint8_t ev = evaluate(&r, v, now);
        if (ev == EV_NONE) continue;
        ESP_LOGI(TAG, "regra %u: %s %s %.2f (h%.2f) -> %s", r.id, r.sensor,
                 r.op == OP_GT ? ">=" : "<=", (double)r.value, (double)r.hyst,
                 ev == EV_ON ? "acao" : "desfaz");
        apply(r, ev == EV_ON);
    }
}

int add(uint8_t op, float value, float hyst, const char* sensor, uint16_t targetNode,
        const char* target, bool on, const char* notifyText) {
    if (!s_inited) init();
    if (sensor == nullptr || sensor[0] == '\0' || (op != OP_GT && op != OP_LT)) return -1;
    if (!isfinite(value)) return -1;
    if (!isfinite(hyst) || hyst < 0.0f) hyst = 0.0f;
    const bool notify = notifyText != nullptr;
    if (!notify && (target == nullptr || target[0] == '\0')) return -1;
    if (SensorRes::indexOf(sensor) < 0) return -1;
    const int i = freeSlot();
    if (i < 0) return -1;
    // id novo (menor livre 1..255); recicla quando enche
    bool taken[256] = {false};
    for (int k = 0; k < MAX; k++) taken[s_r[k].used ? s_r[k].id : 0] = true;
    uint8_t id = 1;
    while (id != 0 && taken[id]) id++;
    if (id == 0) return -1;
    Rule& r = s_r[i];
    r = Rule{};
    r.used = true;
    r.id = id;
    r.enabled = true;
    r.op = op;
    r.value = value;
    r.hyst = hyst;
    r.action = notify ? ACT_NOTIFY : ACT_WRITE;
    r.targetNode = notify ? 0 : targetNode;
    r.on = on;
    r.armed = true;
    r.handle = -1;
    snprintf(r.sensor, sizeof(r.sensor), "%s", sensor);
    if (!notify) snprintf(r.target, sizeof(r.target), "%s", target);
    if (notify) snprintf(r.text, sizeof(r.text), "%s", notifyText);
    saveSlot(i);
    ESP_LOGI(TAG, "regra %u criada: %s %s %.2f -> %s", r.id, r.sensor,
             op == OP_GT ? ">=" : "<=", (double)r.value,
             notify ? "notify" : (targetNode == 0 ? target : "remota"));
    return r.id;
}

bool del(int id) {
    for (int i = 0; i < MAX; i++) {
        if (!s_r[i].used || s_r[i].id != id) continue;
        if (s_r[i].handle >= 0) {
            Resources::close(s_r[i].handle);
            s_r[i].handle = -1;
        }
        s_r[i] = Rule{};
        s_r[i].handle = -1;
        saveSlot(i);
        ESP_LOGI(TAG, "regra %d removida", id);
        return true;
    }
    return false;
}

int list(Rule* out, int max) {
    int n = 0;
    for (int i = 0; i < MAX; i++) {
        if (!s_r[i].used) continue;
        if (out != nullptr && n < max) out[n] = s_r[i];
        n++;
    }
    return n < max ? n : max;
}

int cmd(int argc, char** argv, PrintFn print, void* ctx) {
    if (argc == 0 || strcmp(argv[0], "ls") == 0) {
        int n = 0;
        for (int i = 0; i < MAX; i++) {
            const Rule& r = s_r[i];
            if (!r.used) continue;
            n++;
            char alvo[40];
            if (r.action == ACT_NOTIFY) {
                snprintf(alvo, sizeof(alvo), "notify \"%s\"", r.text);
            } else if (r.targetNode == 0) {
                snprintf(alvo, sizeof(alvo), "local %s %s", r.target, r.on ? "on" : "off");
            } else {
                snprintf(alvo, sizeof(alvo), "%04X %s %s", r.targetNode, r.target, r.on ? "on" : "off");
            }
            print(ctx, "  %u  %-6s %s %-7.2f h%.2f  -> %s\r\n", r.id, r.sensor,
                  r.op == OP_GT ? ">=" : "<=", (double)r.value, (double)r.hyst, alvo);
        }
        if (n == 0) print(ctx, "reflex: nenhuma regra\r\n");
        return 0;
    }
    if (argc >= 8 && strcmp(argv[0], "add") == 0) {
        // add <sensor> <gt|lt> <valor> <h> <no|local> <alvo> <on|off>
        const uint8_t op = strcasecmp(argv[2], "lt") == 0 ? OP_LT : OP_GT;
        const float value = (float)atof(argv[3]);
        const float hyst = (float)atof(argv[4]);
        uint16_t node = 0;
        if (strcasecmp(argv[5], "local") != 0 && !Resources::resolve(argv[5], &node)) {
            print(ctx, "add: no \"%s\" nao encontrado (use local ou o id A1B2)\r\n", argv[5]);
            return 1;
        }
        const bool on = strcasecmp(argv[7], "off") != 0 && strcmp(argv[7], "0") != 0;
        const int id = add(op, value, hyst, argv[1], node, argv[6], on, nullptr);
        print(ctx, "add: %s\r\n", id > 0 ? "ok" : "falhou (tabela cheia/sensor invalido)");
        return id > 0 ? 0 : 1;
    }
    if (argc >= 6 && strcmp(argv[0], "notify") == 0) {
        // notify <sensor> <gt|lt> <valor> <h> <texto...>
        const uint8_t op = strcasecmp(argv[2], "lt") == 0 ? OP_LT : OP_GT;
        const float value = (float)atof(argv[3]);
        const float hyst = (float)atof(argv[4]);
        char text[reflex::TEXT_MAX + 1] = {0};
        size_t used = 0;
        for (int i = 5; i < argc && used < sizeof(text) - 1; i++) {
            const int w = snprintf(text + used, sizeof(text) - used, "%s%s", i > 5 ? " " : "",
                                   argv[i]);
            if (w <= 0) break;
            used += (size_t)w;
        }
        const int id = add(op, value, hyst, argv[1], 0, nullptr, true, text);
        print(ctx, "notify: %s\r\n", id > 0 ? "ok" : "falhou (tabela cheia/sensor invalido)");
        return id > 0 ? 0 : 1;
    }
    if (argc >= 2 && strcmp(argv[0], "del") == 0) {
        print(ctx, "del: %s\r\n", del(atoi(argv[1])) ? "ok" : "id desconhecido");
        return 0;
    }
    print(ctx, "uso: svc reflex ls | add <sensor> <gt|lt> <valor> <h> <no|local> <alvo> <on|off>"
               " | notify <sensor> <gt|lt> <valor> <h> <texto> | del <id>\r\n");
    return 1;
}

}  // namespace reflex
