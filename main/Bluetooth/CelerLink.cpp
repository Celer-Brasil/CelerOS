#include "CelerLink.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_bt.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "psa/crypto.h"

#include "CelerNet.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_att.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_adv.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_uuid.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "sdkconfig.h"
#if CONFIG_CELEROS_PHONE_LINK
#include "PhoneLink.h"
#include "host/ble_sm.h"
extern "C" void ble_store_config_init(void);
#endif

// Servico "Celer Link v1": um servico primario UUID128 com UMA
// caracteristica de mensagens (write + write-no-rsp + notify). Quem e
// client escreve nela; quem e server notifica. O peer conectado e unico
// (CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1).
//
//   servico: b3a667a2-fdac-5298-8c13-89c980f2d1f1
//   char:    b3a667a2-fdac-5298-8c13-89c980f2d1f2  (mensagens)
//   pair:    b3a667a2-fdac-5298-8c13-89c980f2d1f3  (pareamento, API 11)
//
// A char "pair" e opcional e fica DEPOIS da de mensagens (os handles das
// antigas nao mudam): READ devolve 1 byte (0x00 link aberto, 0x01
// aguardando codigo, 0x02 verificado) e WRITE recebe os 6 digitos. Central
// antigo nao a descobre e funciona como antes; peripheral antigo nao a tem
// e o central novo conecta verificado.
//
// Concorrencia: os callbacks rodam na task do host NimBLE; a API roda na
// task do app. Os procedimentos longos (connect/scan) sao dirigidos pela
// task do app, passo a passo, sincronizados por bits de um event group —
// o callback so registra o resultado e sinaliza.

