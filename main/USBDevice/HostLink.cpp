#include "HostLink.h"
#include "UsbRes.h"
#if CONFIG_CELEROS_BLUETOOTH
#include "../Pack/Resources.h"
#endif
#include "esp_attr.h"
#include "../Display/ScreenCapture.h"
#include "CelerShell.h"
#include "JsDebugger.h"
#include "LogSink.h"
#include "FileSystem/FileSystem.h"

#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <string>
#include <dirent.h>
#include <sys/stat.h>

#include "esp_system.h"
#include "esp_timer.h"
#include "esp_core_dump.h"
#include "esp_partition.h"
#include "esp_heap_caps.h"
#include "esp_ota_ops.h"
#include "esp_idf_version.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "Boards/Board.h"  // display (captura de tela) e id da placa
#include "../OTA/OtaGuard.h"
#include "../OTA/OtaManager.h"
#include "DebugBridge.h"
#include "../UI/Kui.h"     // TouchInjector (injecao de touch do celerctl)
#include "../WebManager/WebAuth.h"  // senha do web server no `celerctl info`
#include "../Kernel/DeviceStats.h"  // KL_STATS: foto de profiling (top)

#if !defined(CELEROS_VERSION)
#define CELEROS_VERSION "?"
#endif
#if !defined(CELEROS_API_LEVEL)
#define CELEROS_API_LEVEL 0
#endif

