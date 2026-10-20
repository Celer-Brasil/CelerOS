#ifndef CELEROS_PACK_REFLEX_H
#define CELEROS_PACK_REFLEX_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "ResProto.h"

// Reflexos da matilha (API 47, onda F-g do design): "se sensor X > Y entao
// atuador Z". A tabela (8 regras) mora no NVS do PROPRIO no e sobrevive a
// app fechado, troca de app, crash do JS e PC desligado.
//
// A regra fica no no do SENSOR (quem tem o dado decide); a acao pode ser:
//   ACT_WRITE  — nivel num atuador LOCAL (rele do perfil) ou REMOTO (sessao
//                do sistema no recurso do outro no, com auto-off): no
//                disparo liga/desliga; quando a condicao cai, desfaz.
//   ACT_NOTIFY — notificacao local ("escuro na sala").
// Sensor remoto NAO e subscrito na v1: registre a regra no no do sensor.
// O sensor "adc" exige pino ({"pin":N} no OPEN) e nao e avaliado por regra.
//
// A avaliacao roda a 1 Hz no tick do Resources (sem task nova): a leitura e
// local (SensorRes), a transicao tem histerese (h) e um cooldown por regra.
namespace reflex {

constexpr int MAX = 8;
constexpr uint8_t OP_GT = 1;  // valor >= limiar
constexpr uint8_t OP_LT = 2;  // valor <= limiar
constexpr uint8_t ACT_WRITE = 1;
constexpr uint8_t ACT_NOTIFY = 2;
constexpr uint32_t COOLDOWN_MS = 1000;
constexpr uint32_t OPEN_BACKOFF_MS = 5000;
constexpr size_t TEXT_MAX = 31;

struct Rule {
    bool used;
    uint8_t id;
    bool enabled;
    uint16_t sensorNode;  // 0 = sensor local (v1 so avalia local)
    char sensor[resproto::RES_NAME_MAX + 1];
    uint8_t op;           // OP_GT / OP_LT
    float value;
    float hyst;           // histerese do re-arme
    uint8_t action;       // ACT_WRITE / ACT_NOTIFY
    uint16_t targetNode;  // ACT_WRITE: 0 = alvo local
    char target[resproto::RES_NAME_MAX + 1];
    bool on;              // ACT_WRITE: nivel aplicado quando a condicao vale
    char text[TEXT_MAX + 1];  // ACT_NOTIFY
    // estado de avaliacao (nao persiste)
    bool armed;
    uint32_t lastMs;
    int8_t handle;        // ACT_WRITE remota: handle da sessao do sistema
    bool wantOn;          // nivel desejado (aplicado quando a sessao abre)
    bool written;         // nivel ja escrito no handle aberto
    uint32_t lastTryMs;   // backoff do OPEN remoto
};

enum EvalResult : uint8_t { EV_NONE = 0, EV_ON = 1, EV_OFF = 2 };

// Transicao da condicao com histerese e cooldown: EV_ON quando o valor cruza
// para o lado verdadeiro, EV_OFF quando volta ao outro lado (+/- hyst). O
// chamador aplica a acao. Puro (test/cpp exercita).
inline uint8_t evaluate(Rule* r, float v, uint32_t nowMs, uint32_t cooldownMs = COOLDOWN_MS) {
    if (r->lastMs != 0 && nowMs - r->lastMs < cooldownMs) return EV_NONE;
    const bool cond = r->op == OP_GT ? v >= r->value : v <= r->value;
    if (cond && r->armed) {
        r->armed = false;
        r->lastMs = nowMs;
        return EV_ON;
    }
    if (!cond && !r->armed) {
        // re-arma so depois de voltar ao outro lado do limiar + histerese
        const bool back = r->op == OP_GT ? v <= r->value - r->hyst : v >= r->value + r->hyst;
        if (!back) return EV_NONE;
        r->armed = true;
        r->lastMs = nowMs;
        return EV_OFF;
    }
    return EV_NONE;
}

// Forma persistida (NVS blob): enxuta e estavel entre boots. Campos de
// runtime (handle/armed/...) nao viajam.
struct Wire {
    uint8_t id;
    uint8_t enabled;
    uint8_t op;
    uint8_t action;
    uint8_t on;
    uint8_t pad[3];
    uint16_t sensorNode;
    uint16_t targetNode;
    float value;
    float hyst;
    char sensor[16];
    char target[16];
    char text[TEXT_MAX + 1];
};
static_assert(sizeof(Wire) <= 96, "Wire do reflexo: mantenha o blob do NVS enxuto");

inline void ruleToWire(const Rule& r, Wire* w) {
    memset(w, 0, sizeof(*w));
    w->id = r.id;
    w->enabled = r.enabled ? 1 : 0;
    w->op = r.op;
    w->action = r.action;
    w->on = r.on ? 1 : 0;
    w->sensorNode = r.sensorNode;
    w->targetNode = r.targetNode;
    w->value = r.value;
    w->hyst = r.hyst;
    snprintf(w->sensor, sizeof(w->sensor), "%s", r.sensor);
    snprintf(w->target, sizeof(w->target), "%s", r.target);
    snprintf(w->text, sizeof(w->text), "%s", r.text);
}

inline void wireToRule(const Wire& w, Rule* r) {
    memset(r, 0, sizeof(*r));
    r->used = true;
    r->id = w.id;
    r->enabled = w.enabled != 0;
    r->op = w.op;
    r->action = w.action;
    r->on = w.on != 0;
    r->sensorNode = w.sensorNode;
    r->targetNode = w.targetNode;
    r->value = w.value;
    r->hyst = w.hyst;
    snprintf(r->sensor, sizeof(r->sensor), "%s", w.sensor);
    snprintf(r->target, sizeof(r->target), "%s", w.target);
    snprintf(r->text, sizeof(r->text), "%s", w.text);
    r->armed = true;   // primeira avaliacao com a condicao verdadeira dispara
    r->handle = -1;
}

// ---- firmware (Reflex.cpp; nao usado no host) ----
void init();   // carrega a tabela do NVS (Resources::init)
void tick();   // avaliacao 1 Hz (tickTimers do Resources)

// Registra uma regra: devolve o id (1..255) ou -1 (tabela cheia/invalida).
// notifyText != nullptr -> ACT_NOTIFY; senao ACT_WRITE no alvo
// (targetNode 0 = rele local do perfil).
int add(uint8_t op, float value, float hyst, const char* sensor, uint16_t targetNode,
        const char* target, bool on, const char* notifyText);
bool del(int id);
int list(Rule* out, int max);

// Shell "svc reflex ..." (list/add/del).
typedef void (*PrintFn)(void* ctx, const char* fmt, ...);
int cmd(int argc, char** argv, PrintFn print, void* ctx);

}  // namespace reflex

#endif  // CELEROS_PACK_REFLEX_H