namespace {

const char* TAG = "celer.link";

// Motivo de terminate (HCI 0x13 = Remote User Terminated Connection);
// o header do NimBLE nao exporta a constante para o app.
constexpr uint8_t K_CONN_TERM = 0x13;

// MTU ATT default (antes da troca) e o pedido (sdkconfig: 256).
constexpr uint16_t K_MTU_DEFAULT = 23;
constexpr uint16_t K_MTU_WANT = 256;
// RAM interna minima para subir o BLE. Medido no 4848 (host NimBLE na
// PSRAM): o init consome ~38 KB de RAM interna (controller + coexistencia).
// O piso e o consumo medido, nao uma margem: abaixo dele o init falharia de
// qualquer jeito (com assert); acima, decide o proprio NimBLE
constexpr size_t K_BLE_MIN_INTERNAL = 38 * 1024;
constexpr size_t K_BLE_MIN_BLOCK = 8 * 1024;

// Parametros de conexao do central: intervalo 15..30 ms (resposta de
// controle remoto) e supervision timeout de 2 s (queda detectada rapido,
// ainda tolerante ao time-slicing do coexist com o WiFi).
constexpr uint16_t K_ITVL_MIN = 12;       // x 1.25 ms
constexpr uint16_t K_ITVL_MAX = 24;       // x 1.25 ms
constexpr uint16_t K_SUPERVISION = 200;   // x 10 ms

// Prazo para o evento de desconexao chegar depois do terminate.
constexpr uint32_t K_DISC_WAIT_MS = 1500;
// Prazo de reenvio quando o host esta sem buffers (mbuf/ACL).
constexpr uint32_t K_SEND_RETRY_MS = 120;

const ble_uuid128_t kSvcUuid = BLE_UUID128_INIT(0xf1, 0xd1, 0xf2, 0x80, 0xc9, 0x89, 0x13, 0x8c,
                                                0x98, 0x52, 0xac, 0xfd, 0xa2, 0x67, 0xa6, 0xb3);
const ble_uuid128_t kChrUuid = BLE_UUID128_INIT(0xf2, 0xd1, 0xf2, 0x80, 0xc9, 0x89, 0x13, 0x8c,
                                                0x98, 0x52, 0xac, 0xfd, 0xa2, 0x67, 0xa6, 0xb3);
const ble_uuid128_t kPairUuid = BLE_UUID128_INIT(0xf3, 0xd1, 0xf2, 0x80, 0xc9, 0x89, 0x13, 0x8c,
                                                 0x98, 0x52, 0xac, 0xfd, 0xa2, 0x67, 0xa6, 0xb3);

// Pareamento (API 11): estado da char "pair" e regras da porta.
constexpr uint8_t K_PAIR_OFF = 0x00;   // link aberto (sem pareamento)
constexpr uint8_t K_PAIR_WAIT = 0x01;  // aguardando o codigo
constexpr uint8_t K_PAIR_OK = 0x02;    // verificado
constexpr int K_PAIR_MAX_FAILS = 3;            // erros antes de derrubar
constexpr uint32_t K_PAIR_TIMEOUT_MS = 60000;  // sem digitar = derruba
constexpr uint32_t K_VERIFY_MS = 3000;         // orcamento do verify()
constexpr uint32_t K_BOND_GRACE_MS = 3000;     // peer com bond: prazo p/ responder o desafio
// Bonds no NVS: ate K_BOND_MAX MACs, mais recente primeiro (LRU).
constexpr int K_BOND_MAX = 4;
const char* K_NVS_NS = "celer";
const char* K_NVS_BONDS = "link_bonds2";   // {mac[6], chave[16]} por peer
const char* K_NVS_BONDS_V1 = "link_bonds";  // v1: so MAC (falsificavel) — apagado
constexpr size_t K_BOND_KEY = 16;
constexpr size_t K_CHAL = 8;               // desafio por conexao (periferico)
struct Bond {
    uint8_t mac[6];
    uint8_t key[K_BOND_KEY];
};

struct Msg {
    uint16_t len;
    uint8_t data[CelerLink::MAX_MSG];
};

constexpr int K_SCAN_CACHE = 16;
struct ScanEntry {
    uint8_t addr[6];  // crua do ble_addr (little-endian)
    uint8_t addrType;
    char name[CelerLink::MAX_NAME + 1];
    int8_t rssi;
};

// Bits do event group de progresso dos procedimentos.
constexpr EventBits_t EV_CONN = 1 << 0;   // conexao estabelecida
constexpr EventBits_t EV_FAIL = 1 << 1;   // procedimento/conexao falhou
constexpr EventBits_t EV_CHR = 1 << 2;    // descoberta da caracteristica terminou
constexpr EventBits_t EV_SCAN = 1 << 3;   // scan terminou
constexpr EventBits_t EV_MTU = 1 << 4;    // troca de MTU terminou (ok ou nao)
constexpr EventBits_t EV_SUB = 1 << 5;    // escrita do CCCD confirmada
constexpr EventBits_t EV_DISC = 1 << 6;   // conexao caiu/encerrada
constexpr EventBits_t EV_PCHR = 1 << 7;   // descoberta da char de pareamento
constexpr EventBits_t EV_PAIRW = 1 << 8;  // escrita do codigo confirmada
constexpr EventBits_t EV_PAIRR = 1 << 9;  // leitura do estado confirmada

bool s_started = false;
bool s_initFail = false;
SemaphoreHandle_t s_syncSem = nullptr;
EventGroupHandle_t s_evt = nullptr;
QueueHandle_t s_rxQueue = nullptr;
QueueHandle_t s_sealedQueue = nullptr;  // mensagens seladas que autenticaram
Msg s_rxScratch;  // so a task do host usa (pushRx)
Msg s_sealScratch;  // idem (abertura do selo)

// Quadro selado: 00 'S' 01 | nonce(12) | AES-128-GCM(texto) | tag(16).
// O cabecalho e o AAD; JSON nunca comeca com 0x00, entao o quadro nao se
// confunde com mensagem comum.
constexpr uint8_t K_SEAL_HDR[3] = {0x00, 'S', 0x01};
constexpr size_t K_SEAL_NONCE = 12;
constexpr size_t K_SEAL_TAG = 16;
constexpr int K_SEALED_DEPTH = 2;

uint16_t s_chrValHandle = 0;  // handle da nossa caracteristica (GATT preenche)
uint16_t s_pairValHandle = 0;  // handle da nossa char de pareamento

volatile uint16_t s_conn = 0;         // handle da conexao (valido com s_connActive)
volatile bool s_connActive = false;   // enlace de pe
volatile bool s_ready = false;        // pronto para send()/connected()
volatile bool s_isCentral = false;    // nos conectamos no peer
volatile bool s_connecting = false;   // connect() em andamento (central)
volatile bool s_appScanning = false;  // scan() do app em andamento (scanner dele)
volatile bool s_peerSubscribed = false;  // central inscrito no nosso notify
volatile uint16_t s_mtu = 0;
volatile uint32_t s_rxDropped = 0;
uint16_t s_peerChrVal = 0;
uint16_t s_peerPairVal = 0;            // char "pair" do peer (0 = peer v1)
volatile uint8_t s_peerPairState = K_PAIR_OFF;  // ultimo estado lido (central)
uint8_t s_peerAddr[6] = {0};
volatile bool s_wantAdvertise = false;
// Phone Link (Gadgetbridge): o advertising no ar e o do celular e a
// conexao corrente veio dele — os eventos vao para o PhoneLink e o canal
// do Celer Link segue "desconectado" para os apps.
volatile bool s_advPhone = false;
volatile bool s_phoneConn = false;
char s_advName[CelerLink::MAX_NAME + 1] = {0};

// Pareamento: s_pairVerified fecha/abre o canal de dados (default true —
// so fica false durante o handshake). O codigo nasce no evento CONNECT do
// periférico e e regerado a cada conexao; quem o ve e so o app LOCAL
// (status().code) — ele nunca e anunciado nem notificado.
volatile bool s_pairRequired = false;  // app pediu pareamento via start()
volatile bool s_pairPending = false;   // conexao ativa aguardando codigo
volatile bool s_pairVerified = true;   // canal autorizado
char s_pairCode[7] = {0};
uint8_t s_challenge[K_CHAL] = {0};      // periferico: desafio desta conexao
uint8_t s_peerChallenge[K_CHAL] = {0};  // central: desafio lido do peer
volatile bool s_peerHasChallenge = false;  // peer v2 (le 1+8 bytes)
uint8_t s_pairFails = 0;
TickType_t s_pairDeadline = 0;

ScanEntry s_scanCache[K_SCAN_CACHE];
volatile int s_scanCount = 0;

// ------------------------------------------------------------------ varios

// ble_addr.val vem little-endian; o id exibido e big-endian (como o
// nRF Connect e o propio formato "AA:BB:..." mostram).
void formatAddr(const uint8_t val[6], char* out) {
    snprintf(out, 18, "%02X:%02X:%02X:%02X:%02X:%02X", val[5], val[4], val[3], val[2], val[1], val[0]);
}

// Espera bits do event group alimentando o watchdog: scan/connect bloqueiam
// a task do app (main ou celerapp) por segundos. Devolve os bits que
// chegaram (e os consome); 0 = prazo esgotado.
EventBits_t waitBits(EventBits_t bits, TickType_t deadline) {
    for (;;) {
        esp_task_wdt_reset();  // task nao inscrita: no-op inofensivo
        TickType_t now = xTaskGetTickCount();
        if ((int32_t)(deadline - now) <= 0) return 0;
        TickType_t slice = deadline - now;
        if (slice > pdMS_TO_TICKS(250)) slice = pdMS_TO_TICKS(250);
        EventBits_t got = xEventGroupWaitBits(s_evt, bits, pdTRUE, pdFALSE, slice);
        if ((got & bits) != 0) return got & bits;
    }
}

TickType_t deadlineIn(uint32_t ms) {
    return xTaskGetTickCount() + pdMS_TO_TICKS(ms) + 1;
}

bool sealKey(const uint8_t mac[6], uint8_t out[16]);
bool sealAead(bool enc, const uint8_t key[16], const uint8_t* nonce, const uint8_t* in,
              size_t inLen, uint8_t* out, size_t outCap, size_t* outLen);

// Fila cheia descarta a mensagem MAIS ANTIGA: num controle remoto o
// comando mais novo e o que importa. Roda so na task do host.
void pushRx(const struct os_mbuf* om) {
    if (s_rxQueue == nullptr) return;
    if (!s_pairVerified) return;  // pareamento pendente: canal de dados fechado
    uint16_t len = OS_MBUF_PKTLEN(om);
    if (len == 0 || len > CelerLink::MAX_MSG) return;
    if (ble_hs_mbuf_to_flat(om, s_rxScratch.data, sizeof(s_rxScratch.data), &len) != 0) return;
    s_rxScratch.len = len;
    // Quadro selado: abre com o bond do peer e vai para a fila propria —
    // nunca para o poll() comum. Selo que nao autentica e descartado.
    if (len >= sizeof(K_SEAL_HDR) + K_SEAL_NONCE + K_SEAL_TAG &&
        memcmp(s_rxScratch.data, K_SEAL_HDR, sizeof(K_SEAL_HDR)) == 0) {
        uint8_t key[16];
        size_t plain = 0;
        const uint8_t* nonce = s_rxScratch.data + sizeof(K_SEAL_HDR);
        const uint8_t* ct = nonce + K_SEAL_NONCE;
        const size_t ctLen = len - sizeof(K_SEAL_HDR) - K_SEAL_NONCE;
        if (s_sealedQueue == nullptr || !sealKey(s_peerAddr, key) ||
            !sealAead(false, key, nonce, ct, ctLen, s_sealScratch.data, sizeof(s_sealScratch.data), &plain)) {
            ESP_LOGW(TAG, "mensagem selada descartada (sem bond ou selo invalido)");
            return;
        }
        s_sealScratch.len = (uint16_t)plain;
        if (xQueueSend(s_sealedQueue, &s_sealScratch, 0) != pdTRUE) {
            static Msg dropS;
            xQueueReceive(s_sealedQueue, &dropS, 0);
            xQueueSend(s_sealedQueue, &s_sealScratch, 0);
        }
        return;
    }
    if (xQueueSend(s_rxQueue, &s_rxScratch, 0) != pdTRUE) {
        static Msg drop;
        xQueueReceive(s_rxQueue, &drop, 0);
        xQueueSend(s_rxQueue, &s_rxScratch, 0);
        s_rxDropped = s_rxDropped + 1;
    }
}

void clearConnState() {
    s_connActive = false;
    s_ready = false;
    s_conn = 0;
    s_mtu = 0;
    s_peerChrVal = 0;
    s_peerPairVal = 0;
    s_peerPairState = K_PAIR_OFF;
    s_peerSubscribed = false;
    s_pairPending = false;
    s_pairVerified = true;
    s_pairFails = 0;
    s_pairCode[0] = '\0';
    s_peerHasChallenge = false;
}

// ---------------------------------------------------- pareamento / bonds ----
// 6 digitos sem zero a esquerda (100000..999999): mais facil de ler na
// tela do robo e de digitar no controle.
void genPairCode() {
    snprintf(s_pairCode, sizeof(s_pairCode), "%u", (unsigned)(100000 + esp_random() % 900000));
}

// Bonds v2: blob "link_bonds2" no NVS, ate K_BOND_MAX {mac, chave}, mais
// recente primeiro. A chave nasce no pareamento por codigo:
//   K = SHA256("CLK2" || codigo || desafio)[0:16]
// (os dois lados conhecem o codigo e o desafio daquela conexao). Na volta
// o periferico manda um desafio NOVO e o central responde
//   R = SHA256(K || desafio)[0:8]
// — antes bastava o MAC estar na lista, e MAC BLE e falsificavel. Limite
// honesto: sem criptografia de enlace, quem FAREJOU o pareamento conhece o
// codigo; o que fecha e o spoofing por quem nao estava la.
// Chamado da task do host (CONNECT, write do codigo) e da task do app
// (unpair/verify); o NVS e thread-safe.
int bondLoad(Bond* out) {
    nvs_handle_t h;
    if (nvs_open(K_NVS_NS, NVS_READONLY, &h) != ESP_OK) return 0;
    int n = 0;
    size_t len = 0;
    if (nvs_get_blob(h, K_NVS_BONDS, nullptr, &len) == ESP_OK && len >= sizeof(Bond)) {
        n = (int)(len / sizeof(Bond));
        if (n > K_BOND_MAX) n = K_BOND_MAX;
        size_t cap = (size_t)n * sizeof(Bond);
        if (nvs_get_blob(h, K_NVS_BONDS, out, &cap) != ESP_OK) n = 0;
    }
    nvs_close(h);
    return n;
}

bool bondSave(const Bond* list, int n) {
    nvs_handle_t h;
    if (nvs_open(K_NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    nvs_erase_key(h, K_NVS_BONDS_V1);  // bonds so-MAC nao valem mais
    bool ok;
    if (n <= 0) {
        esp_err_t rc = nvs_erase_key(h, K_NVS_BONDS);
        ok = rc == ESP_OK || rc == ESP_ERR_NVS_NOT_FOUND;  // ausente = limpo
    } else {
        ok = nvs_set_blob(h, K_NVS_BONDS, list, (size_t)n * sizeof(Bond)) == ESP_OK;
    }
    if (ok) ok = nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool bondFind(const uint8_t mac[6], uint8_t key[K_BOND_KEY]) {
    Bond list[K_BOND_MAX];
    int n = bondLoad(list);
    for (int i = 0; i < n; i++) {
        if (memcmp(list[i].mac, mac, 6) == 0) {
            if (key) memcpy(key, list[i].key, K_BOND_KEY);
            return true;
        }
    }
    return false;
}

void bondAdd(const uint8_t mac[6], const uint8_t key[K_BOND_KEY]) {
    Bond list[K_BOND_MAX];
    int n = bondLoad(list);
    // tira o mac da posicao atual (vai pro topo; LRU no fim)
    int keep = 0;
    for (int i = 0; i < n; i++) {
        if (memcmp(list[i].mac, mac, 6) == 0) continue;
        if (keep != i) list[keep] = list[i];
        keep++;
    }
    int total = keep < K_BOND_MAX ? keep + 1 : K_BOND_MAX;
    for (int i = total - 1; i > 0; i--) list[i] = list[i - 1];
    memcpy(list[0].mac, mac, 6);
    memcpy(list[0].key, key, K_BOND_KEY);
    if (bondSave(list, total)) {
        char id[18];
        formatAddr(mac, id);
        ESP_LOGI(TAG, "peer pareado e memorizado (%s)", id);
    }
}

bool bondRemove(const uint8_t mac[6]) {
    Bond list[K_BOND_MAX];
    int n = bondLoad(list);
    int out = 0;
    bool found = false;
    for (int i = 0; i < n; i++) {
        if (memcmp(list[i].mac, mac, 6) == 0) { found = true; continue; }
        list[out++] = list[i];
    }
    if (!found) return false;
    return bondSave(list, out);
}

void sha256(const uint8_t* in, size_t n, uint8_t out[32]) {
    size_t olen = 0;
    psa_crypto_init();  // idempotente
    psa_hash_compute(PSA_ALG_SHA_256, in, n, out, 32, &olen);
}

// Chave do selo: SHA-256("celer-seal-v1" | chave do bond) -> 16 bytes. Chave
// propria por finalidade: a do bond segue so para o desafio-resposta.
bool sealKey(const uint8_t mac[6], uint8_t out[16]) {
    uint8_t bond[K_BOND_KEY];
    if (!bondFind(mac, bond)) return false;
    static const char kLabel[] = "celer-seal-v1";
    uint8_t buf[sizeof(kLabel) - 1 + K_BOND_KEY];
    memcpy(buf, kLabel, sizeof(kLabel) - 1);
    memcpy(buf + sizeof(kLabel) - 1, bond, K_BOND_KEY);
    uint8_t h[32];
    sha256(buf, sizeof(buf), h);
    memcpy(out, h, 16);
    return true;
}

// AES-128-GCM via PSA (o mbedTLS do IDF). enc=false confere a tag: falha
// de autenticacao devolve false sem expor o texto.
bool sealAead(bool enc, const uint8_t key[16], const uint8_t* nonce, const uint8_t* in,
              size_t inLen, uint8_t* out, size_t outCap, size_t* outLen) {
    psa_crypto_init();
    psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&a, PSA_KEY_TYPE_AES);
    psa_set_key_bits(&a, 128);
    psa_set_key_usage_flags(&a, PSA_KEY_USAGE_ENCRYPT | PSA_KEY_USAGE_DECRYPT);
    psa_set_key_algorithm(&a, PSA_ALG_GCM);
    psa_key_id_t id = 0;
    if (psa_import_key(&a, key, 16, &id) != PSA_SUCCESS) return false;
    psa_status_t st = enc
        ? psa_aead_encrypt(id, PSA_ALG_GCM, nonce, K_SEAL_NONCE, K_SEAL_HDR, sizeof(K_SEAL_HDR),
                           in, inLen, out, outCap, outLen)
        : psa_aead_decrypt(id, PSA_ALG_GCM, nonce, K_SEAL_NONCE, K_SEAL_HDR, sizeof(K_SEAL_HDR),
                           in, inLen, out, outCap, outLen);
    psa_destroy_key(id);
    return st == PSA_SUCCESS;
}

// K a partir do codigo de 6 digitos e do desafio da conexao do pareamento
void bondKeyFromCode(const char* code, const uint8_t chal[K_CHAL], uint8_t key[K_BOND_KEY]) {
    uint8_t buf[4 + 6 + K_CHAL];
    memcpy(buf, "CLK2", 4);
    memcpy(buf + 4, code, 6);
    memcpy(buf + 10, chal, K_CHAL);
    uint8_t h[32];
    sha256(buf, sizeof(buf), h);
    memcpy(key, h, K_BOND_KEY);
}

// Resposta ao desafio: prova que conhece K sem manda-la pelo ar
void bondResponse(const uint8_t key[K_BOND_KEY], const uint8_t chal[K_CHAL], uint8_t out[K_CHAL]) {
    uint8_t buf[K_BOND_KEY + K_CHAL];
    memcpy(buf, key, K_BOND_KEY);
    memcpy(buf + K_BOND_KEY, chal, K_CHAL);
    uint8_t h[32];
    sha256(buf, sizeof(buf), h);
    memcpy(out, h, K_CHAL);
}

// comparacao em tempo constante (resposta/codigo)
bool ctEqual(const uint8_t* a, const uint8_t* b, size_t n) {
    uint8_t d = 0;
    for (size_t i = 0; i < n; i++) d |= a[i] ^ b[i];
    return d == 0;
}

int onGapEvent(ble_gap_event* event, void* arg);  // usado pelo advRestart

// (Re)liga o advertising se o app pediu e o radio esta livre. Chamado
// da task do host (eventos) e da do app (start).
void advRestart() {
    if (s_connActive || s_connecting) return;
#if CONFIG_CELEROS_PHONE_LINK
    // Sem app usando o Celer Link: o relogio anuncia o Phone Link
    if (!s_wantAdvertise) {
        if (!PhoneLink::wantAdvertise() || ble_gap_adv_active()) return;
        struct ble_hs_adv_fields f;
        memset(&f, 0, sizeof(f));
        f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
        f.uuids128 = (const ble_uuid128_t*)PhoneLink::advUuid128();
        f.num_uuids128 = 1;
        f.uuids128_is_complete = 1;
        struct ble_hs_adv_fields r;
        memset(&r, 0, sizeof(r));
        const char* nm = PhoneLink::advName();
        r.name = (const uint8_t*)nm;
        r.name_len = (uint8_t)strlen(nm);
        r.name_is_complete = 1;
        struct ble_gap_adv_params p;
        memset(&p, 0, sizeof(p));
        p.conn_mode = BLE_GAP_CONN_MODE_UND;
        p.disc_mode = BLE_GAP_DISC_MODE_GEN;
        // intervalo longo (~1 s): economia; o Gadgetbridge reconecta sozinho
        p.itvl_min = 1600;
        p.itvl_max = 1760;
        if (ble_gap_adv_set_fields(&f) != 0 || ble_gap_adv_rsp_set_fields(&r) != 0) return;
        int rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, nullptr, BLE_HS_FOREVER, &p, onGapEvent, nullptr);
        if (rc == 0) s_advPhone = true;
        return;
    }
    if (s_advPhone && ble_gap_adv_active()) ble_gap_adv_stop();  // app tem prioridade
    s_advPhone = false;
#else
    if (!s_wantAdvertise) return;
#endif
    if (ble_gap_adv_active()) return;

    struct ble_hs_adv_fields f;
    memset(&f, 0, sizeof(f));
    f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    f.uuids128 = &kSvcUuid;
    f.num_uuids128 = 1;
    f.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&f);
    if (rc != 0) {
        ESP_LOGW(TAG, "adv_set_fields rc=%d", rc);
        return;
    }

    struct ble_hs_adv_fields r;
    memset(&r, 0, sizeof(r));
    r.name = (const uint8_t*)s_advName;
    r.name_len = (uint8_t)strlen(s_advName);
    r.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&r);
    if (rc != 0) {
        ESP_LOGW(TAG, "adv_rsp_set_fields rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params p;
    memset(&p, 0, sizeof(p));
    p.conn_mode = BLE_GAP_CONN_MODE_UND;
    p.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, nullptr, BLE_HS_FOREVER, &p, onGapEvent, nullptr);
    if (rc != 0 && rc != BLE_HS_EALREADY) ESP_LOGW(TAG, "adv_start rc=%d", rc);
}

// ------------------------------------------------------------- GATT server

// Escrita do peer na nossa caracteristica = mensagem recebida.
int onChrAccess(uint16_t conn, uint16_t attr, ble_gatt_access_ctxt* ctxt, void* arg) {
    (void)conn;
    (void)attr;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    if (OS_MBUF_PKTLEN(ctxt->om) > CelerLink::MAX_MSG) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    pushRx(ctxt->om);  // descarta enquanto o pareamento nao fecha
    return 0;
}

// Char "pair" (API 11). READ = estado (K_PAIR_*); WRITE = candidato a
// codigo. O write com resposta volta ATT-ok mesmo errado: o veredito e o
// estado (o central re-le) — sem erro customizado no ATT.
int onPairAccess(uint16_t conn, uint16_t attr, ble_gatt_access_ctxt* ctxt, void* arg) {
    (void)conn;
    (void)attr;
    (void)arg;
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        // [estado] + desafio de 8 bytes (v2). Central antigo le so o 1o byte.
        uint8_t st = !s_pairRequired ? K_PAIR_OFF : (s_pairVerified ? K_PAIR_OK : K_PAIR_WAIT);
        if (os_mbuf_append(ctxt->om, &st, 1) != 0) return BLE_ATT_ERR_INSUFFICIENT_RES;
        if (st == K_PAIR_WAIT && os_mbuf_append(ctxt->om, s_challenge, K_CHAL) != 0) {
            return BLE_ATT_ERR_INSUFFICIENT_RES;
        }
        return 0;
    }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    const uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    if (len != 6 && len != K_CHAL) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    uint8_t in[8] = {0};
    uint16_t got = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, in, len, &got) != 0 || got != len) return BLE_ATT_ERR_UNLIKELY;
    if (!s_pairRequired || s_pairVerified) return 0;  // nada a fazer

    bool ok = false;
    if (len == 6) {
        // codigo digitado no central: abre e cria/renova o bond com chave
        ok = s_pairCode[0] != '\0' && ctEqual(in, (const uint8_t*)s_pairCode, 6);
        if (ok) {
            uint8_t key[K_BOND_KEY];
            bondKeyFromCode(s_pairCode, s_challenge, key);
            bondAdd(s_peerAddr, key);
        }
    } else {
        // resposta ao desafio de um central que ja pareou (bond v2)
        uint8_t key[K_BOND_KEY], expect[K_CHAL];
        if (bondFind(s_peerAddr, key)) {
            bondResponse(key, s_challenge, expect);
            ok = ctEqual(in, expect, K_CHAL);
        }
    }
    if (ok) {
        s_pairVerified = true;
        s_pairPending = false;
        s_ready = true;  // o gate segurava o ready do peripheral
        ESP_LOGI(TAG, "%s", len == 6 ? "pareamento aceito" : "peer pareado voltou (desafio ok)");
        return 0;
    }
    s_pairFails = s_pairFails + 1;
    ESP_LOGW(TAG, "%s errado (%d/%d)", len == 6 ? "codigo de pareamento" : "desafio do bond",
             s_pairFails, K_PAIR_MAX_FAILS);
    if (!s_pairPending) {
        // desafio falhou: cai no pareamento por codigo (mostra na tela)
        s_pairPending = true;
        s_pairDeadline = xTaskGetTickCount() + pdMS_TO_TICKS(K_PAIR_TIMEOUT_MS);
    }
    if (s_pairFails >= K_PAIR_MAX_FAILS && s_connActive) {
        ble_gap_terminate(s_conn, K_CONN_TERM);  // async: o DISCONNECT limpa
    }
    return 0;
}