namespace {

// Sessao unica: canal que recebeu o ultimo HELLO. O dispatch de comandos e
// serializado por mutex (handlers usam estado global de escrita/OTA); o
// contexto abaixo vale apenas dentro de um dispatch.
HostLink* volatile s_active = nullptr;
int64_t s_lastFrameUs = 0;  // ultimo frame da sessao ativa (guarda da OTA)
SemaphoreHandle_t s_dispatchMutex = nullptr;
HostLink* s_ctxLink = nullptr;  // instancia em dispatch (formato v1/v2, janela)
HostLink::WriteFn s_ctxWriter = nullptr;
HostLink::BaudFn s_ctxBaud = nullptr;

// Buffer do frame de logcat: chamado de tasks arbitrarias, nao pode ser
// stack. Serializado pelo proprio sendLogFrame. Linhas de log tem no maximo
// 256 B (celer_log_vprintf) e o dreno do ring manda blocos de 512: o frame
// nao precisa do MAX_PAYLOAD (eram 4/8 KB de RAM interna parados para algo
// que so carrega texto curto); texto maior sai em varios frames.
SemaphoreHandle_t s_logFrameMutex = nullptr;
constexpr size_t kLogChunk = 512;
uint8_t s_logFrame[8 + 1 + kLogChunk];
// frame de saida do debugger Duktape (KL_DEBUG_DATA, binario puro)
SemaphoreHandle_t s_dbgFrameMutex = nullptr;
constexpr size_t kDbgChunk = 1024;
// frame de saida do gateway USB (KL_RES_DATA): [sid u16][seq u16][dados]
SemaphoreHandle_t s_resFrameMutex = nullptr;
constexpr size_t kResChunk = 512;
uint8_t* s_resFrame = nullptr;
constexpr size_t kResFrameSize = 8 + 4 + kResChunk;
// alocado na 1a sessao de debug (PSRAM quando ha): estatico custava 1 KB
// de RAM interna em todo boot — a mesma que o BLE precisa
uint8_t* s_dbgFrame = nullptr;
constexpr size_t kDbgFrameSize = 8 + kDbgChunk;

HostLink::WriteFn linkWriter() { return s_ctxWriter; }

HostLink::BaudFn linkBaud() { return s_ctxBaud; }
HostLink* linkCtx() { return s_ctxLink; }

// ---------------------------------------------------------------- utilidades

// Frame de resposta: frame inteiro numa unica escrita — logs concorrentes
// (logcat) nunca intercalam bytes no meio de uma resposta. O corpo (status
// + dados) vive no offset fixo apos o maior header (v2 = 8 bytes) e o
// build() da o deslocamento final para o formato da sessao. Quem produz
// dados grandes (READ) escreve direto em txData() e chama sendFrame: sem
// um segundo buffer de 8KB estatico (RAM interna e o que sobra para apps).
// Alocado no HELLO e devolvido quando nenhuma sessao resta (endSession):
// fora do celerctl sao 4/8 KB a mais de heap.
constexpr size_t kTxFrameSize = 8 + 1 + HostLink::MAX_PAYLOAD;
uint8_t* s_txFrame = nullptr;

// PSRAM quando ha (UART/CDC copiam para os proprios buffers), senao interna
uint8_t* linkAlloc(size_t n) {
    uint8_t* p = (uint8_t*)heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (p == nullptr) p = (uint8_t*)heap_caps_malloc(n, MALLOC_CAP_8BIT);
    return p;
}

uint8_t* txData() { return s_txFrame + 9; }  // dados apos o byte de status

void sendFrame(uint8_t cmd, uint8_t status, uint16_t dataLen) {
    HostLink::WriteFn w = linkWriter();
    HostLink* ctx = linkCtx();
    if (w == nullptr || ctx == nullptr || s_txFrame == nullptr) return;  // sem transporte/sessao
    s_txFrame[8] = status;  // primeiro byte do payload da resposta
    size_t n = hostframe::build(s_txFrame, kTxFrameSize, ctx->v2(), cmd, s_txFrame + 8,
                                (uint16_t)(1 + dataLen));
    if (n > 0) w(s_txFrame, n);
}

void respond(uint8_t cmd, uint8_t status, const void* data = nullptr, uint16_t dataLen = 0) {
    if (s_txFrame == nullptr) return;  // fora de sessao (process() so despacha com ela aberta)
    if (data != nullptr && dataLen > 0 && data != txData()) {
        memcpy(txData(), data, dataLen);
    }
    sendFrame(cmd, status, dataLen);
}

void respondError(uint8_t cmd, const char* msg) {
    respond(cmd, 1, msg, (uint16_t)strlen(msg));
}

void le32(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

// extrai string ate '\0'; avanca *p e decresce *len
bool takeString(const uint8_t*& p, uint16_t& len, char* out, size_t outMax) {
    size_t n = 0;
    while (len > 0 && *p != '\0') {
        if (n + 1 >= outMax) return false;
        out[n++] = (char)*p++;
        len--;
    }
    if (len == 0) return false;  // sem terminador
    p++;                         // consome '\0'
    len--;
    out[n] = '\0';
    return true;
}

bool takeU32(const uint8_t*& p, uint16_t& len, uint32_t& out) {
    if (len < 4) return false;
    out = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    p += 4;
    len -= 4;
    return true;
}

const char* boardId() {
    return Board::profile().id;
}

// estado da escrita em curso (uma por vez, como o upload web).
// Em sessoes proto 2 os chunks carregam seq e o CRC e acumulado na chegada
// (verificacao end-to-end no WRITE_END sem reler o arquivo).
FILE* s_wrFile = nullptr;
char s_wrPath[256] = {0};   // destino final
char s_wrTmp[264] = {0};    // "<destino>.part" (escrita atomica)
uint32_t s_wrTotal = 0;
uint16_t s_wrSeq = 0;
uint32_t s_wrCrc = 0;

void closeWrite(bool keep) {
    if (s_wrFile != nullptr) {
        const bool closed = fclose(s_wrFile) == 0;  // flush: disco cheio aqui
        s_wrFile = nullptr;
        if (!keep || !closed) {
            if (s_wrTmp[0]) remove(s_wrTmp);  // nao deixa parcial
        } else if (!FileSystem::renameFile(s_wrTmp, s_wrPath)) {
            remove(s_wrTmp);
        }
    }
    s_wrPath[0] = '\0';
    s_wrTmp[0] = '\0';
    s_wrTotal = 0;
}

// cria diretorios pais do caminho (mesmo comportamento do upload web)
void makeParentDirs(const char* path) {
    char tmp[256];
    strncpy(tmp, path, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';
    for (char* slash = strchr(tmp + 1, '/'); slash != nullptr; slash = strchr(slash + 1, '/')) {
        *slash = '\0';
        if (!FileSystem::exists(tmp)) FileSystem::mkdir(tmp);
        *slash = '/';
    }
}

// Buffer de saida do EXEC com teto e falha checada: std::string crescendo
// ate 32KB ABORTA a placa sem PSRAM quando falta RAM continua
// (-fno-exceptions: new falho = reboot), alem do pico da realocacao
// (bloco velho + novo vivos, ~48KB). malloc/realloc com teto e o padrao
// do projeto para caminhos de dados (ver HttpClient::setBodySink).
struct ExecCtx {
    char* p = nullptr;
    size_t len = 0;
    size_t cap = 0;
    bool oom = false;  // realloc falhou: trunca, nao derruba o aparelho
};

constexpr size_t kExecOutMax = 32 * 1024;

static void execAppend(ExecCtx* e, const char* s, size_t n) {
    if (e->oom || n == 0) return;
    if (e->len + n > kExecOutMax) {
        n = kExecOutMax - e->len;
        if (n == 0) return;  // teto alcancado: resto truncado
    }
    if (e->len + n > e->cap) {
        size_t want = e->cap ? e->cap : 1024;
        while (want < e->len + n) want *= 2;
        char* q = (char*)realloc(e->p, want);
        if (q == nullptr) {
            e->oom = true;
            return;
        }
        e->p = q;
        e->cap = want;
    }
    memcpy(e->p + e->len, s, n);
    e->len += n;
}

void execPrint(void* ctx, const char* fmt, ...) {
    ExecCtx* e = (ExecCtx*)ctx;
    va_list args;
    va_start(args, fmt);
    char buf[512];
    int n = vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    if (n > 0) {
        if (n > (int)sizeof(buf) - 1) n = (int)sizeof(buf) - 1;
        execAppend(e, buf, (size_t)n);
    }
}

// ACK de chunk (proto 2): [u16 proximo seq esperado][u32 total aplicado].
// O host casa pelo seq: maior que o enviado = chunk aplicado; menor/igual
// = duplicado ou atrasado, e o "total" e a verdade para reconciliar.
void ackChunk(uint8_t cmd, uint16_t nextSeq, uint32_t total) {
    uint8_t rec[6];
    rec[0] = (uint8_t)nextSeq;
    rec[1] = (uint8_t)(nextSeq >> 8);
    le32(rec + 2, total);
    respond(cmd, 0, rec, sizeof(rec));
}

// ------------------------------------------------------------------ handlers

void handleHello(const uint8_t* payload, uint16_t len) {
    // Negociacao de formato (HostFrame.h): "CELERCTL2" ativa proto 2; a
    // resposta sai no formato VIGENTE e a sessao troca apos o respond —
    // o host ve "proto 2" e so entao passa a falar v2.
    const bool v2 = len == 9 && memcmp(payload, "CELERCTL2", 9) == 0;
    char id[96];
    if (v2 && linkCtx() != nullptr) {
        snprintf(id, sizeof(id), "CELEROS %s|%s|api %d|proto 2|chunk %u|win %u", CELEROS_VERSION,
                 boardId(), CELEROS_API_LEVEL, (unsigned)HostLink::MAX_PAYLOAD,
                 (unsigned)linkCtx()->window());
    } else {
        snprintf(id, sizeof(id), "CELEROS %s|%s|api %d|proto 1", CELEROS_VERSION, boardId(),
                 CELEROS_API_LEVEL);
    }
    respond(KL_HELLO, 0, id, (uint16_t)strlen(id));
    if (linkCtx() != nullptr) linkCtx()->enableV2(v2);
#if CONFIG_CELEROS_BLUETOOTH
    // gateway USB (Onda B): o canal que abriu a sessao passa a carregar o
    // KL_RES_DATA do PC; Resources derruba os leases dele no endSession
    Resources::usbSetSend([](uint16_t sid, uint16_t seq, const uint8_t* d, size_t n) -> bool {
        return HostLink::sendResFrame(sid, seq, d, n);
    });
    Resources::usbSession(true);
#endif
}

void handleInfo() {
    char ip[16] = "";
    esp_netif_t* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    bool hasIp = false;
    if (netif != nullptr) {
        esp_netif_ip_info_t info;
        hasIp = esp_netif_get_ip_info(netif, &info) == ESP_OK && info.ip.addr != 0;
        if (hasIp) snprintf(ip, sizeof(ip), IPSTR, IP2STR(&info.ip));
    }

    // espaco nos filesystems
    unsigned long long lt = 0, lu = 0, st = 0, su = 0;
    bool hasSd = FileSystem::exists("/sd");
    if (FileSystem::exists("/local")) {
        lt = FileSystem::getTotalSpace("/local");
        lu = FileSystem::getUsedSpace("/local");
    }
    if (hasSd) {
        st = FileSystem::getTotalSpace("/sd");
        su = FileSystem::getUsedSpace("/sd");
    }

    char json[704];
#if CONFIG_CELEROS_DEBUG_BRIDGE
    // mesmo precedente do web_pass: segredo visivel a quem ja tem sessao
    char bridge[72];
    snprintf(bridge, sizeof(bridge), "\"bridge\":{\"port\":%u,\"token\":\"%s\"}",
             (unsigned)DebugBridge::port(), DebugBridge::token());
#else
    const char* bridge = "";
#endif
    // particao rodando x marcada para o proximo boot: o celerctl confirma
    // depois do reboot que a OTA COMUTOU (e detecta rollback do bootloader)
    const esp_partition_t* runPart = esp_ota_get_running_partition();
    const esp_partition_t* bootPart = esp_ota_get_boot_partition();
    // estado da imagem rodando: "pending" = slot novo ainda sem os 30 s de
    // boot sao (confirmPendingOta); um crash agora volta ao slot antigo
    esp_ota_img_states_t imgState = ESP_OTA_IMG_UNDEFINED;
    const char* appState = "valid";
    if (runPart != nullptr && esp_ota_get_state_partition(runPart, &imgState) == ESP_OK &&
        imgState == ESP_OTA_IMG_PENDING_VERIFY) {
        appState = "pending";
    }
    snprintf(json, sizeof(json),
             "{\"version\":\"%s\",\"board\":\"%s\",\"api\":%d,\"proto\":%d,"
             "\"uptime_s\":%llu,\"heap_free\":%u,\"heap_min\":%u,"
             "\"largest_block\":%u,\"psram_free\":%u,\"psram_total\":%u,"
             "\"ip\":\"%s\",\"sd\":%s,"
             "\"app_part\":\"%s\",\"boot_part\":\"%s\",\"app_state\":\"%s\","
             "\"web_user\":\"admin\",\"web_pass\":\"%s\","
             "\"fs\":{\"/local\":{\"total\":%llu,\"used\":%llu},\"/sd\":{\"total\":%llu,\"used\":%llu}},%s}",
             CELEROS_VERSION, boardId(), CELEROS_API_LEVEL,
             (linkCtx() != nullptr && linkCtx()->v2()) ? 2 : 1,
             (unsigned long long)(esp_timer_get_time() / 1000000ULL),
             (unsigned)esp_get_free_heap_size(), (unsigned)esp_get_minimum_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned)heap_caps_get_total_size(MALLOC_CAP_SPIRAM),
             hasIp ? ip : "", hasSd ? "true" : "false",
             runPart != nullptr ? runPart->label : "", bootPart != nullptr ? bootPart->label : "", appState,
             WebAuth::password(),
             lt, lu, st, su, bridge);
    respond(KL_INFO, 0, json, (uint16_t)strlen(json));
}

// KL_STATS: foto de profiling do celerctl top/stats — heap (interna/PSRAM/
// maior bloco), tasks com watermark de stack e runtime acumulado, carga do
// loop e dos presents. Contadores cumulativos: taxa e calculada pelo host
// por delta entre duas fotos. Snapshot no heap (~1.4KB com 32 tasks): o
// handler roda na task do canal, de stack apertada.
void handleStats() {
    DeviceStats::Snapshot* snap = (DeviceStats::Snapshot*)malloc(sizeof(DeviceStats::Snapshot));
    if (snap == nullptr || !DeviceStats::take(*snap)) {
        free(snap);
        respondError(KL_STATS, "sem memoria");
        return;
    }
    size_t n = DeviceStats::toJson(*snap, (char*)txData(), HostLink::MAX_PAYLOAD - 1);
    free(snap);
    if (n == 0) {
        respondError(KL_STATS, "stats nao coube");
        return;
    }
    sendFrame(KL_STATS, 0, (uint16_t)n);
}

void handleLs(const uint8_t* payload, uint16_t len) {
    char path[256];
    if (!takeString(payload, len, path, sizeof(path)) || !CelerShell::pathAllowed(path)) {
        respondError(KL_LS, "caminho invalido");
        return;
    }
    // cursor opcional (u32): entrada por onde continuar. Pedido sem cursor
    // (hosts antigos) mantem a resposta inteira num frame, como sempre.
    uint32_t cursor = 0;
    const bool paged = len >= 4 && takeU32(payload, len, cursor);
    DIR* dir = opendir(path);
    if (dir == nullptr) {
        respondError(KL_LS, "nao e diretorio");
        return;
    }
    std::string out;
    uint16_t count = 0;
    struct dirent* ent;
    uint32_t served = 0;  // entradas validas ja vistas (cursor conta estas)
    bool eof = true;
    const size_t room = HostLink::MAX_PAYLOAD - 1 - (paged ? 6 : 2);
    while ((ent = readdir(dir)) != nullptr) {
        if (ent->d_name[0] == '.') continue;  // ocultos fora (como sempre)
        if (served++ < cursor) continue;      // paginacao: pula o ja servido
        std::string full = std::string(path) + "/" + ent->d_name;
        struct stat st;
        memset(&st, 0, sizeof(st));
        bool isDir = false;
        uint32_t size = 0, mtime = 0;
        if (stat(full.c_str(), &st) == 0) {
            isDir = S_ISDIR(st.st_mode);
            size = (uint32_t)st.st_size;
            mtime = (uint32_t)st.st_mtime;
        }
        uint8_t rec[10 + 256];
        rec[0] = isDir ? 1 : 0;
        le32(rec + 1, size);
        le32(rec + 5, mtime);
        size_t nameLen = strlen(ent->d_name);
        rec[9] = (uint8_t)nameLen;
        memcpy(rec + 10, ent->d_name, nameLen);
        if (out.size() + 10 + nameLen > room) {
            eof = false;  // encheu o frame: o resto fica para o proximo cursor
            break;
        }
        out.append((const char*)rec, 10 + nameLen);
        count++;
    }
    closedir(dir);

    // resposta: [u32 next (0 = fim, so no modo paginado)] + u16 n + entradas
    std::string body;
    if (paged) {
        // cursor + count = indice da entrada que NAO coube (served ja a
        // contou antes do break). O +1 antigo pulava 1 arquivo por pagina.
        uint32_t next = eof ? 0 : (cursor + count);
        body.resize(4 + 2 + out.size());
        le32((uint8_t*)body.data(), next);
        body[4] = (char)(uint8_t)count;
        body[5] = (char)(uint8_t)(count >> 8);
        memcpy(body.data() + 6, out.data(), out.size());
    } else {
        body.resize(2 + out.size());
        body[0] = (char)(uint8_t)count;
        body[1] = (char)(uint8_t)(count >> 8);
        memcpy(body.data() + 2, out.data(), out.size());
    }
    respond(KL_LS, 0, body.data(), (uint16_t)body.size());
}

void handleStat(const uint8_t* payload, uint16_t len) {
    char path[256];
    if (!takeString(payload, len, path, sizeof(path)) || !CelerShell::pathAllowed(path)) {
        respondError(KL_STAT, "caminho invalido");
        return;
    }
    struct stat st;
    memset(&st, 0, sizeof(st));
    if (stat(path, &st) != 0) {
        respond(KL_STAT, 0, "\x00", 1);  // exists=0
        return;
    }
    uint8_t rec[11];
    rec[0] = 1;                                   // exists
    rec[1] = S_ISDIR(st.st_mode) ? 1 : 0;         // isDir
    le32(rec + 2, (uint32_t)st.st_size);
    le32(rec + 6, (uint32_t)st.st_mtime);
    respond(KL_STAT, 0, rec, sizeof(rec));
}

void handleRead(const uint8_t* payload, uint16_t len) {
    char path[256];
    uint32_t offset = 0, want = 0;
    if (!takeString(payload, len, path, sizeof(path)) || !takeU32(payload, len, offset) ||
        !takeU32(payload, len, want) || !CelerShell::pathAllowed(path)) {
        respondError(KL_READ, "pedido malformado");
        return;
    }
    // proto 2 prefixa o offset na resposta: o host pipelina N READs e
    // casa cada uma pelo offset (respostas fora de ordem nao confundem)
    const bool v2 = linkCtx() != nullptr && linkCtx()->v2();
    const uint16_t room = (uint16_t)(HostLink::MAX_PAYLOAD - 1 - (v2 ? 4 : 0));
    if (want > room) want = room;

    FILE* f = fopen(path, "rb");
    if (f == nullptr) {
        respondError(KL_READ, "nao abriu");
        return;
    }
    size_t got = 0;
    uint8_t* dst = txData();
    if (v2) {
        le32(dst, offset);
        dst += 4;
    }
    if (fseek(f, (long)offset, SEEK_SET) == 0) {
        got = fread(dst, 1, want, f);  // direto no frame de resposta
    }
    fclose(f);
    // o frame acrescenta o status; EOF e sinalizado por got < want
    sendFrame(KL_READ, 0, (uint16_t)((v2 ? 4 : 0) + got));
}

void handleWriteBegin(const uint8_t* payload, uint16_t len) {
    char path[256];
    if (!takeString(payload, len, path, sizeof(path)) || !CelerShell::pathAllowed(path)) {
        respondError(KL_WRITE_BEGIN, "caminho invalido");
        return;
    }
    closeWrite(false);  // cancela escrita anterior por seguranca
    makeParentDirs(path);
    // Escreve em <destino>.part e so troca no WRITE_END: um push
    // interrompido (cabo/WiFi) nao trunca mais o main.js/app.json antigo.
    const int tn = snprintf(s_wrTmp, sizeof(s_wrTmp), "%s.part", path);
    if (tn < 0 || (size_t)tn >= sizeof(s_wrTmp)) {
        respondError(KL_WRITE_BEGIN, "caminho longo demais");
        return;
    }
    s_wrFile = fopen(s_wrTmp, "wb");
    if (s_wrFile == nullptr) {
        s_wrTmp[0] = '\0';
        respondError(KL_WRITE_BEGIN, "nao abriu para escrita");
        return;
    }
    snprintf(s_wrPath, sizeof(s_wrPath), "%s", path);
    s_wrTotal = 0;
    s_wrSeq = 0;
    s_wrCrc = 0;
    respond(KL_WRITE_BEGIN, 0);
}

void handleWriteChunk(const uint8_t* payload, uint16_t len) {
    if (s_wrFile == nullptr) {
        respondError(KL_WRITE_CHUNK, "escrita nao iniciada");
        return;
    }
    const uint8_t* data = payload;
    uint16_t n = len;
    if (linkCtx() != nullptr && linkCtx()->v2()) {
        // proto 2: [seq u16][dados]; so aplica o seq esperado — reenvio de
        // chunk cujo ACK se perdeu nao duplica bytes no arquivo
        if (len < 2) {
            respondError(KL_WRITE_CHUNK, "chunk sem seq");
            return;
        }
        uint16_t seq = (uint16_t)(payload[0] | (payload[1] << 8));
        if (seq != s_wrSeq) {
            ackChunk(KL_WRITE_CHUNK, s_wrSeq, s_wrTotal);
            return;
        }
        data = payload + 2;
        n = (uint16_t)(len - 2);
        if (n > 0) s_wrCrc = hostframe::crc32(data, n, s_wrCrc);
        s_wrSeq++;
    }
    if (n > 0 && fwrite(data, 1, n, s_wrFile) != n) {
        closeWrite(false);
        respondError(KL_WRITE_CHUNK, "disco cheio/erro");
        return;
    }
    s_wrTotal += n;
    if (linkCtx() != nullptr && linkCtx()->v2()) {
        ackChunk(KL_WRITE_CHUNK, s_wrSeq, s_wrTotal);
        return;
    }
    respond(KL_WRITE_CHUNK, 0);
}

void handleWriteEnd(const uint8_t* payload, uint16_t len) {
    if (s_wrFile == nullptr) {
        respondError(KL_WRITE_END, "escrita nao iniciada");
        return;
    }
    if (linkCtx() != nullptr && linkCtx()->v2()) {
        // [u32 crc do host][u32 tamanho do host] — verificacao de ponta a
        // ponta: divergencia aborta e remove o parcial
        uint32_t crcHost = 0, sizeHost = 0;
        if (len < 8 || !takeU32(payload, len, crcHost) || !takeU32(payload, len, sizeHost)) {
            respondError(KL_WRITE_END, "WRITE_END v2 sem crc/tamanho");
            return;
        }
        if (sizeHost != s_wrTotal || crcHost != s_wrCrc) {
            closeWrite(false);
            respondError(KL_WRITE_END, "crc/tamanho divergem no fim da escrita");
            return;
        }
        uint32_t total = s_wrTotal, crc = s_wrCrc;
        closeWrite(true);
        uint8_t rec[8];
        le32(rec, total);
        le32(rec + 4, crc);
        respond(KL_WRITE_END, 0, rec, sizeof(rec));
        return;
    }
    uint32_t total = s_wrTotal;
    closeWrite(true);
    uint8_t rec[4];
    le32(rec, total);
    respond(KL_WRITE_END, 0, rec, sizeof(rec));
}

// apaga diretorio com conteudo (depth limita a recursao: stack curta e
// LittleFS raso — apps ficam em 2-3 niveis)
bool removeTree(const char* path, int depth) {
    if (depth <= 0 || !FileSystem::isDirectory(path)) return false;
    DIR* d = opendir(path);
    if (d == nullptr) return false;
    struct dirent* ent;
    bool ok = true;
    while ((ent = readdir(d)) != nullptr) {
        if (ent->d_name[0] == '.') continue;
        char full[512];
        snprintf(full, sizeof(full), "%s/%s", path, ent->d_name);
        if (FileSystem::isDirectory(full)) {
            if (!removeTree(full, depth - 1)) ok = false;
        } else if (!FileSystem::deleteFile(full)) {
            ok = false;
        }
    }
    closedir(d);
    return ok && FileSystem::rmdir(path);
}

void handleWriteAbort() {
    // cancelamento explicito da ferramenta: sem isso a escrita ficava
    // pendurada ate o proximo WRITE_BEGIN (que cancela por seguranca)
    if (s_wrFile != nullptr) {
        closeWrite(false);  // remove o parcial
        celer_log_println("[HL] escrita cancelada pela ferramenta");
    }
    respond(KL_WRITE_ABORT, 0);
}

void handleDelete(const uint8_t* payload, uint16_t len) {
    char path[256];
    if (!takeString(payload, len, path, sizeof(path)) || !CelerShell::pathAllowed(path)) {
        respondError(KL_DELETE, "caminho invalido");
        return;
    }
    // flag opcional: 1 = apaga diretorio com todo o conteudo (um comando
    // no lugar do loop arquivo-a-arquivo que o `apps rm` fazia)
    bool recursive = len >= 1 && payload[0] == 1;
    if (recursive && FileSystem::isDirectory(path)) {
        respond(KL_DELETE, removeTree(path, 6) ? 0 : 1, nullptr, 0);
        return;
    }
    // arquivo, ou diretorio VAZIO (o `apps rm` apaga o conteudo e depois a
    // pasta: o unlink do LittleFS recusa diretorio e a pasta ficava orfa)
    bool ok = FileSystem::deleteFile(path) || (FileSystem::isDirectory(path) && FileSystem::rmdir(path));
    respond(KL_DELETE, ok ? 0 : 1, nullptr, 0);
}

void handleMkdir(const uint8_t* payload, uint16_t len) {
    char path[256];
    if (!takeString(payload, len, path, sizeof(path)) || !CelerShell::pathAllowed(path)) {
        respondError(KL_MKDIR, "caminho invalido");
        return;
    }
    makeParentDirs(path);
    respond(KL_MKDIR, FileSystem::mkdir(path) ? 0 : 1, nullptr, 0);
}

void handleRename(const uint8_t* payload, uint16_t len) {
    char from[256], to[256];
    if (!takeString(payload, len, from, sizeof(from)) || !takeString(payload, len, to, sizeof(to)) ||
        !CelerShell::pathAllowed(from) || !CelerShell::pathAllowed(to)) {
        respondError(KL_RENAME, "caminho invalido");
        return;
    }
    makeParentDirs(to);
    respond(KL_RENAME, FileSystem::renameFile(from, to) ? 0 : 1, nullptr, 0);
}

void handleExec(const uint8_t* payload, uint16_t len) {
    char line[256];
    if (len > sizeof(line) - 1) len = sizeof(line) - 1;
    memcpy(line, payload, len);
    line[len] = '\0';

    ExecCtx ctx;
    int code = CelerShell::execute(line, execPrint, &ctx);

    uint8_t rec[5];
    rec[0] = (uint8_t)code;
    le32(rec + 1, (uint32_t)ctx.len);
    respond(KL_EXEC, 0, rec, sizeof(rec));
    if (ctx.len > 0) {
        // saida grande e enviada como frames de continuacao
        size_t off = 0;
        while (off < ctx.len) {
            size_t n = ctx.len - off;
            if (n > HostLink::MAX_PAYLOAD - 1) n = HostLink::MAX_PAYLOAD - 1;
            respond(KL_EXEC_CONT, 0, ctx.p + off, (uint16_t)n);
            off += n;
        }
    }
    free(ctx.p);
}

void handleReboot() {
    uint8_t rec[4];
    le32(rec, 300);  // ms ate reiniciar
    respond(KL_REBOOT, 0, rec, sizeof(rec));
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
}

void handleSetBaud(const uint8_t* payload, uint16_t len) {
    uint32_t baud = 0;
    if (!takeU32(payload, len, baud) || linkBaud() == nullptr) {
        respondError(KL_SET_BAUD, "troca de baud nao suportada neste canal");
        return;
    }
    uint8_t rec[4];
    le32(rec, baud);
    respond(KL_SET_BAUD, 0, rec, sizeof(rec));
    // da tempo do ACK sair da FIFO antes de mudar o baud
    vTaskDelay(pdMS_TO_TICKS(20));
    linkBaud()(baud);
}

// ------------------------------------------------------------------- logcat

void handleLogOn() {
    celer_logcat_set(true);
    respond(KL_LOG_ON, 0);
}

void handleLogOff() {
    celer_logcat_set(false);
    respond(KL_LOG_OFF, 0);
}

// Dump do ring SEM consumir (celerctl logcat --dump): responde o total e
// emite o historico em frames KL_LOG_DATA logo em seguida — o host le ate
// fechar o total, sem janela de silencio. O LOG_ON (stream ao vivo) segue
// drenando como sempre: celerctl antigo nao muda nada, o novo copia antes.
void handleLogDump() {
    uint8_t rec[4];
    le32(rec, (uint32_t)celer_log_ring_size());
    respond(KL_LOG_DUMP, 0, rec, sizeof(rec));
    celer_log_ring_forEach([](const char* chunk, size_t n) {
        HostLink::sendLogFrame(chunk, n);
    });
}

// ---------------------------------------------------------------- debugger

// Arma o attach do debugger Duktape no PROXIMO app (celerctl debug roda o
// app depois de armar): u8 1=on 0=off, resposta devolve o estado vigente.
void handleDebugCtl(const uint8_t* payload, uint16_t len) {
    // o proxy so manda 1 depois do accept: armar = cliente conectado
    bool on = len >= 1 && payload[0] != 0;
    JsDebugger::setClient(on);
    uint8_t st = JsDebugger::requested() ? 1 : 0;
    respond(KL_DEBUG_CTL, 0, &st, sizeof(st));
}

// Mensagem do cliente de debug (protocolo dmsg binario): produz no stream
// buffer consumido pela task do app. SEM resposta — o fluxo do debugger e
// assincrono (o cliente fala com o runtime, nao com o celerctl).
void handleDebugData(const uint8_t* payload, uint16_t len) {
    JsDebugger::feedHost(payload, len);
}

// ---------------------------------------------------------------------- OTA

esp_ota_handle_t s_ota = 0;
const esp_partition_t* s_otaPart = nullptr;
uint32_t s_otaWritten = 0;
uint16_t s_otaSeq = 0;
uint32_t s_otaCrc = 0;
// Ultima OTA fechada com sucesso (crc/tamanho do host): um OTA_END repetido
// porque a resposta se perdeu no caminho (cabo/USB-JTAG) confirma de novo
// em vez de responder "OTA nao iniciada" — o host achava que falhou com o
// boot ja marcado e abortava/reportava erro (bancada 2026-10-07)
bool s_otaDone = false;
uint32_t s_otaDoneCrc = 0, s_otaDoneSize = 0;

void handleOtaBegin() {
    if (s_ota != 0) {
        esp_ota_abort(s_ota);  // OTA nossa pendente (sessao morreu no meio)
        s_ota = 0;
    } else if (!OtaGuard::acquire()) {
        // upload web / hub escrevendo o slot agora: recusa em vez de pisar
        respondError(KL_OTA_BEGIN, "outra gravacao OTA em curso (web/hub?)");
        return;
    }
    s_otaPart = esp_ota_get_next_update_partition(nullptr);
    if (s_otaPart == nullptr) {
        OtaGuard::release();
        respondError(KL_OTA_BEGIN, "sem particao OTA disponivel");
        return;
    }
    // App aberto disputa flash/PSRAM com as gravacoes e o enlace perde
    // bytes no meio do flash: sai dele antes do primeiro esp_ota_begin
    // (bancada 2026-10-10 — push com jogo rodando caia em "payload grande
    // demais"). Aqui o guard ja esta seguro: recusado acima nao derruba app.
    OtaManager::evictRunningApp();
    esp_err_t err = esp_ota_begin(s_otaPart, OTA_SIZE_UNKNOWN, &s_ota);
    if (err != ESP_OK) {
        s_ota = 0;
        OtaGuard::release();
        respondError(KL_OTA_BEGIN, esp_err_to_name(err));
        return;
    }
    s_otaWritten = 0;
    s_otaSeq = 0;
    s_otaCrc = 0;
    s_otaDone = false;
    respond(KL_OTA_BEGIN, 0, s_otaPart->label, (uint16_t)strlen(s_otaPart->label));
}

void handleOtaChunk(const uint8_t* payload, uint16_t len) {
    if (s_ota == 0) {
        respondError(KL_OTA_CHUNK, "OTA nao iniciada");
        return;
    }
    const uint8_t* data = payload;
    uint16_t n = len;
    if (linkCtx() != nullptr && linkCtx()->v2()) {
        // [seq u16][dados] — mesma janela do WRITE_CHUNK: reenvio cujo ACK
        // se perdeu nao grava 2x na particao (o ACK traz o total aplicado)
        if (len < 2) {
            respondError(KL_OTA_CHUNK, "chunk sem seq");
            return;
        }
        uint16_t seq = (uint16_t)(payload[0] | (payload[1] << 8));
        if (seq != s_otaSeq) {
            ackChunk(KL_OTA_CHUNK, s_otaSeq, s_otaWritten);
            return;
        }
        data = payload + 2;
        n = (uint16_t)(len - 2);
        if (n > 0) s_otaCrc = hostframe::crc32(data, n, s_otaCrc);
        s_otaSeq++;
    }
    if (n > 0 && esp_ota_write(s_ota, data, n) != ESP_OK) {
        esp_ota_abort(s_ota);
        s_ota = 0;
        OtaGuard::release();
        respondError(KL_OTA_CHUNK, "falha ao gravar particao");
        return;
    }
    s_otaWritten += n;
    if (linkCtx() != nullptr && linkCtx()->v2()) {
        ackChunk(KL_OTA_CHUNK, s_otaSeq, s_otaWritten);
        return;
    }
    respond(KL_OTA_CHUNK, 0);
}

void handleOtaEnd(const uint8_t* payload, uint16_t len) {
    if (s_ota == 0) {
        uint32_t c = 0, z = 0;
        if (s_otaDone && len >= 8 && takeU32(payload, len, c) && takeU32(payload, len, z) &&
            c == s_otaDoneCrc && z == s_otaDoneSize) {
            uint8_t again[4];
            le32(again, s_otaDoneSize);
            respond(KL_OTA_END, 0, again, sizeof(again));  // reenvio do END ja aplicado
            return;
        }
        respondError(KL_OTA_END, "OTA nao iniciada");
        return;
    }
    if (linkCtx() != nullptr && linkCtx()->v2()) {
        // [u32 crc do host][u32 tamanho do host] — imagem corrompida no
        // caminho nunca chega a marca de boot
        uint32_t crcHost = 0, sizeHost = 0;
        if (len < 8 || !takeU32(payload, len, crcHost) || !takeU32(payload, len, sizeHost)) {
            respondError(KL_OTA_END, "OTA_END v2 sem crc/tamanho");
            return;
        }
        if (sizeHost != s_otaWritten || crcHost != s_otaCrc) {
            esp_ota_abort(s_ota);
            s_ota = 0;
            OtaGuard::release();
            respondError(KL_OTA_END, "crc/tamanho divergem no fim da OTA");
            return;
        }
    }
    esp_err_t errEnd = esp_ota_end(s_ota);
    s_ota = 0;
    // Release SO depois de marcar a particao: entre o release e o
    // set_boot_partition outro escritor podia abrir a mesma particao e
    // apaga-la embaixo da imagem recem-verificada.
    if (errEnd != ESP_OK) {
        OtaGuard::release();
        respondError(KL_OTA_END, esp_err_to_name(errEnd));
        return;
    }
    if (esp_ota_set_boot_partition(s_otaPart) != ESP_OK) {
        OtaGuard::release();
        respondError(KL_OTA_END, "falha ao marcar boot partition");
        return;
    }
    OtaGuard::release();  // sessao fechada: libera o slot p/ web/hub
    s_otaDone = true;
    s_otaDoneCrc = s_otaCrc;
    s_otaDoneSize = s_otaWritten;
    uint8_t rec[4];
    le32(rec, s_otaWritten);
    respond(KL_OTA_END, 0, rec, sizeof(rec));  // reboot fica por conta do host
}

void handleOtaAbort() {
    if (s_ota != 0) {
        esp_ota_abort(s_ota);
        s_ota = 0;
        OtaGuard::release();
    }
    respond(KL_OTA_ABORT, 0);
}

// ---------------------------------------------------------------- screenshot

#if CONFIG_CELEROS_UI
void handleScreenshot(const uint8_t* payload, uint16_t len) {
    // Pedido: u8 formato opcional (1 = RLE). Resposta: u16 w + u16 h + u8
    // formato; depois chunks KL_SCR_DATA. Cliente antigo nao manda payload e
    // recebe o cru de sempre (e ignora o byte extra do cabecalho).
    //   cru: pixels RGB565 LE
    //   RLE: pares {u16 contagem, u16 pixel} LE — a UI e quase so cor chapada:
    //        ~10x menos bytes (captura de 5 s a 921600 vira < 1 s, e a 115200
    //        deixa de levar 40 s)
    // Leitura linha a linha: sem buffer do tamanho da tela (a CYD, sem PSRAM,
    // nao conseguia capturar).
    const bool rle = len >= 1 && payload[0] == 1;
    CelerDisplay& tft = Board::display();
    const uint16_t w = (uint16_t)tft.width();
    const uint16_t h = (uint16_t)tft.height();
    uint8_t head[5] = {(uint8_t)w, (uint8_t)(w >> 8), (uint8_t)h, (uint8_t)(h >> 8), (uint8_t)(rle ? 1 : 0)};
    respond(KL_SCREENSHOT, 0, head, sizeof(head));
    // Leitura pela task da UI (ScreenCapture): ler o display desta task
    // corria com o desenho da UI — linhas deslocadas na captura. Blocos
    // montados direto no frame de resposta (sem 4KB extras de heap).
    const size_t cap = (HostLink::MAX_PAYLOAD - 1) & ~(size_t)3;  // multiplo de 4
    ScreenCapture::stream(rle, txData(), cap, [](const uint8_t*, size_t n) {
        if (linkWriter() == nullptr) return false;
        sendFrame(KL_SCR_DATA, 0, (uint16_t)n);
        return true;
    });
}
#else
void handleScreenshot(const uint8_t*, uint16_t) {
    // Sem vidro nao ha tela para capturar: o cliente recebe o erro claro
    respondError(KL_SCREENSHOT, "placa sem video");
}
#endif

// ------------------------------------------------------------- touch inject

void handleTouch(const uint8_t* payload, uint16_t len) {
#if CONFIG_CELEROS_UI
    // u8 n + n entradas {u8 down, u16 x, u16 y, u16 delayMs} (7 bytes) ou
    // {u8 down, u16 x, u16 y, u16 delayMs, u8 finger} (8 bytes, multitouch:
    // o cliente so usa 8 quando ha dedo != 0, entao firmware velho nunca
    // ve payload novo)
    if (len < 1) {
        respondError(KL_TOUCH, "payload vazio");
        return;
    }
    uint8_t n = payload[0];
    if (n == 0) {
        respondError(KL_TOUCH, "payload malformado");
        return;
    }
    uint8_t stride;
    if ((size_t)len >= 1 + (size_t)n * 8) stride = 8;
    else if ((size_t)len >= 1 + (size_t)n * 7) stride = 7;
    else {
        respondError(KL_TOUCH, "payload malformado");
        return;
    }
    if (n > 16) n = 16;
    kui::TouchInjector::Sample s[16];
    for (int i = 0; i < n; i++) {
        const uint8_t* p = payload + 1 + i * stride;
        s[i].down = p[0] != 0;
        s[i].x = (uint16_t)(p[1] | (p[2] << 8));
        s[i].y = (uint16_t)(p[3] | (p[4] << 8));
        s[i].delayMs = (uint16_t)(p[5] | (p[6] << 8));
        s[i].finger = stride == 8 ? p[7] : 0;
    }
    if (!kui::TouchInjector::push(s, n)) {
        respondError(KL_TOUCH, "fila de touch cheia");
        return;
    }
    respond(KL_TOUCH, 0);
#else
    (void)payload; (void)len;
    respondError(KL_TOUCH, "placa sem video");
#endif
}


// Coredump da particao dedicada (ELF): u32 tamanho no primeiro frame,
// binario em chunks KL_COREDUMP_DATA. Analisavel no PC com
// `idf.py coredump-info -c <arquivo>` / `coredump-decode`.
// Flag opcional: 1 = nao apagar apos a leitura (reler/acompanhar).
void handleCoredump(const uint8_t* payload, uint16_t len) {
    const bool keep = len >= 1 && payload[0] == 1;
    size_t addr = 0, size = 0;
    if (esp_core_dump_image_get(&addr, &size) != ESP_OK || size == 0) {
        respondError(KL_COREDUMP, "sem coredump gravado");
        return;
    }
    // IDF 6: image_get devolve endereco FISICO na flash. Leitura vai de
    // esp_partition_read: o mmap da particao de coredump falha no watch
    // (32 MB, particao alta 0x1ff0000 — sem slot/page de MMU livre para ela)
    // e os chunks cabem no payload do HostLink do mesmo jeito.
    const esp_partition_t* part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, nullptr);
    if (part == nullptr || addr < part->address ||
        addr + size > part->address + part->size) {
        respondError(KL_COREDUMP, "coredump fora da particao");
        return;
    }
    uint8_t head[4] = {(uint8_t)size, (uint8_t)(size >> 8),
                       (uint8_t)(size >> 16), (uint8_t)(size >> 24)};
    respond(KL_COREDUMP, 0, head, sizeof(head));

    // Leitura direto no corpo do frame de resposta (como o READ): sem um
    // buffer estatico de MAX_PAYLOAD so para o coredump
    const size_t cap = HostLink::MAX_PAYLOAD;  // txData() tem MAX_PAYLOAD apos o status
    size_t off = 0;
    bool sentAll = true;
    while (off < size && linkWriter() != nullptr) {
        size_t rest = size - off;
        uint16_t chunk = (uint16_t)((rest > cap) ? cap : rest);
        if (esp_partition_read(part, (addr - part->address) + off, txData(), chunk) != ESP_OK) {
            sentAll = false;
            break;
        }
        sendFrame(KL_COREDUMP_DATA, 0, chunk);
        off += chunk;
    }
    if (off < size) sentAll = false;  // leitor desconectou no meio

    // Dump consumido apaga a particao: sem isso o MESMO dump velho voltava a
    // ser reportado em todo reboot ate ser sobrescrito por um novo crash.
    if (sentAll && !keep) {
        esp_core_dump_image_erase();
        celer_log_println("[HL] coredump lido e apagado");
    }
}

void handleResCtl(const uint8_t* payload, uint16_t len) {
#if CONFIG_CELEROS_BLUETOOTH
    usbres::Req rq;
    if (!usbres::decodeReq(payload, len, &rq)) {
        respondError(KL_RES_CTL, "ctl malformado");
        return;
    }
    // [reqId][len u16] + corpo no MESMO buffer (era 512 B de corpo e outra
    // copia de 515 B na pilha da task do canal): o catalogo da malha (16 nos
    // com meta) estourava e voltava "vazio". Alocacao preguicosa na PSRAM
    // (padrao do s_dbgFrame): 1,5 KB estatico em RAM interna pesava no
    // relogio em todo boot. dispatch segura o mutex: uma task por vez.
    constexpr size_t kResCtlBuf = 3 + 1536;
    static uint8_t* buf = nullptr;
    if (buf == nullptr) {
        buf = (uint8_t*)heap_caps_malloc(kResCtlBuf, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (buf == nullptr) buf = (uint8_t*)malloc(kResCtlBuf);
    }
    if (buf == nullptr) {
        respondError(KL_RES_CTL, "sem memoria");
        return;
    }
    const int n = Resources::usbCtl(rq.subop, rq.body, rq.len, buf + 3, kResCtlBuf - 3);
    if (n < 0) {
        respondError(KL_RES_CTL, "recusado");
        return;
    }
    buf[0] = rq.reqId;
    buf[1] = (uint8_t)((unsigned)n >> 8);
    buf[2] = (uint8_t)n;
    // respond copia data para o frame de resposta APOS o byte de status
    respond(KL_RES_CTL, 0, buf, (uint16_t)(3 + n));
#else
    respondError(KL_RES_CTL, "sem bluetooth neste aparelho");
#endif
}

void dispatch(uint8_t cmd, const uint8_t* payload, uint16_t len) {
    switch (cmd) {
        case KL_HELLO: handleHello(payload, len); break;
        case KL_INFO: handleInfo(); break;
        case KL_LS: handleLs(payload, len); break;
        case KL_STAT: handleStat(payload, len); break;
        case KL_READ: handleRead(payload, len); break;
        case KL_WRITE_BEGIN: handleWriteBegin(payload, len); break;
        case KL_WRITE_CHUNK: handleWriteChunk(payload, len); break;
        case KL_WRITE_END: handleWriteEnd(payload, len); break;
        case KL_WRITE_ABORT: handleWriteAbort(); break;
        case KL_DELETE: handleDelete(payload, len); break;
        case KL_MKDIR: handleMkdir(payload, len); break;
        case KL_RENAME: handleRename(payload, len); break;
        case KL_EXEC: handleExec(payload, len); break;
        case KL_REBOOT: handleReboot(); break;
        case KL_SET_BAUD: handleSetBaud(payload, len); break;
        case KL_LOG_ON: handleLogOn(); break;
        case KL_LOG_OFF: handleLogOff(); break;
        case KL_LOG_DUMP: handleLogDump(); break;
        case KL_OTA_BEGIN: handleOtaBegin(); break;
        case KL_OTA_CHUNK: handleOtaChunk(payload, len); break;
        case KL_OTA_END: handleOtaEnd(payload, len); break;
        case KL_OTA_ABORT: handleOtaAbort(); break;
        case KL_SCREENSHOT: handleScreenshot(payload, len); break;
        case KL_COREDUMP: handleCoredump(payload, len); break;
        case KL_TOUCH: handleTouch(payload, len); break;
        case KL_DEBUG_CTL: handleDebugCtl(payload, len); break;
        case KL_DEBUG_DATA: handleDebugData(payload, len); break;
        case KL_STATS: handleStats(); break;
        case KL_RES_CTL: handleResCtl(payload, len); break;
        case KL_RES_DATA:  // so sai do device (como o LOG_DATA); host->device nao existe
            respondError(cmd, "KL_RES_DATA e device->host; use KL_RES_CTL"); break;
        default: respondError(cmd, "opcode desconhecido"); break;
    }
}

}  // namespace

HostLink::HostLink(WriteFn writer, BaudFn baudHook, uint8_t window, uint32_t silenceUs)
    : m_writer(writer), m_baudHook(baudHook), m_window(window), m_parser(m_small, SMALL_PAYLOAD) {
    m_parser.setSilenceUs((int64_t)silenceUs);
    if (s_dispatchMutex == nullptr) s_dispatchMutex = xSemaphoreCreateMutex();
    if (s_logFrameMutex == nullptr) s_logFrameMutex = xSemaphoreCreateMutex();
    if (s_dbgFrameMutex == nullptr) s_dbgFrameMutex = xSemaphoreCreateMutex();
    if (s_resFrameMutex == nullptr) s_resFrameMutex = xSemaphoreCreateMutex();
}

void HostLink::trampoline(void* ctx, uint8_t cmd, const uint8_t* payload, uint16_t len) {
    static_cast<HostLink*>(ctx)->process(cmd, payload, len);
}

void HostLink::process(uint8_t cmd, const uint8_t* payload, uint16_t len) {
    if (s_dispatchMutex != nullptr) xSemaphoreTake(s_dispatchMutex, portMAX_DELAY);
    s_ctxWriter = m_writer;
    s_ctxBaud = m_baudHook;
    s_ctxLink = this;
    if (cmd == KL_HELLO) {
        if (!openBuffers()) {
            sendShortError(cmd, "sem memoria p/ sessao");
            s_ctxWriter = nullptr;
            s_ctxBaud = nullptr;
            s_ctxLink = nullptr;
            if (s_dispatchMutex != nullptr) xSemaphoreGive(s_dispatchMutex);
            return;
        }
        // ultimo HELLO ganha a sessao — menos no meio de uma OTA viva em
        // outro canal: o "celerctl info" de um terminal (ou um monitor) pela
        // USB roubava a sessao da OTA por WiFi e ela morria em "sessao ativa
        // em outro canal" (bancada 2026-10-07). Canal parado ha > 5 s libera
        // (cabo puxado no meio: o proximo OTA_BEGIN aborta a gravacao velha).
        if (s_active != nullptr && s_active != this && s_ota != 0 &&
            esp_timer_get_time() - s_lastFrameUs < 5000000) {
            sendShortError(cmd, "OTA em curso em outro canal");
            s_ctxWriter = nullptr;
            s_ctxBaud = nullptr;
            s_ctxLink = nullptr;
            if (s_dispatchMutex != nullptr) xSemaphoreGive(s_dispatchMutex);
            return;
        }
        s_active = this;
    } else if (s_active != this) {
        // frames de outro canal (ex. UART0 de uma board USB-nativa): a
        // resposta de erro vai pelo canal de origem, sem tocar a sessao
        sendShortError(cmd, "sessao ativa em outro canal");
        s_ctxWriter = nullptr;
        s_ctxBaud = nullptr;
        s_ctxLink = nullptr;
        if (s_dispatchMutex != nullptr) xSemaphoreGive(s_dispatchMutex);
        return;
    }
    s_lastFrameUs = esp_timer_get_time();
    dispatch(cmd, payload, len);
    s_ctxWriter = nullptr;
    s_ctxBaud = nullptr;
    s_ctxLink = nullptr;
    if (s_dispatchMutex != nullptr) xSemaphoreGive(s_dispatchMutex);
}

HostLink* HostLink::active() {
    return s_active;
}

bool HostLink::openBuffers() {
    if (m_big == nullptr) {
        m_big = linkAlloc(MAX_PAYLOAD);
        if (m_big == nullptr) return false;
        // dentro do callback do parser: o HELLO corrente segue no buffer
        // pequeno (o deliver ja terminou de usa-lo); o proximo frame cai aqui
        m_parser.setBuffer(m_big, MAX_PAYLOAD);
    }
    if (s_txFrame == nullptr) {
        s_txFrame = linkAlloc(kTxFrameSize);
        if (s_txFrame == nullptr) return false;
    }
    return true;
}

void HostLink::sendShortError(uint8_t cmd, const char* msg) {
    if (s_txFrame != nullptr) {  // sessao de pe: caminho normal
        respondError(cmd, msg);
        return;
    }
    uint8_t frame[8 + 1 + 40];
    size_t len = strlen(msg);
    if (len > 40) len = 40;
    frame[8] = 1;  // status erro
    memcpy(frame + 9, msg, len);
    size_t n = hostframe::build(frame, sizeof(frame), m_parser.v2(), cmd, frame + 8, (uint16_t)(1 + len));
    if (n > 0 && m_writer != nullptr) m_writer(frame, n);
}

bool HostLink::endSession() {
    if (s_dispatchMutex != nullptr) xSemaphoreTake(s_dispatchMutex, portMAX_DELAY);
    bool was = s_active == this;
    if (was) {
        s_active = nullptr;
        m_parser.setV2(false);  // nova sessao comeca negociando de novo
        // push interrompido: fecha o FILE* (flush) e descarta o .part; sem
        // isto o fd ficava preso ate o proximo WRITE_BEGIN. O destino antigo
        // segue intacto porque a escrita foi para <destino>.part.
        if (s_wrFile != nullptr) closeWrite(false);
        // host sumiu sem DEBUG_CTL 0 (proxy morto a forca, cabo): um app
        // pausado no debugger ficaria esperando comando para sempre
        JsDebugger::setClient(false);
#if CONFIG_CELEROS_BLUETOOTH
        Resources::usbSession(false);  // leases do PC morrem (auto-off)
#endif
    }
    // Canal ocioso (chamado pela task dele, sem frame em curso): o buffer
    // grande volta ao heap; o frame de resposta tambem, se nao resta sessao
    if (m_big != nullptr) {
        m_parser.setBuffer(m_small, SMALL_PAYLOAD);
        free(m_big);
        m_big = nullptr;
    }
    if (s_active == nullptr && s_txFrame != nullptr) {
        free(s_txFrame);
        s_txFrame = nullptr;
    }
    if (s_dispatchMutex != nullptr) xSemaphoreGive(s_dispatchMutex);
    return was;
}

// Tunel ResProto do PC (Onda B, UsbRes.h): decodifica o pedido, roda no
// Resources e devolve [status][reqId][len u16][corpo] no mesmo opcode.
// O corpo grande (catalogo da malha) mora em static sob o mutex do
// dispatch: uma sessao so, uma task de canal por vez.
bool HostLink::sendResFrame(uint16_t sid, uint16_t seq, const uint8_t* data, size_t n) {
    HostLink* a = s_active;  // leitura simples: trocas de sessao sao raras
    if (a == nullptr || data == nullptr || n == 0) return false;
    if (s_resFrameMutex != nullptr) xSemaphoreTake(s_resFrameMutex, portMAX_DELAY);
    if (s_resFrame == nullptr) {
        s_resFrame = (uint8_t*)heap_caps_malloc(kResFrameSize, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_resFrame == nullptr) s_resFrame = (uint8_t*)malloc(kResFrameSize);
    }
    bool ok = s_resFrame != nullptr;
    while (ok && n > 0) {
        const size_t part = n > kResChunk ? kResChunk : n;
        // payload: [sid u16][seq u16][dados] (big-endian, o fio do ResProto)
        s_resFrame[8] = (uint8_t)(sid >> 8);
        s_resFrame[9] = (uint8_t)sid;
        s_resFrame[10] = (uint8_t)(seq >> 8);
        s_resFrame[11] = (uint8_t)seq;
        memcpy(s_resFrame + 12, data, part);
        size_t total = hostframe::build(s_resFrame, kResFrameSize, a->m_parser.v2(),
                                        KL_RES_DATA, s_resFrame + 8, (uint16_t)(4 + part));
        ok = total > 0 && a->m_writer != nullptr && a->m_writer(s_resFrame, total);
        data += part;
        n -= part;
    }
    if (s_resFrameMutex != nullptr) xSemaphoreGive(s_resFrameMutex);
    return ok;
}

bool HostLink::sendLogFrame(const char* line, size_t n) {
    HostLink* a = s_active;  // leitura simples: trocas de sessao sao raras
    if (a == nullptr) return false;
    // rota do LogSink: NAO toma o mutex do dispatch — handlers podem
    // logar no meio do proprio dispatch (EXEC/shell) e travariam
    if (s_logFrameMutex != nullptr) xSemaphoreTake(s_logFrameMutex, portMAX_DELAY);
    bool ok = true;
    do {
        const size_t part = n > kLogChunk ? kLogChunk : n;
        s_logFrame[8] = 0;  // status OK
        memcpy(s_logFrame + 9, line, part);
        size_t total = hostframe::build(s_logFrame, sizeof(s_logFrame), a->m_parser.v2(),
                                        KL_LOG_DATA, s_logFrame + 8, (uint16_t)(1 + part));
        ok = total > 0 && a->m_writer != nullptr && a->m_writer(s_logFrame, total);
        line += part;
        n -= part;
    } while (ok && n > 0);
    if (s_logFrameMutex != nullptr) xSemaphoreGive(s_logFrameMutex);
    return ok;
}

bool HostLink::sendDebugFrame(const uint8_t* data, size_t n) {
    HostLink* a = s_active;  // leitura simples: trocas de sessao sao raras
    if (a == nullptr || data == nullptr) return false;
    if (s_dbgFrameMutex != nullptr) xSemaphoreTake(s_dbgFrameMutex, portMAX_DELAY);
    if (s_dbgFrame == nullptr) {
        s_dbgFrame = (uint8_t*)heap_caps_malloc(kDbgFrameSize, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_dbgFrame == nullptr) s_dbgFrame = (uint8_t*)malloc(kDbgFrameSize);
    }
    bool ok = s_dbgFrame != nullptr;
    while (ok && n > 0) {
        const size_t part = n > kDbgChunk ? kDbgChunk : n;
        size_t total = hostframe::build(s_dbgFrame, kDbgFrameSize, a->m_parser.v2(),
                                        KL_DEBUG_DATA, data, (uint16_t)part);
        ok = total > 0 && a->m_writer != nullptr && a->m_writer(s_dbgFrame, total);
        data += part;
        n -= part;
    }
    if (s_dbgFrameMutex != nullptr) xSemaphoreGive(s_dbgFrameMutex);
    return ok;
}

// Maquina de estados de frames alimentada byte a byte (logica no
// HostFrame.h, testada no host). Rejeicoes com resposta sao tratadas aqui.
void HostLink::feed(uint8_t byte) {
    m_parser.feed(byte, esp_timer_get_time(), &HostLink::trampoline, this);
    if (m_parser.takeReject() == hostframe::FrameParser::REJ_TOO_BIG) {
        // rejeicao no parser: resposta direta pelo canal desta instancia
        // (ainda nao ha contexto de dispatch: nada de respondError aqui)
        const char msg[] = "payload grande demais";
        uint8_t frame[8 + 24];
        frame[8] = 1;  // status erro
        memcpy(frame + 9, msg, sizeof(msg) - 1);
        size_t n = hostframe::build(frame, sizeof(frame), m_parser.v2(), m_parser.rejectedCmd(),
                                    frame + 8, (uint16_t)(1 + sizeof(msg) - 1));
        if (n > 0 && m_writer != nullptr) m_writer(frame, n);
    }
    // REJ_CRC: silencio — o host reenvia o frame (resync no proximo 0x43)
}

void HostLink::run(StreamBufferHandle_t rx) {
    // bloco por vez: 1 byte por xStreamBufferReceive nao escala com os
    // chunks de 8KB do proto 2 (centenas de milhares de bytes/s no CDC)
    uint8_t buf[64];
    for (;;) {
        size_t n = xStreamBufferReceive(rx, buf, sizeof(buf), portMAX_DELAY);
        for (size_t i = 0; i < n; i++) feed(buf[i]);
    }
}
