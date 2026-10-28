#include "Provision.h"

#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "../Bluetooth/CelerLink.h"
#include "../Bluetooth/CelerNet.h"
#include "../Bluetooth/NetKeys.h"
#include "PackId.h"
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
                // Copia o slot e so DEPOIS solta s_invReady: o tap (task do
                // NimBLE) so escreve com a flag falsa, entao o joinWithKeys
                // nunca roda sobre chaves sobrescritas no meio (rede errada)
                provproto::Invite iv = s_inv;
                memset(&s_inv, 0, sizeof(s_inv));
                s_invReady = false;
                NetKeys::init();
                const bool ok = NetKeys::joinWithKeys(iv.name, iv.netKey, iv.adminKey);
                ESP_LOGI(TAG, "convite para \"%s\": %s", iv.name, ok ? "entrou" : "falhou");
                memset(&iv, 0, sizeof(iv));
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

bool sendAndWait() {
    bool ok = invite();
    if (ok) {
        // o ACK chega pelo tap e o tick do Pack muda o estado (outra task)
        const uint32_t t0 = nowMs();
        while (s_state == SENT && nowMs() - t0 < K_ACK_MS + 500) vTaskDelay(pdMS_TO_TICKS(50));
        ok = s_state == OK;
    }
    CelerLink::disconnect();
    return ok;
}

bool inviteConnect(const char* target, bool* done) {
    if (done != nullptr) *done = false;
    if (target == nullptr || target[0] == '\0' || !NetKeys::provisioned()) return false;
    // O anuncio conectavel do novo divide o radio com os bursts da malha:
    // um scan de 3 s as vezes nao o pega (bancada 2026-10-16) — ate 3 varreduras
    CelerLink::Peer peers[8];
    int n = 0;
    const char* id = nullptr;
    for (int tent = 0; tent < 3 && id == nullptr; tent++) {
        n = CelerLink::scan(3000, peers, 8);
        for (int i = 0; i < n && id == nullptr; i++) {
            char hex[5];
            snprintf(hex, sizeof(hex), "%04X", packid::nodeFromLinkId(peers[i].id));
            if (strcasecmp(peers[i].name, target) == 0 || strcasecmp(peers[i].id, target) == 0 ||
                strcasecmp(hex, target) == 0) {
                id = peers[i].id;
            }
        }
    }
    if (id == nullptr) {
        ESP_LOGW(TAG, "convite: \"%s\" fora do scan (%d anuncios; janela aberta la?)", target, n);
        return false;
    }
    if (!CelerLink::connect(id, 6000)) {
        ESP_LOGW(TAG, "convite: conexao com %s falhou", id);
        return false;
    }
    CelerLink::Info li;
    CelerLink::info(&li);
    if (li.verified) {
        // bond de um pareamento anterior: sem codigo, a chave vai agora
        ESP_LOGI(TAG, "convite: %s ja pareado (bond), mandando a chave", id);
        if (done != nullptr) *done = true;
        return sendAndWait();
    }
    ESP_LOGI(TAG, "convite: conectado a %s, aguardando o codigo", id);
    return true;
}

bool inviteCode(const char* code) {
    if (code == nullptr || strlen(code) != 6) return false;
    if (!CelerLink::verify(code)) {
        ESP_LOGW(TAG, "convite: codigo recusado");
        CelerLink::disconnect();
        return false;
    }
    return sendAndWait();
}

void pendingCode(char out[7]) {
    out[0] = '\0';
    if (s_state != WAITING) return;
    CelerLink::Info li;
    CelerLink::info(&li);
    if (li.pairing) snprintf(out, 7, "%s", li.code);
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