// Inicializacao posicional (sem designadores): o -Werror de campos faltando
// nao perdoa designadores parciais. Ordem de ble_gatt_chr_def:
// uuid, access_cb, arg, descriptors, flags, min_key_size, val_handle, cpfd.
// A char de pareamento fica DEPOIS da de mensagens: os handles atribuidos
// a esta nao mudam (central antigo presume CCCD em val+1).
const struct ble_gatt_chr_def kChrDefs[] = {
    {&kChrUuid.u, onChrAccess, nullptr, nullptr,
     BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_NOTIFY,
     0, &s_chrValHandle, nullptr},
    {&kPairUuid.u, onPairAccess, nullptr, nullptr,
     BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE,
     0, &s_pairValHandle, nullptr},
    {},  // terminador (uuid NULL)
};

const struct ble_gatt_svc_def kSvcDefs[] = {
    {BLE_GATT_SVC_TYPE_PRIMARY, &kSvcUuid.u, nullptr, kChrDefs},
    {},  // terminador
};

// ------------------------------------------------ procedimentos (central)

int onMtu(uint16_t conn, const struct ble_gatt_error* err, uint16_t mtu, void* arg) {
    (void)conn;
    (void)arg;
    if (err->status == 0) s_mtu = mtu;
    xEventGroupSetBits(s_evt, EV_MTU);  // falha nao e fatal: segue com 23
    return 0;
}

