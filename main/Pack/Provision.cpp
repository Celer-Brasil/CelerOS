#include "Provision.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "../Bluetooth/CelerLink.h"
#include "../Bluetooth/CelerNet.h"
#include "../Bluetooth/NetKeys.h"
#include "ProvProto.h"
#include "Resources.h"

namespace {

const char* TAG = "Provision";

constexpr uint32_t K_WINDOW_MS = 10 * 60 * 1000;  // janela de convite
constexpr uint32_t K_ACK_MS = 10 * 1000;          // convidador espera o ACK

volatile Provision::State s_state = Provision::IDLE;
uint32_t s_sinceMs = 0;

// Slot unico preenchido pelo tap (task do host NimBLE) e consumido pelo
// tick: o tap so copia e sinaliza — NVS e PSA ficam no tick.
provproto::Invite s_inv;
volatile bool s_invReady = false;
volatile bool s_ackReady = false;
volatile uint8_t s_ackStatus = 0;

uint32_t nowMs() {
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

void setState(Provision::State st) {
    s_state = st;
    s_sinceMs = nowMs();
}

// Task do host NimBLE: texto aberto do selo. Todo quadro "CNJ" e consumido
// (nunca chega ao pollSealed do app), mesmo fora de hora.
bool sealedTap(const uint8_t* data, size_t len) {
    if (!provproto::isProv(data, len)) return false;
    uint8_t st = 0;
    if (provproto::decodeAck(data, len, &st)) {
        if (s_state == Provision::SENT) {
            s_ackStatus = st;
            s_ackReady = true;
        }
        return true;
    }
    if (s_state != Provision::WAITING || s_invReady) return true;  // sem janela: ignora
    if (provproto::decodeInvite(data, len, &s_inv)) s_invReady = true;
    return true;
}

void netChangedAll() {
    CelerNet::netChanged();
    Resources::netChanged();
}

void sendAck(uint8_t status) {
    uint8_t b[provproto::ACK_LEN];
    const size_t n = provproto::encodeAck(status, b, sizeof(b));
    if (n == 0 || !CelerLink::sendSealed(b, n)) ESP_LOGW(TAG, "ACK do convite nao saiu");
}

}  // namespace

namespace Provision {

void init() {
    CelerLink::setSealedTap(sealedTap);
}

bool joinPassword(const char* name, const char* password) {
    if (!NetKeys::init()) return false;
    if (!NetKeys::join(name, password)) return false;
    netChangedAll();
    return true;
}

void leave() {
    NetKeys::init();
    NetKeys::leave();
    netChangedAll();
}

bool acceptInvite(bool on) {
    if (!on) {
        if (s_state == WAITING) setState(IDLE);
        s_invReady = false;
        return true;
    }
    if (!CelerLink::start(nullptr, true)) return false;  // nome da matilha + codigo
    s_invReady = false;
    setState(WAITING);
    ESP_LOGI(TAG, "janela de convite aberta (10 min)");
    return true;
}

bool invite() {
    if (!NetKeys::provisioned()) return false;
    CelerLink::Info li;
    CelerLink::info(&li);
    if (!li.connected || !li.verified) return false;
    const NetKeys::Net* n = NetKeys::primary();
    if (n == nullptr || n->open) return false;
    provproto::Invite iv;
    memset(&iv, 0, sizeof(iv));
    snprintf(iv.name, sizeof(iv.name), "%s", n->name);
    memcpy(iv.netKey, n->netKey, sizeof(iv.netKey));
    memcpy(iv.adminKey, n->adminKey, sizeof(iv.adminKey));
    uint8_t b[provproto::INVITE_MAX];
    const size_t len = provproto::encodeInvite(iv, b, sizeof(b));
    s_ackReady = false;
    setState(SENT);  // antes do envio: o ACK pode voltar antes do retorno
    // sendSealed exige bond (pareamento por codigo): sem ele nada sai
    const bool ok = len > 0 && CelerLink::sendSealed(b, len);
    memset(&iv, 0, sizeof(iv));
    memset(b, 0, sizeof(b));
    if (!ok) {
        setState(FAIL);
        return false;
    }
    ESP_LOGI(TAG, "convite da matilha \"%s\" enviado a %s", n->name, li.peer);
    return true;
}

void tick() {
    const uint32_t now = nowMs();
    switch (s_state) {
        case WAITING:
            if (s_invReady) {
                NetKeys::init();
                const bool ok = NetKeys::joinWithKeys(s_inv.name, s_inv.netKey, s_inv.adminKey);
                ESP_LOGI(TAG, "convite para \"%s\": %s", s_inv.name, ok ? "entrou" : "falhou");
                memset(&s_inv, 0, sizeof(s_inv));
                s_invReady = false;
                if (ok) netChangedAll();
                sendAck(ok ? provproto::ACK_OK : provproto::ACK_FAIL);
                setState(ok ? JOINED : FAIL);
            } else if (now - s_sinceMs > K_WINDOW_MS || !CelerLink::listening()) {
                setState(IDLE);  // prazo ou o app saiu (appReset derrubou o advertising)
            }
            break;
        case SENT:
            if (s_ackReady) {
                s_ackReady = false;
                setState(s_ackStatus == provproto::ACK_OK ? OK : FAIL);
                ESP_LOGI(TAG, "convidado respondeu: %s", s_state == OK ? "entrou" : "falhou");
            } else if (now - s_sinceMs > K_ACK_MS) {
                setState(FAIL);
            }
            break;
        default:
            break;
    }
}

State state() {
    return s_state;
}

const char* stateName(State s) {
    switch (s) {
        case WAITING: return "waiting";
        case JOINED: return "joined";
        case SENT: return "sent";
        case OK: return "ok";
        case FAIL: return "fail";
        default: return "idle";
    }
}

}  // namespace Provision