// Descoberta por UUID: o alvo (handle de saida + bit + se a ausencia e
// erro) vem no arg — mesma callback para a char de mensagens e a de
// pareamento.
struct DiscTarget {
    uint16_t* out;
    EventBits_t bit;
    bool optional;  // nao achou = peer antigo, nao e falha
};
DiscTarget s_tgtMsg = {&s_peerChrVal, EV_CHR, false};
DiscTarget s_tgtPair = {&s_peerPairVal, EV_PCHR, true};

int onDiscChr(uint16_t conn, const struct ble_gatt_error* err, const struct ble_gatt_chr* chr, void* arg) {
    (void)conn;
    DiscTarget* t = (DiscTarget*)arg;
    if (err->status == 0 && chr != nullptr) {
        if (*t->out == 0) *t->out = chr->val_handle;
    } else if (err->status == BLE_HS_EDONE) {
        if (*t->out == 0 && !t->optional) {
            xEventGroupSetBits(s_evt, t->bit | EV_FAIL);
        } else {
            xEventGroupSetBits(s_evt, t->bit);
        }
    } else {
        xEventGroupSetBits(s_evt, EV_FAIL);
    }
    return 0;
}

int onCccdWrite(uint16_t conn, const struct ble_gatt_error* err, struct ble_gatt_attr* attr, void* arg) {
    (void)conn;
    (void)attr;
    (void)arg;
    xEventGroupSetBits(s_evt, err->status == 0 ? EV_SUB : EV_FAIL);
    return 0;
}

// Escrita do codigo na char "pair" do peer (verify()).
int onPairWrite(uint16_t conn, const struct ble_gatt_error* err, struct ble_gatt_attr* attr, void* arg) {
    (void)conn;
    (void)attr;
    (void)arg;
    xEventGroupSetBits(s_evt, err->status == 0 ? EV_PAIRW : EV_FAIL);
    return 0;
}

// Leitura do estado "pair" do peer. Erro de leitura vira K_PAIR_WAIT:
// falha fechada (pede verify, que por sua vez falha visivel) em vez de
// abrir o canal por acidente.
int onPairRead(uint16_t conn, const struct ble_gatt_error* err, struct ble_gatt_attr* attr, void* arg) {
    (void)conn;
    (void)arg;
    uint8_t v = K_PAIR_WAIT;
    bool hasChal = false;
    if (err->status == 0 && attr != nullptr && OS_MBUF_PKTLEN(attr->om) >= 1) {
        uint8_t buf[1 + K_CHAL];
        uint16_t got = 0;
        if (ble_hs_mbuf_to_flat(attr->om, buf, sizeof(buf), &got) != 0 || got < 1) {
            v = K_PAIR_WAIT;
        } else {
            v = buf[0];
            // peer v2: estado + desafio da conexao (base da resposta e da chave)
            if (got == 1 + K_CHAL) {
                memcpy(s_peerChallenge, buf + 1, K_CHAL);
                hasChal = true;
            }
        }
    }
    // releitura pos-verify volta so [OK]: nao apaga o desafio da conexao
    if (hasChal) s_peerHasChallenge = true;
    s_peerPairState = v;
    xEventGroupSetBits(s_evt, EV_PAIRR);
    return 0;
}

// ------------------------------------------------------------------- scan

void onDiscAdv(const struct ble_gap_disc_desc* d) {
    struct ble_hs_adv_fields f;
    if (ble_hs_adv_parse_fields(&f, d->data, d->length_data) != 0) return;

    bool ours = false;
    for (int i = 0; i < f.num_uuids128; i++) {
        if (ble_uuid_cmp(&f.uuids128[i].u, &kSvcUuid.u) == 0) {
            ours = true;
            break;
        }
    }

    // O UUID vem no ADV; o nome vem na resposta de scan (mesmo endereco,
    // evento separado): cria na primeira e faz merge na segunda.
    ScanEntry* e = nullptr;
    for (int i = 0; i < s_scanCount; i++) {
        if (s_scanCache[i].addrType == d->addr.type && memcmp(s_scanCache[i].addr, d->addr.val, 6) == 0) {
            e = &s_scanCache[i];
            break;
        }
    }
    if (e == nullptr) {
        if (!ours || s_scanCount >= K_SCAN_CACHE) return;
        e = &s_scanCache[s_scanCount];
        memset(e, 0, sizeof(*e));
        e->addrType = d->addr.type;
        memcpy(e->addr, d->addr.val, 6);
        s_scanCount = s_scanCount + 1;
    }
    e->rssi = d->rssi;
    if (f.name != nullptr && f.name_len > 0) {
        size_t n = f.name_len < sizeof(e->name) - 1 ? f.name_len : sizeof(e->name) - 1;
        memcpy(e->name, f.name, n);
        e->name[n] = '\0';
    }
}

// -------------------------------------------------------------------- GAP

int onGapEvent(ble_gap_event* event, void* arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT: {
            if (event->connect.status != 0) {
                // falha ao conectar (central) ou conexao nao estabelecida
                if (s_isCentral) xEventGroupSetBits(s_evt, EV_FAIL);
                advRestart();
                return 0;
            }
            s_conn = event->connect.conn_handle;
            s_connActive = true;
#if CONFIG_CELEROS_PHONE_LINK
            if (!s_isCentral && s_advPhone) {
                // conexao veio do advertising do Phone Link: e do celular
                s_advPhone = false;
                s_phoneConn = true;
                s_ready = false;  // canal do Celer Link segue fechado
                PhoneLink::onConnect(s_conn);
                return 0;
            }
#endif
            s_mtu = ble_att_mtu(s_conn);
            if (s_mtu == 0) s_mtu = K_MTU_DEFAULT;
            s_peerSubscribed = false;
            struct ble_gap_conn_desc desc;
            if (ble_gap_conn_find(s_conn, &desc) == 0) memcpy(s_peerAddr, desc.peer_ota_addr.val, 6);
            if (ble_gap_adv_active()) ble_gap_adv_stop();  // 1 conexao por vez
            // Sessao nova: nada da conexao anterior vaza para esta.
            if (s_rxQueue != nullptr) xQueueReset(s_rxQueue);
            if (s_sealedQueue != nullptr) xQueueReset(s_sealedQueue);
            s_pairFails = 0;
            s_pairPending = false;
            s_pairVerified = true;
            if (!s_isCentral) {
                if (s_pairRequired) {
                    // gate SEMPRE fechado: codigo e desafio novos por conexao.
                    // Peer com bond tem K_BOND_GRACE_MS para responder ao
                    // desafio antes do codigo aparecer na tela; sem bond, o
                    // codigo ja vale (expira sozinho).
                    genPairCode();
                    esp_fill_random(s_challenge, K_CHAL);
                    s_pairVerified = false;
                    if (bondFind(s_peerAddr, nullptr)) {
                        s_pairPending = false;
                        s_pairDeadline = xTaskGetTickCount() + pdMS_TO_TICKS(K_BOND_GRACE_MS);
                        ESP_LOGI(TAG, "peer com bond conectou, desafio enviado (conn=%u)", s_conn);
                    } else {
                        s_pairPending = true;
                        s_pairDeadline = xTaskGetTickCount() + pdMS_TO_TICKS(K_PAIR_TIMEOUT_MS);
                        ESP_LOGI(TAG, "peer conectou, aguardando codigo (conn=%u)", s_conn);
                    }
                } else {
                    s_ready = true;
                }
            }
            xEventGroupSetBits(s_evt, EV_CONN);
            return 0;
        }
        case BLE_GAP_EVENT_DISCONNECT: {
#if CONFIG_CELEROS_PHONE_LINK
            if (s_phoneConn) {
                s_phoneConn = false;
                PhoneLink::onDisconnect();
                clearConnState();
                xEventGroupSetBits(s_evt, EV_DISC);
                advRestart();
                return 0;
            }
#endif
            ESP_LOGI(TAG, "desconectado (reason=0x%x)", event->disconnect.reason);
            clearConnState();
            // durante o connect() quem limpa o papel e o proprio connect
            if (!s_connecting) s_isCentral = false;
            xEventGroupSetBits(s_evt, EV_DISC | EV_FAIL);
            advRestart();
            return 0;
        }
        case BLE_GAP_EVENT_MTU:
            s_mtu = event->mtu.value;
#if CONFIG_CELEROS_PHONE_LINK
            if (s_phoneConn) PhoneLink::onMtu(event->mtu.value);
#endif
            return 0;
#if CONFIG_CELEROS_PHONE_LINK
        case BLE_GAP_EVENT_PASSKEY_ACTION:
        case BLE_GAP_EVENT_ENC_CHANGE:
        case BLE_GAP_EVENT_REPEAT_PAIRING:
            return PhoneLink::onGapSecurity(event);
#endif
        case BLE_GAP_EVENT_SUBSCRIBE:
#if CONFIG_CELEROS_PHONE_LINK
            if (s_phoneConn) {
                PhoneLink::onSubscribe(event->subscribe.attr_handle, event->subscribe.cur_notify != 0);
                return 0;
            }
#endif
            if (event->subscribe.attr_handle == s_chrValHandle) {
                s_peerSubscribed = event->subscribe.cur_notify != 0;
            }
            return 0;
        case BLE_GAP_EVENT_ADV_COMPLETE:
            advRestart();
            return 0;
        case BLE_GAP_EVENT_DISC:
            // Malha CelerNet primeiro (barato: magic na 1a comparacao); o
            // resto segue para o cache do scan do app.
            CelerNet::onAdvReport(event->disc.data, event->disc.length_data, event->disc.rssi);
            onDiscAdv(&event->disc);
            return 0;
        case BLE_GAP_EVENT_DISC_COMPLETE:
            xEventGroupSetBits(s_evt, EV_SCAN);
            return 0;
        case BLE_GAP_EVENT_NOTIFY_RX:
            // Notificacao do peer (somos central): mensagem recebida. O
            // NimBLE libera o om depois do callback.
            if (event->notify_rx.attr_handle == s_peerChrVal && s_peerChrVal != 0) {
                pushRx(event->notify_rx.om);
            }
            return 0;
        default:
            return 0;
    }
}

// ------------------------------------------------------------ init NimBLE

void onSync() {
#if CONFIG_IDF_TARGET_ESP32
    // ESP32 classico: o controlador BTDM nao tem Kconfig de potencia e nasce
    // em +3 dBm (as S3 vem com BT_CTRL_DFT_TX_POWER_LEVEL_P9). Somado a
    // antena de PCB da esp32-cam, a malha ficava em -96 dBm a 1 sala de
    // distancia do 4848 e o ping se perdia (bancada 2026-10-10). Mesmo
    // +9 dBm das S3 para adv (malha), scan e conexoes.
    esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_ADV, ESP_PWR_LVL_P9);
    esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_SCAN, ESP_PWR_LVL_P9);
    esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, ESP_PWR_LVL_P9);
#endif
    // Tambem chega depois de um reset do host: retoma o advertising.
    if (s_started) advRestart();
    xSemaphoreGive(s_syncSem);
}

void onReset(int reason) {
    ESP_LOGW(TAG, "host NimBLE resetou (reason=%d)", reason);
#if CONFIG_CELEROS_PHONE_LINK
    if (s_phoneConn) {
        s_phoneConn = false;
        PhoneLink::onDisconnect();
    }
    s_advPhone = false;
#endif
    // As conexoes morreram com o controlador; nenhum evento DISCONNECT vem.
    clearConnState();
    if (!s_connecting) s_isCentral = false;
    xEventGroupSetBits(s_evt, EV_DISC | EV_FAIL | EV_SCAN);
}

void hostTask(void*) {
    nimble_port_run();      // roda ate deinit
    nimble_port_freertos_deinit();
}

void defaultName() {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_BT);
    snprintf(s_advName, sizeof(s_advName), "Celer-%02X%02X", mac[4], mac[5]);
}

bool parseMac(const char* s, uint8_t out[6]) {
    if (strlen(s) != 17) return false;
    for (int i = 0; i < 6; i++) {
        if (i < 5 && s[i * 3 + 2] != ':') return false;
        char hex[3] = {s[i * 3], s[i * 3 + 1], '\0'};
        char* end = nullptr;
        long v = strtol(hex, &end, 16);
        if (end != hex + 2) return false;
        out[5 - i] = (uint8_t)v;  // exibido big-endian, ble_addr little-endian
    }
    return true;
}

// id "AA:BB:..." ou nome do ultimo scan -> endereco. O tipo do endereco
// vem do cache do scan quando o par esta la (random vs public).
bool resolveTarget(const char* idOrName, ble_addr_t* out) {
    uint8_t mac[6];
    if (parseMac(idOrName, mac)) {
        for (int i = 0; i < s_scanCount; i++) {
            if (memcmp(s_scanCache[i].addr, mac, 6) == 0) {
                out->type = s_scanCache[i].addrType;
                memcpy(out->val, mac, 6);
                return true;
            }
        }
        out->type = BLE_ADDR_PUBLIC;  // CelerOS usa endereco publico
        memcpy(out->val, mac, 6);
        return true;
    }
    for (int i = 0; i < s_scanCount; i++) {
        // nome vazio nao e alvo: entrada criada so pelo UUID (a resposta de
        // scan com o nome pode nem ter chegado) — connect("") nao pega ela
        if (s_scanCache[i].name[0] != '\0' && strcmp(s_scanCache[i].name, idOrName) == 0) {
            out->type = s_scanCache[i].addrType;
            memcpy(out->val, s_scanCache[i].addr, 6);
            return true;
        }
    }
    return false;
}

// Encerra a conexao atual e ESPERA o evento de desconexao: sem isso o
// proximo connect/advertising bate no limite de 1 conexao.
bool dropConnection(uint32_t waitMs) {
    if (!s_connActive) return true;
    uint16_t c = s_conn;
    xEventGroupClearBits(s_evt, EV_DISC);
    int rc = ble_gap_terminate(c, K_CONN_TERM);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        // ja nao existe (ENOTCONN): so limpa o estado local
        clearConnState();
        return true;
    }
    if (waitBits(EV_DISC, deadlineIn(waitMs)) == 0) {
        ESP_LOGW(TAG, "desconexao sem confirmacao em %u ms", (unsigned)waitMs);
        clearConnState();
        return false;
    }
    return true;
}

// Os procedimentos do host devolvem ENOMEM/EBUSY quando faltam buffers
// ou ha procedimento ATT pendente: tenta de novo por um prazo curto.
bool retryable(int rc) {
    return rc == BLE_HS_ENOMEM || rc == BLE_HS_EBUSY || rc == BLE_HS_EAGAIN;
}

}  // namespace

// ------------------------------------------------------------------- API

bool CelerLink::ensureStarted(bool latchFailure) {
    if (s_started) return true;
    if (s_initFail) return false;

    // O NimBLE nao devolve erro quando falta RAM interna no init do host: o
    // os_mempool_init do ble_hs_init cai num SYSINIT_PANIC_ASSERT e o
    // aparelho REINICIA (Celer Remote derrubava o 4848 no primeiro scan).
    // Recusar antes, com erro legivel, e o app segue sem link. O gate vem
    // ANTES das primitivas: a malha e o Phone Link re-tentam a cada 10 s, e
    // cada recusa depois de criá-las vazava ~2,5 KB de RAM interna — a
    // espiral que derrubava o relogio (interna minima 1,6 KB na bancada)
    const size_t freeInt = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    const size_t bigInt = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
    if (freeInt < K_BLE_MIN_INTERNAL || bigInt < K_BLE_MIN_BLOCK) {
        ESP_LOGE(TAG, "RAM interna insuficiente para o BLE (livre %u, maior bloco %u; precisa %u/%u)",
                 (unsigned)freeInt, (unsigned)bigInt, (unsigned)K_BLE_MIN_INTERNAL, (unsigned)K_BLE_MIN_BLOCK);
        if (latchFailure) s_initFail = true;
        return false;
    }
    // criadas uma vez so (re-tentativas reaproveitam)
    if (s_syncSem == nullptr) s_syncSem = xSemaphoreCreateBinary();
    if (s_evt == nullptr) s_evt = xEventGroupCreate();
    if (s_rxQueue == nullptr) s_rxQueue = xQueueCreate(RX_DEPTH, sizeof(Msg));
    if (s_sealedQueue == nullptr) s_sealedQueue = xQueueCreate(K_SEALED_DEPTH, sizeof(Msg));
    if (s_syncSem == nullptr || s_evt == nullptr || s_rxQueue == nullptr || s_sealedQueue == nullptr) {
        ESP_LOGE(TAG, "sem memoria para as primitivas do link");
        if (latchFailure) s_initFail = true;
        return false;
    }
    if (nimble_port_init() != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init falhou");
        if (latchFailure) s_initFail = true;
        return false;
    }
    ble_hs_cfg.sync_cb = onSync;
    ble_hs_cfg.reset_cb = onReset;
    int rc = ble_gatts_count_cfg(kSvcDefs);
    if (rc == 0) rc = ble_gatts_add_svcs(kSvcDefs);
#if CONFIG_CELEROS_PHONE_LINK
    // NUS do Phone Link na mesma tabela + seguranca: o celular pareia com
    // codigo exibido no relogio (MITM) e o bond fica no NVS do NimBLE
    if (rc == 0) rc = ble_gatts_count_cfg(PhoneLink::gattServices());
    if (rc == 0) rc = ble_gatts_add_svcs(PhoneLink::gattServices());
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_DISP_ONLY;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 1;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
    ble_store_config_init();
#endif
    if (rc != 0) {
        // depois do nimble_port_init nao ha volta: re-tentar faria um 2o init
        // do host (crash/task duplicada) — trava sempre
        ESP_LOGE(TAG, "registro GATT falhou (rc=%d)", rc);
        s_initFail = true;
        return false;
    }
    ble_svc_gap_init();
    ble_svc_gatt_init();
    defaultName();
    ble_svc_gap_device_name_set(s_advName);
    nimble_port_freertos_init(hostTask);

    // Espera o sync em fatias, alimentando o watchdog da task do app.
    bool synced = false;
    for (int i = 0; i < 16 && !synced; i++) {
        esp_task_wdt_reset();
        synced = xSemaphoreTake(s_syncSem, pdMS_TO_TICKS(250)) == pdTRUE;
    }
    if (!synced) {
        ESP_LOGE(TAG, "sync do host NimBLE nao chegou");
        s_initFail = true;  // host ja subiu: sem deinit e sem 2o init
        return false;
    }
    ble_att_set_preferred_mtu(K_MTU_WANT);
    s_started = true;
    ESP_LOGI(TAG, "Celer Link pronto (NimBLE, \"%s\"; RAM interna %u -> %u)", s_advName,
             (unsigned)freeInt, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    return true;
}

bool CelerLink::start(const char* name, bool requirePairing) {
    if (!ensureStarted()) return false;
    bool rename = false;
    if (name != nullptr && name[0] != '\0' && strncmp(name, s_advName, MAX_NAME) != 0) {
        snprintf(s_advName, sizeof(s_advName), "%s", name);
        ble_svc_gap_device_name_set(s_advName);
        rename = true;
    }
    // Vale para as conexoes seguintes (a sessao atual, se houver, segue
    // como esta — o app chama start() uma vez, antes de conectar).
    s_pairRequired = requirePairing;
    s_wantAdvertise = true;
    // App no Celer Link tem prioridade sobre o celular (1 conexao so): o
    // Gadgetbridge reconecta quando o app sair (appReset re-anuncia)
    if (s_phoneConn) dropConnection(K_DISC_WAIT_MS);
    // Nome novo so entra no ar reiniciando o advertising.
    if (rename && ble_gap_adv_active()) ble_gap_adv_stop();
    advRestart();
    return true;
}

bool CelerLink::stop() {
    s_wantAdvertise = false;
    if (s_started && ble_gap_adv_active()) ble_gap_adv_stop();
    if (s_started) advRestart();  // Phone Link volta ao ar (no-op sem ele)
    return true;
}

void CelerLink::refreshAdvertising() {
    if (s_started) advRestart();
}

void CelerLink::dropPhone() {
    if (!s_started) return;
    if (s_advPhone && ble_gap_adv_active()) ble_gap_adv_stop();
    s_advPhone = false;
    if (s_phoneConn && s_connActive) ble_gap_terminate(s_conn, K_CONN_TERM);  // DISCONNECT limpa
}

bool CelerLink::listening() {
    return s_wantAdvertise;
}

int CelerLink::scan(uint32_t ms, Peer* out, int max) {
    if (!ensureStarted() || max <= 0 || s_connecting) return 0;
    s_appScanning = true;  // ANTES do cancel: a malha pausa o scanner dela
    if (ble_gap_disc_active()) ble_gap_disc_cancel();

    s_scanCount = 0;
    memset(s_scanCache, 0, sizeof(s_scanCache));

    struct ble_gap_disc_params p;
    memset(&p, 0, sizeof(p));
    p.passive = 0;             // scan ativo: pede a resposta com o nome
    p.filter_duplicates = 1;
    xEventGroupClearBits(s_evt, EV_SCAN);
    int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, (int32_t)ms, &p, onGapEvent, nullptr);
    if (rc != 0) {
        ESP_LOGW(TAG, "scan: ble_gap_disc rc=%d", rc);
        s_appScanning = false;
        return 0;
    }
    if (waitBits(EV_SCAN, deadlineIn(ms + 1000)) == 0) {
        // o controlador nao fechou o scan: cancela antes de ler o cache
        ble_gap_disc_cancel();
    }

    int total = s_scanCount;
    int n = 0;
    for (int i = 0; i < total && n < max; i++) {
        formatAddr(s_scanCache[i].addr, out[n].id);
        snprintf(out[n].name, sizeof(out[n].name), "%s", s_scanCache[i].name);
        out[n].rssi = s_scanCache[i].rssi;
        n++;
    }
    // Mais forte primeiro (insertion sort: no maximo 16 itens).
    for (int i = 1; i < n; i++) {
        Peer t = out[i];
        int j = i - 1;
        while (j >= 0 && out[j].rssi < t.rssi) {
            out[j + 1] = out[j];
            j--;
        }
        out[j + 1] = t;
    }
    s_appScanning = false;
    return n;
}

bool CelerLink::appBusy() {
    return s_connecting || s_appScanning;
}

bool CelerLink::linkActive() {
    return s_connActive;
}

bool CelerLink::connect(const char* idOrName, uint32_t ms) {
    if (!ensureStarted() || s_connecting) return false;

    ble_addr_t addr;
    if (!resolveTarget(idOrName, &addr)) {
        ESP_LOGW(TAG, "connect: alvo desconhecido \"%s\" (scan antes)", idOrName);
        return false;
    }

    const TickType_t deadline = deadlineIn(ms);
    if (s_connActive) dropConnection(K_DISC_WAIT_MS);
    if (ble_gap_disc_active()) ble_gap_disc_cancel();

    s_connecting = true;
    s_isCentral = true;
    s_ready = false;
    s_peerChrVal = 0;
    s_peerPairVal = 0;
    s_peerPairState = K_PAIR_OFF;
    s_peerHasChallenge = false;
    s_pairPending = false;
    s_pairVerified = false;  // o passo 5 decide (peer sem gate = true)
    if (ble_gap_adv_active()) ble_gap_adv_stop();  // volta no fail/disconnect
    xEventGroupClearBits(s_evt, EV_CONN | EV_FAIL | EV_CHR | EV_MTU | EV_SUB | EV_DISC |
                                  EV_PCHR | EV_PAIRW | EV_PAIRR);

    struct ble_gap_conn_params cp;
    memset(&cp, 0, sizeof(cp));
    cp.scan_itvl = 0x0010;
    cp.scan_window = 0x0010;
    cp.itvl_min = K_ITVL_MIN;
    cp.itvl_max = K_ITVL_MAX;
    cp.latency = 0;
    cp.supervision_timeout = K_SUPERVISION;

    const char* step = "gap_connect";
    int rc = ble_gap_connect(BLE_OWN_ADDR_PUBLIC, &addr, (int32_t)ms, &cp, onGapEvent, nullptr);
    if (rc != 0) {
        ESP_LOGW(TAG, "connect: ble_gap_connect rc=%d", rc);
        goto fail;
    }

    // 1) enlace
    step = "conexao";
    if (!(waitBits(EV_CONN | EV_FAIL, deadline) & EV_CONN)) {
        // sem conexao no prazo: cancela o procedimento pendente, senao ela
        // pode surgir depois como "conexao zumbi" sem descoberta
        if (!s_connActive && ble_gap_conn_cancel() == 0) {
            // o cancelamento fecha com um CONNECT de status != 0; se a
            // conexao completou no mesmo instante, o fail a derruba
            waitBits(EV_CONN | EV_FAIL, deadlineIn(300));
        }
        goto fail;
    }

    // 2) MTU antes de qualquer outro pedido ATT (um por vez no bearer)
    step = "mtu";
    if (ble_gattc_exchange_mtu(s_conn, onMtu, nullptr) == 0) {
        EventBits_t got = waitBits(EV_MTU | EV_DISC, deadline);
        if (!(got & EV_MTU)) goto fail;
    }

    // 3) caracteristica de mensagens (busca direta por UUID, sem passar
    // pela descoberta do servico: uma ida e volta a menos)
    step = "descoberta";
    if (ble_gattc_disc_chrs_by_uuid(s_conn, 1, 0xFFFF, &kChrUuid.u, onDiscChr, &s_tgtMsg) != 0) goto fail;
    if (!(waitBits(EV_CHR | EV_FAIL, deadline) & EV_CHR)) goto fail;

    // 4) assina notificacoes: o CCCD fica em val_handle+1 (layout do GATT
    // do NimBLE para caracteristica com NOTIFY). Escrita COM resposta:
    // so volta pronto depois do peer confirmar.
    step = "inscricao";
    {
        const uint16_t cccd = (uint16_t)(s_peerChrVal + 1);
        const uint16_t enable = 0x0001;
        if (ble_gattc_write_flat(s_conn, cccd, &enable, sizeof(enable), onCccdWrite, nullptr) != 0) goto fail;
        if (!(waitBits(EV_SUB | EV_FAIL, deadline) & EV_SUB)) goto fail;
    }

    // 5) estado de pareamento do peer: char "pair" opcional — ausente =
    // peer v1, canal aberto como sempre. WAIT = o peer exige codigo antes
    // do send()/poll() valerem (status().pairing fica true ate o verify()).
    step = "pareamento";
    {
        if (ble_gattc_disc_chrs_by_uuid(s_conn, 1, 0xFFFF, &kPairUuid.u, onDiscChr, &s_tgtPair) != 0) goto fail;
        if (!(waitBits(EV_PCHR | EV_FAIL, deadline) & EV_PCHR)) goto fail;
        if (s_peerPairVal != 0) {
            if (ble_gattc_read(s_conn, s_peerPairVal, onPairRead, nullptr) != 0) goto fail;
            if (!(waitBits(EV_PAIRR | EV_FAIL, deadline) & EV_PAIRR)) goto fail;
        }
        // Bond v2: ja pareamos com este peer — responde ao desafio e re-le
        // o estado (sem pedir codigo ao usuario de novo)
        uint8_t key[K_BOND_KEY];
        if (s_peerPairState == K_PAIR_WAIT && s_peerPairVal != 0 && s_peerHasChallenge &&
            bondFind(s_peerAddr, key)) {
            uint8_t resp[K_CHAL];
            bondResponse(key, s_peerChallenge, resp);
            xEventGroupClearBits(s_evt, EV_PAIRW | EV_PAIRR);
            if (ble_gattc_write_flat(s_conn, s_peerPairVal, resp, K_CHAL, onPairWrite, nullptr) == 0 &&
                (waitBits(EV_PAIRW | EV_FAIL, deadline) & EV_PAIRW) &&
                ble_gattc_read(s_conn, s_peerPairVal, onPairRead, nullptr) == 0) {
                waitBits(EV_PAIRR | EV_FAIL, deadline);
            }
            if (s_peerPairState != K_PAIR_OK) ESP_LOGW(TAG, "bond recusado pelo peer: pede codigo");
        }
        if (s_peerPairState == K_PAIR_WAIT && s_peerPairVal != 0) {
            s_pairVerified = false;
            s_pairPending = true;
            // o timeout do info() compara com o deadline: sem armar aqui, um
            // deadline 0 (passado) derrubava o handshake central na 1a leitura
            s_pairDeadline = xTaskGetTickCount() + pdMS_TO_TICKS(K_PAIR_TIMEOUT_MS);
            ESP_LOGI(TAG, "peer exige codigo de pareamento");
        } else {
            s_pairVerified = true;
        }
    }

    s_ready = true;
    s_connecting = false;
    ESP_LOGI(TAG, "conectado em \"%s\" (mtu=%u%s)", idOrName, s_mtu,
             s_pairPending ? ", aguardando codigo" : "");
    return true;

fail:
    ESP_LOGW(TAG, "connect \"%s\" falhou na etapa %s", idOrName, step);
    if (s_connActive) dropConnection(K_DISC_WAIT_MS);
    s_connecting = false;
    s_isCentral = false;
    clearConnState();
    advRestart();
    return false;
}

bool CelerLink::disconnect() {
    if (!s_started || !s_connActive) return false;
    bool ok = dropConnection(K_DISC_WAIT_MS);
    s_isCentral = false;
    return ok;
}

bool CelerLink::verify(const char* code) {
    if (code == nullptr) return false;
    if (!s_started || !s_connActive || !s_isCentral) return false;
    if (s_pairVerified) return true;   // idempotente
    if (s_peerPairVal == 0) return false;  // peer sem a char: nada a verificar

    size_t len = strlen(code);
    if (len != 6) return false;
    for (size_t i = 0; i < 6; i++) {
        if (code[i] < '0' || code[i] > '9') return false;
    }

    // write COM resposta (o callback do peer roda antes do ack) e re-le o
    // estado: o write errado tambem volta ATT-ok — o veredito e o estado.
    const TickType_t deadline = deadlineIn(K_VERIFY_MS);
    xEventGroupClearBits(s_evt, EV_PAIRW | EV_PAIRR | EV_FAIL);
    int rc = ble_gattc_write_flat(s_conn, s_peerPairVal, code, 6, onPairWrite, nullptr);
    if (rc != 0 && retryable(rc)) {
        for (int i = 0; i < 24 && rc != 0; i++) {  // ~120 ms de reenvio
            vTaskDelay(pdMS_TO_TICKS(5));
            rc = ble_gattc_write_flat(s_conn, s_peerPairVal, code, 6, onPairWrite, nullptr);
        }
    }
    if (rc != 0) return false;
    // EV_FAIL cobre erro do write e queda do link (DISC seta EV_FAIL)
    if (!(waitBits(EV_PAIRW | EV_FAIL, deadline) & EV_PAIRW)) return false;
    if (ble_gattc_read(s_conn, s_peerPairVal, onPairRead, nullptr) != 0) return false;
    if (!(waitBits(EV_PAIRR | EV_FAIL, deadline) & EV_PAIRR)) return false;
    if (s_peerPairState != K_PAIR_OK) return false;

    // peer v2: memoriza a chave (proximas conexoes respondem ao desafio
    // sem codigo). A chave usa o desafio lido no connect desta conexao.
    if (s_peerHasChallenge) {
        uint8_t key[K_BOND_KEY];
        bondKeyFromCode(code, s_peerChallenge, key);
        bondAdd(s_peerAddr, key);
    }
    s_pairVerified = true;
    s_pairPending = false;
    return true;
}

bool CelerLink::unpair(const char* id) {
    if (!s_started && s_initFail) return false;
    if (id == nullptr || id[0] == '\0') {
        bool ok = bondSave(nullptr, 0);
        if (ok) ESP_LOGI(TAG, "bonds de pareamento apagados");
        return ok;
    }
    uint8_t mac[6];
    if (!parseMac(id, mac)) return false;
    return bondRemove(mac);
}

bool CelerLink::connected() {
    return s_ready && s_pairVerified;
}

bool CelerLink::send(const void* data, size_t len) {
    if (!s_started || !s_ready || !s_pairVerified || len == 0 || len > MAX_MSG) return false;
    // O ATT trunca em silencio o que passa do MTU: recusa em vez de
    // entregar JSON cortado.
    uint16_t mtu = s_mtu ? s_mtu : K_MTU_DEFAULT;
    if (len > (size_t)(mtu - 3)) {
        ESP_LOGW(TAG, "send: %u bytes nao cabem no MTU %u", (unsigned)len, mtu);
        return false;
    }
    if (!s_isCentral && !s_peerSubscribed) return false;  // peer nao ouve notify

    const TickType_t deadline = deadlineIn(K_SEND_RETRY_MS);
    // spam-control: loga a falha so na TRANSICAO (1a apos um sucesso) — a
    // telemetria do Dog Face tenta a cada ~1,6 s com o link caido e o
    // aviso por tentativa afogava ring e logcat (bancada 2026-10-05)
    static int s_lastFailRc = -99;
    for (;;) {
        int rc;
        if (s_isCentral) {
            // write sem resposta: o enlace BLE ja confirma cada pacote e
            // nao ocupa um procedimento GATT por mensagem
            rc = ble_gattc_write_no_rsp_flat(s_conn, s_peerChrVal, data, (uint16_t)len);
        } else {
            struct os_mbuf* om = ble_hs_mbuf_from_flat(data, (uint16_t)len);
            rc = om == nullptr ? BLE_HS_ENOMEM : ble_gatts_notify_custom(s_conn, s_chrValHandle, om);
            // notify_custom consome o om em qualquer resultado
        }
        if (rc == 0) {
            s_lastFailRc = -99;
            return true;
        }
        if (!retryable(rc) || !s_ready || (int32_t)(deadline - xTaskGetTickCount()) <= 0) {
            if (s_lastFailRc != rc) {
                s_lastFailRc = rc;
                ESP_LOGW(TAG, "send: rc=%d (%u bytes)", rc, (unsigned)len);
            }
            return false;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

bool CelerLink::sendSealed(const void* data, size_t len) {
    if (data == nullptr || len == 0 || len > MAX_SEALED) return false;
    if (!s_started || !s_ready || !s_pairVerified) return false;
    uint8_t key[16];
    if (!sealKey(s_peerAddr, key)) {
        ESP_LOGW(TAG, "sendSealed: sem bond com o peer (pareie por codigo)");
        return false;
    }
    static uint8_t frame[MAX_MSG];  // so a task do app envia
    memcpy(frame, K_SEAL_HDR, sizeof(K_SEAL_HDR));
    uint8_t* nonce = frame + sizeof(K_SEAL_HDR);
    esp_fill_random(nonce, K_SEAL_NONCE);
    size_t ctLen = 0;
    if (!sealAead(true, key, nonce, (const uint8_t*)data, len, nonce + K_SEAL_NONCE,
                  sizeof(frame) - sizeof(K_SEAL_HDR) - K_SEAL_NONCE, &ctLen)) {
        return false;
    }
    const bool ok = send(frame, sizeof(K_SEAL_HDR) + K_SEAL_NONCE + ctLen);
    memset(frame, 0, sizeof(frame));
    return ok;
}

bool CelerLink::pollSealed(void* buf, size_t cap, size_t* len) {
    if (s_sealedQueue == nullptr) return false;
    static Msg m;  // fora da pilha do app (so a task do app chama)
    if (xQueueReceive(s_sealedQueue, &m, 0) != pdTRUE) return false;
    size_t n = m.len < cap ? m.len : cap;
    memcpy(buf, m.data, n);
    memset(m.data, 0, sizeof(m.data));  // segredo nao fica na copia estatica
    *len = n;
    return true;
}

bool CelerLink::poll(void* buf, size_t cap, size_t* len) {
    if (s_rxQueue == nullptr) return false;
    static Msg m;  // fora da pilha do app (so a task do app chama poll)
    if (xQueueReceive(s_rxQueue, &m, 0) != pdTRUE) return false;
    size_t n = m.len < cap ? m.len : cap;
    memcpy(buf, m.data, n);
    *len = n;
    return true;
}

void CelerLink::peerId(char* out, size_t cap) {
    if (cap == 0) return;
    out[0] = '\0';
    if (s_connActive && cap >= 18) formatAddr(s_peerAddr, out);
}

void CelerLink::info(Info* out) {
    memset(out, 0, sizeof(*out));
    // Timeout do pareamento pendente e conferido aqui: o app periferico
    // faz polling do status a cada volta e o canal expira sozinho mesmo
    // sem ninguem digitando.
    // Carencia do bond venceu sem resposta valida (central antigo, ou
    // alguem so com o MAC): cai no codigo, que aparece na tela.
    if (s_pairRequired && !s_isCentral && s_connActive && !s_pairVerified && !s_pairPending &&
        (int32_t)(xTaskGetTickCount() - s_pairDeadline) >= 0) {
        s_pairPending = true;
        s_pairDeadline = xTaskGetTickCount() + pdMS_TO_TICKS(K_PAIR_TIMEOUT_MS);
        ESP_LOGI(TAG, "sem resposta ao desafio: aguardando codigo");
    }
    if (s_pairPending && s_connActive &&
        (int32_t)(xTaskGetTickCount() - s_pairDeadline) >= 0) {
        s_pairPending = false;
        ESP_LOGW(TAG, "codigo de pareamento nao digitado em %u s", (unsigned)(K_PAIR_TIMEOUT_MS / 1000));
        if (ble_gap_terminate(s_conn, K_CONN_TERM) != 0) clearConnState();
    }
    out->connected = s_ready && s_pairVerified;
    out->listening = s_wantAdvertise;
    out->central = s_ready && s_isCentral;
    out->pairing = s_pairPending;
    out->verified = s_pairVerified;
    peerId(out->peer, sizeof(out->peer));
    snprintf(out->name, sizeof(out->name), "%s", s_advName);
    // O codigo so existe para o lado periferico em handshake pendente:
    // jamais sai do device (nem advertising, nem notificacao).
    if (s_pairPending && !s_isCentral) snprintf(out->code, sizeof(out->code), "%s", s_pairCode);
    if (s_connActive) {
        out->mtu = s_mtu;
        int8_t rssi = 0;
        if (ble_gap_conn_rssi(s_conn, &rssi) == 0) out->rssi = rssi;
    }
    out->pending = s_rxQueue ? (uint16_t)uxQueueMessagesWaiting(s_rxQueue) : 0;
    out->dropped = s_rxDropped;
}

void CelerLink::appReset() {
    if (!s_started) return;
    s_wantAdvertise = false;
    if (ble_gap_adv_active()) ble_gap_adv_stop();
    if (ble_gap_disc_active()) ble_gap_disc_cancel();
    // conexao do celular (Phone Link) sobrevive a saida do app
    if (s_connActive && !s_phoneConn) dropConnection(K_DISC_WAIT_MS);
    s_isCentral = false;
    if (!s_phoneConn) clearConnState();
    s_pairRequired = true;   // padrao seguro: o proximo app decide no start()
    // O nome dado por um app (start("Celer-Dog")) nao vaza para o proximo.
    defaultName();
    ble_svc_gap_device_name_set(s_advName);
    s_rxDropped = 0;
    if (s_rxQueue != nullptr) xQueueReset(s_rxQueue);
    if (s_sealedQueue != nullptr) xQueueReset(s_sealedQueue);
    advRestart();  // Phone Link volta ao ar (no-op sem ele)
}
