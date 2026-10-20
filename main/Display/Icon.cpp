#include "Icon.h"
#include "../Assets/Fonts/CelerFonts.h"
#include "Theme.h"
#include "Layout.h"
#include <Arduino.h>
#include <string>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <sys/stat.h>
#include "esp_heap_caps.h"
#include <lgfx/utility/lgfx_pngle.h>

// Registro fixo — mesmos ids do tools/icons.json
const char* Icon::NAMES[Icon::COUNT] = {
    "appstore", "installer", "settings", "help", "web",
    "time", "about", "update", "app", "wifi_on", "wifi_off",
};
uint16_t* Icon::cache[Icon::COUNT] = {nullptr};
uint8_t* Icon::alpha[Icon::COUNT] = {nullptr};
// load que falhou nao e re-tentado a cada frame (decode caro); limpo no
// releaseAll (antes de app JS / rescan)
static bool s_failed[11] = {false};  // Icon::COUNT (privado)

namespace {
constexpr size_t SRC_PX = (size_t)Icon::SRC * Icon::SRC;
constexpr size_t DST_PX = (size_t)Icon::SIZE * Icon::SIZE;

// Cache decodificado em flash (so quando SIZE != SRC, i.e. placa sem PSRAM):
// o decode PNG pede ~44KB transitorios (janela do deflate) — na CYD isso
// era o pico que derrubava o heap para <1KB. Depois do primeiro decode o
// icone ja reduzido vai para /local/.icache e os proximos loads so leem
// 5,8KB crus.
constexpr const char* ICACHE_DIR = "/local/.icache";
constexpr int ICACHE_MAX_FILES = 48;  // apps reinstalados deixam orfaos: limpa ao passar

// Sem PSRAM: o cache em RAM nunca come a folga do sistema (WiFi/httpd; TLS
// so roda dentro de apps JS, que liberam os icones antes)
constexpr size_t NO_PSRAM_RESERVE = 20 * 1024;

bool roomForIcon() {
    if (Board::profile().hasPsram) return true;
    return heap_caps_get_free_size(MALLOC_CAP_8BIT) > NO_PSRAM_RESERVE + DST_PX * 2 + DST_PX / 2;
}

void* iconAlloc(size_t n) {
    void* p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p ? p : malloc(n);
}

// Caminho no cache em flash: hash do caminho de origem + tamanho + mtime
// (reinstalar o app com outra arte muda a chave)
std::string cachePathFor(const std::string& src) {
    struct stat st;
    if (stat(src.c_str(), &st) != 0) return "";
    uint32_t h = 2166136261u;  // FNV-1a
    for (char ch : src) h = (h ^ (uint8_t)ch) * 16777619u;
    h = (h ^ (uint32_t)st.st_size) * 16777619u;
    h = (h ^ (uint32_t)st.st_mtime) * 16777619u;
    char buf[40];
    snprintf(buf, sizeof(buf), "%s/%08x.bin", ICACHE_DIR, (unsigned)h);
    return buf;
}
}  // namespace

int Icon::index(const char* name) {
    for (int i = 0; i < COUNT; i++) {
        if (strcmp(name, NAMES[i]) == 0) return i;
    }
    return -1;
}

uint16_t* Icon::load(const char* name, uint8_t** alphaOut) {
    *alphaOut = nullptr;
    // nome comum -> /local/icons/<nome>.png (ou .bin legado); caminho absoluto
    // (icone de pacote de app) e usado como veio
    std::string path = name;
    FILE* f = nullptr;
    if (name[0] != '/') {
        path = std::string("/local/icons/") + name + ".png";
        f = fopen(path.c_str(), "rb");
        if (f == nullptr) {
            path = std::string("/local/icons/") + name + ".bin";
            f = fopen(path.c_str(), "rb");
        }
    } else {
        f = fopen(name, "rb");
    }
    if (f == nullptr) return nullptr;

    std::string cpath;
    if (SIZE != SRC) {
        cpath = cachePathFor(path);
        if (!cpath.empty()) {
            uint16_t* px = loadCached(cpath.c_str(), alphaOut);
            if (px != nullptr) {
                fclose(f);
                return px;
            }
        }
    }

    uint8_t sig[8];
    bool isPng = fread(sig, 1, 8, f) == 8 && memcmp(sig, "\x89PNG\r\n\x1a\n", 8) == 0;
    fseek(f, 0, SEEK_SET);
    uint8_t* a = nullptr;
    uint16_t* px = isPng ? loadPng(f, &a) : loadBin(f, &a);
    fclose(f);
    if (px == nullptr) return nullptr;

    if (SIZE != SRC) {
        px = downscale(px, a, &a);
        if (px == nullptr) return nullptr;
        if (!cpath.empty()) saveCached(cpath.c_str(), px, a);
    }
    *alphaOut = a;
    return px;
}

// ---- fluxo historico .bin --------------------------------------------------
uint16_t* Icon::loadBin(FILE* f, uint8_t** alphaOut) {
    constexpr size_t V1_SZ = SRC_PX * 2;               // RGB565 opaco
    constexpr size_t V2_SZ = SRC_PX * 2 + SRC_PX / 2;  // + mascara A4

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size < (long)V1_SZ) return nullptr;
    bool hasAlpha = size >= (long)V2_SZ;

    // PSRAM quando disponivel (framebuffer grande), senao heap interno
    uint16_t* buf = (uint16_t*)iconAlloc(SRC_PX * 2);
    uint8_t* a = hasAlpha ? (uint8_t*)iconAlloc(SRC_PX / 2) : nullptr;
    if (buf == nullptr || (hasAlpha && a == nullptr) ||
        fread(buf, 1, SRC_PX * 2, f) != SRC_PX * 2 ||
        (hasAlpha && fread(a, 1, SRC_PX / 2, f) != SRC_PX / 2)) {
        free(buf);
        free(a);
        return nullptr;
    }
    *alphaOut = a;
    return buf;
}

// ---- PNG via pngle do LovyanGFX ---------------------------------------------
// Decodifica no load direto para os buffers RGB565+A4 do cache (o caminho de
// draw nao conhece PNG). O pngle usa ~44 KB de heap durante o decode (janela
// do deflate) e e destruido em seguida — transitório até no CYD sem PSRAM.
namespace {
// O pngle entrega o MESMO user_data aos callbacks de leitura e de desenho:
// o contexto carrega o FILE* e os buffers juntos (passar so o FILE* fazia o
// pngDrawCb escrever dentro da struct FILE — boot loop com icon.png real).
struct PngIconCtx {
    FILE* f;
    uint16_t* px;
    uint8_t* a4;
    bool ok;
};

uint32_t pngReadCb(void* user, uint8_t* buf, uint32_t len) {
    FILE* f = ((PngIconCtx*)user)->f;
    if (buf == nullptr) {  // pngle pede para PULAR len bytes (chunks ignorados)
        return fseek(f, (long)len, SEEK_CUR) == 0 ? len : 0;
    }
    return (uint32_t)fread(buf, 1, len, f);
}

void pngDrawCb(void* user, uint32_t x, uint32_t y, uint_fast8_t div_x, size_t len,
               const uint8_t* argb) {
    PngIconCtx* c = (PngIconCtx*)user;
    if ((int)y >= Icon::SRC) { c->ok = false; return; }
    for (size_t i = 0; i < len; i++) {
        const uint8_t* p = argb + i * 4;  // A,R,G,B
        uint16_t rgb = (uint16_t)(((p[1] >> 3) << 11) | ((p[2] >> 2) << 5) | (p[3] >> 3));
        uint8_t a = p[0] >> 4;
        uint32_t x0 = x + (uint32_t)i * div_x;  // div_x>1: passos do interlace
        for (uint32_t k = 0; k < div_x && x0 + k < (uint32_t)Icon::SRC; k++) {
            size_t idx = (size_t)y * Icon::SRC + x0 + k;
            c->px[idx] = rgb;
            if (idx & 1) c->a4[idx >> 1] = (c->a4[idx >> 1] & 0xF0) | a;
            else         c->a4[idx >> 1] = (c->a4[idx >> 1] & 0x0F) | (a << 4);
        }
    }
}

// true quando a mascara A4 e toda 15 (opaca): dispensa o blend
bool allOpaque(const uint8_t* a4, size_t px) {
    for (size_t i = 0; i < px / 2; i++) {
        if (a4[i] != 0xFF) return false;
    }
    return true;
}
}  // namespace

uint16_t* Icon::loadPng(FILE* f, uint8_t** alphaOut) {
    // Sem PSRAM: o decode so roda com folga real (janela do deflate + margem
    // para WiFi/lwIP) — antes ele levava o heap a ~1KB e o resto do sistema
    // falhava alocacoes. Sem folga: tile no lugar (o prewarm do boot, com o
    // heap cheio, normalmente ja deixou o icone no cache em flash).
    if (!Board::profile().hasPsram &&
        (heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) < 48 * 1024 ||
         heap_caps_get_free_size(MALLOC_CAP_8BIT) < 72 * 1024)) {
        return nullptr;
    }
    pngle_t* pngle = lgfx_pngle_new();
    if (pngle == nullptr) return nullptr;

    uint16_t* buf = (uint16_t*)iconAlloc(SRC_PX * 2);
    uint8_t* a = (uint8_t*)iconAlloc(SRC_PX / 2);

    bool ok = false;
    PngIconCtx ctx = {f, buf, a, true};
    if (buf != nullptr && a != nullptr &&
        lgfx_pngle_prepare(pngle, pngReadCb, &ctx) >= 0 &&
        lgfx_pngle_get_width(pngle) == (uint32_t)SRC &&
        lgfx_pngle_get_height(pngle) == (uint32_t)SRC) {
        memset(a, 0, SRC_PX / 2);
        ok = lgfx_pngle_decomp(pngle, pngDrawCb) >= 0 && ctx.ok;
    }
    lgfx_pngle_destroy(pngle);  // devolve os ~44 KB da janela do deflate

    if (!ok) {
        free(buf);
        free(a);
        return nullptr;
    }
    // PNG opaco (sem canal alpha/tRNS): dispensa a mascara — blit direto
    if (allOpaque(a, SRC_PX)) {
        free(a);
        a = nullptr;
    }
    *alphaOut = a;
    return buf;
}

// Reducao SRC -> SIZE por media de area (cada pixel de destino pondera os
// pixels de origem pela fracao coberta), com cor ponderada pelo alpha — sem
// o serrilhado do vizinho-mais-proximo nem halo escuro nas bordas. Consome
// px/a4 (liberados) e devolve os buffers novos.
uint16_t* Icon::downscale(uint16_t* px, uint8_t* a4, uint8_t** alphaOut) {
    *alphaOut = nullptr;
    uint16_t* out = (uint16_t*)iconAlloc(DST_PX * 2);
    uint8_t* oa = (uint8_t*)iconAlloc(DST_PX / 2);
    if (out == nullptr || oa == nullptr) {
        free(out);
        free(oa);
        free(px);
        free(a4);
        return nullptr;
    }
    memset(oa, 0, DST_PX / 2);
    // Coordenadas em unidades de 1/(SRC*SIZE): destino d cobre
    // [d*SRC, (d+1)*SRC); origem s cobre [s*SIZE, (s+1)*SIZE)
    for (int dy = 0; dy < SIZE; dy++) {
        const int y0 = dy * SRC, y1 = y0 + SRC;
        for (int dx = 0; dx < SIZE; dx++) {
            const int x0 = dx * SRC, x1 = x0 + SRC;
            uint32_t sw = 0, sa = 0, sr = 0, sg = 0, sb = 0, swa = 0;
            for (int sy = y0 / SIZE; sy * SIZE < y1; sy++) {
                const int oy = (y1 < (sy + 1) * SIZE ? y1 : (sy + 1) * SIZE) - (y0 > sy * SIZE ? y0 : sy * SIZE);
                for (int sx = x0 / SIZE; sx * SIZE < x1; sx++) {
                    const int ox = (x1 < (sx + 1) * SIZE ? x1 : (sx + 1) * SIZE) - (x0 > sx * SIZE ? x0 : sx * SIZE);
                    const uint32_t w = (uint32_t)(ox * oy);
                    const int p = sy * SRC + sx;
                    const uint32_t a = a4 ? ((p & 1) ? (a4[p >> 1] & 0x0F) : (a4[p >> 1] >> 4)) : 15;
                    const uint32_t c = px[p];
                    const uint32_t wa = w * a;
                    sw += w;
                    sa += wa;
                    swa += wa;
                    sr += (c >> 11) * wa;
                    sg += ((c >> 5) & 0x3F) * wa;
                    sb += (c & 0x1F) * wa;
                }
            }
            const int d = dy * SIZE + dx;
            const uint32_t a = sw ? (sa + sw / 2) / sw : 0;
            uint16_t c = 0;
            if (swa) {
                c = (uint16_t)((((sr + swa / 2) / swa) << 11) | (((sg + swa / 2) / swa) << 5) | ((sb + swa / 2) / swa));
            }
            out[d] = c;
            if (d & 1) oa[d >> 1] = (oa[d >> 1] & 0xF0) | (uint8_t)a;
            else       oa[d >> 1] = (oa[d >> 1] & 0x0F) | (uint8_t)(a << 4);
        }
    }
    free(px);
    free(a4);
    if (allOpaque(oa, DST_PX)) {
        free(oa);
        oa = nullptr;
    }
    *alphaOut = oa;
    return out;
}

uint16_t* Icon::loadCached(const char* cachePath, uint8_t** alphaOut) {
    FILE* f = fopen(cachePath, "rb");
    if (f == nullptr) return nullptr;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    // escrita interrompida (queda de energia) = tamanho errado: re-decodifica
    const bool hasAlpha = size == (long)(DST_PX * 2 + DST_PX / 2);
    if (!hasAlpha && size != (long)(DST_PX * 2)) {
        fclose(f);
        return nullptr;
    }
    uint16_t* px = (uint16_t*)iconAlloc(DST_PX * 2);
    uint8_t* a = hasAlpha ? (uint8_t*)iconAlloc(DST_PX / 2) : nullptr;
    bool ok = px != nullptr && (!hasAlpha || a != nullptr) && fread(px, 1, DST_PX * 2, f) == DST_PX * 2 &&
              (!hasAlpha || fread(a, 1, DST_PX / 2, f) == DST_PX / 2);
    fclose(f);
    if (!ok) {
        free(px);
        free(a);
        return nullptr;
    }
    *alphaOut = a;
    return px;
}

void Icon::saveCached(const char* cachePath, const uint16_t* px, const uint8_t* a4) {
    DIR* dir = opendir(ICACHE_DIR);
    if (dir == nullptr) {
        mkdir(ICACHE_DIR, 0775);
    } else {
        // orfaos de apps reinstalados/removidos: passou do teto, recomeca
        int n = 0;
        while (readdir(dir) != nullptr) n++;
        closedir(dir);
        if (n >= ICACHE_MAX_FILES) {
            dir = opendir(ICACHE_DIR);
            if (dir != nullptr) {
                struct dirent* e;
                while ((e = readdir(dir)) != nullptr) {
                    std::string p = std::string(ICACHE_DIR) + "/" + e->d_name;
                    remove(p.c_str());
                }
                closedir(dir);
            }
        }
    }
    FILE* f = fopen(cachePath, "wb");
    if (f == nullptr) return;
    bool ok = fwrite(px, 1, DST_PX * 2, f) == DST_PX * 2 && (a4 == nullptr || fwrite(a4, 1, DST_PX / 2, f) == DST_PX / 2);
    ok = fclose(f) == 0 && ok;  // flush no fclose: cache truncado nao fica
    if (!ok) remove(cachePath);  // disco cheio: sem cache, decodifica de novo
}

bool Icon::available(const char* name) {
    if (name[0] == '/') return availableFile(name);
    int i = index(name);
    if (i < 0) return false;
    if (!cache[i] && !s_failed[i] && roomForIcon()) {
        cache[i] = load(name, &alpha[i]);
        s_failed[i] = cache[i] == nullptr;
    }
    return cache[i] != nullptr;
}

void Icon::drawAlpha(lgfx::LGFXBase* tft, const uint16_t* px, const uint8_t* a4, int x, int y) {
    // Blend por software linha a linha: le o fundo, compoe o alpha e devolve
    // (scratch de UMA linha — o de icone inteiro custava 8KB fixos de RAM).
    // So a parte visivel e processada — o Canvas em faixas desenha icones
    // cortados na borda de cada faixa.
    int x0 = x < 0 ? 0 : x;
    int y0 = y < 0 ? 0 : y;
    int x1 = x + SIZE > tft->width() ? tft->width() : x + SIZE;
    int y1 = y + SIZE > tft->height() ? tft->height() : y + SIZE;
    if (x0 >= x1 || y0 >= y1) return;
    const int vw = x1 - x0, vh = y1 - y0;

    uint16_t d[SIZE];
    for (int row = 0; row < vh; row++) {
        const int sp0 = (y0 - y + row) * SIZE + (x0 - x);
        tft->readRect(x0, y0 + row, vw, 1, d);
        for (int col = 0; col < vw; col++) {
            const int p = sp0 + col;
            uint32_t a = (p & 1) ? (a4[p >> 1] & 0x0F) : (a4[p >> 1] >> 4);
            if (a == 0) continue;                        // transparente: mantem o fundo
            if (a == 15) { d[col] = px[p]; continue; }   // opaco
            uint32_t s = px[p], b = d[col];
            uint32_t ia = 15 - a;
            // cada canal na propria escala (R/B 5 bits, G 6 bits); peso /15
            uint32_t r = ((s >> 11) * a + (b >> 11) * ia + 7) / 15;
            uint32_t g = (((s >> 5) & 0x3F) * a + ((b >> 5) & 0x3F) * ia + 7) / 15;
            uint32_t bl = ((s & 0x1F) * a + (b & 0x1F) * ia + 7) / 15;
            d[col] = (uint16_t)((r << 11) | (g << 5) | bl);
        }
        tft->pushImage(x0, y0 + row, vw, 1, d);
    }
}

void Icon::draw(lgfx::LGFXBase* tft, const char* name, int x, int y) {
    if (!tft) return;
    if (name[0] == '/') { drawFile(tft, name, x, y); return; }
    int i = index(name);
    if (i >= 0) {
        if (!cache[i] && !s_failed[i] && roomForIcon()) {
            cache[i] = load(name, &alpha[i]);
            s_failed[i] = cache[i] == nullptr;
        }
        if (cache[i]) {
            if (alpha[i]) drawAlpha(tft, cache[i], alpha[i], x, y);
            else tft->pushImage(x, y, SIZE, SIZE, cache[i]);
            return;
        }
    }
    drawFallback(tft, x, y);
}

// ---- icones de pacote: cache proprio por caminho absoluto ----------------
// O launcher pode redesenhar varias vezes por gesto; o cache evita reler o
// arquivo a cada frame. Invalidado no rescan (app reinstalado = arte nova).
namespace {
// PSRAM: duas paginas da grade do launcher cabem inteiras (o drag desenha a
// pagina atual E a vizinha no mesmo frame). Sem PSRAM continua uma pagina.
constexpr int FILE_CACHE = 24;
std::string g_filePath[FILE_CACHE];
uint16_t* g_filePx[FILE_CACHE] = {};
uint8_t* g_fileA[FILE_CACHE] = {};
uint32_t g_fileLastUse[FILE_CACHE] = {};  // LRU (F3): vitima = mais antigo
// caminhos cujo load FALHOU de verdade (arquivo ausente/corrompido; sem
// re-tentar por frame); limpo na invalidacao
constexpr int FAIL_MEMO = 8;
std::string g_failPath[FAIL_MEMO];
int g_failNext = 0;
bool failedBefore(const char* path) {
    for (const auto& p : g_failPath) {
        if (p == path) return true;
    }
    return false;
}
// Sem PSRAM: uma pagina da grade (4x2) — o resto reentra do cache em flash
int fileCacheCap() { return Board::profile().hasPsram ? FILE_CACHE : 8; }

void freeFileSlot(int i) {
    free(g_filePx[i]);
    free(g_fileA[i]);
    g_filePx[i] = nullptr;
    g_fileA[i] = nullptr;
    g_filePath[i].clear();
    g_fileLastUse[i] = 0;
}

// Slot menos recentemente usado entre os ocupados (-1: nenhum). minIdleMs:
// so candidatos parados ha pelo menos isso — despejar um icone do MESMO
// frame (faixas redesenham a grade N vezes) virava thrash: cada passada
// relia do flash o que a anterior tinha despejado (frame de 4s medido).
int lruSlot(uint32_t minIdleMs = 0) {
    int slot = -1;
    uint32_t oldest = UINT32_MAX;
    const uint32_t now = millis();
    for (int i = 0; i < fileCacheCap(); i++) {
        if (g_filePx[i] != nullptr && g_fileLastUse[i] < oldest && now - g_fileLastUse[i] >= minIdleMs) {
            oldest = g_fileLastUse[i];
            slot = i;
        }
    }
    return slot;
}
}  // namespace

void Icon::invalidateFileIcons() {
    for (int i = 0; i < FILE_CACHE; i++) freeFileSlot(i);
    for (auto& p : g_failPath) p.clear();
}

void Icon::releaseAll() {
    static_assert(sizeof(s_failed) == COUNT, "s_failed acompanha Icon::COUNT");
    invalidateFileIcons();
    for (int i = 0; i < COUNT; i++) {
        free(cache[i]);
        free(alpha[i]);
        cache[i] = nullptr;
        alpha[i] = nullptr;
        s_failed[i] = false;
    }
}

void Icon::prewarm(const char* name) {
    if (SIZE == SRC || name == nullptr || name[0] == 0) return;
    uint8_t* a = nullptr;
    uint16_t* px = load(name, &a);  // cache miss: decodifica e grava em flash
    free(px);
    free(a);
}

bool Icon::availableFile(const char* path) {
    for (int i = 0; i < fileCacheCap(); i++) {
        if (g_filePx[i] != nullptr && g_filePath[i] == path) {
            g_fileLastUse[i] = millis();
            return true;
        }
    }
    if (failedBefore(path)) return false;
    int slot = -1;
    for (int i = 0; i < fileCacheCap(); i++) {
        if (g_filePx[i] == nullptr) { slot = i; break; }
    }
    auto giveUp = [&]() {
        g_failPath[g_failNext] = path;
        g_failNext = (g_failNext + 1) % FAIL_MEMO;
        return false;
    };
    // cache cheio: recicla o slot menos recentemente usado (antes era sempre
    // o slot 0 — apps alternando muitos icones recarregavam sempre os mesmos)
    if (slot < 0) {
        slot = lruSlot(2000);
        // "Todos em uso neste frame" e TRANSITORIO (o drag desenha a pagina
        // atual antes da vizinha e marca tudo como recente): NAO memoiza —
        // antes virava giveUp e a pagina vizinha ficava eternamente em tile
        // de letra ate um rescan. false seco = tile so neste frame
        if (slot < 0) return false;
        freeFileSlot(slot);
    }
    // Sem PSRAM: abre espaco devolvendo os ociosos antes de alocar (idem:
    // falta de vitima agora nao e falha do ARQUIVO, nao memoiza)
    while (!roomForIcon()) {
        int victim = lruSlot(2000);
        if (victim < 0) return false;  // sem RAM neste frame: tile no lugar
        freeFileSlot(victim);
    }
    uint8_t* a = nullptr;
    uint16_t* px = load(path, &a);
    if (px == nullptr) return giveUp();
    g_filePath[slot] = path;
    g_filePx[slot] = px;
    g_fileA[slot] = a;
    g_fileLastUse[slot] = millis();
    return true;
}

void Icon::drawFile(lgfx::LGFXBase* tft, const char* path, int x, int y) {
    if (!tft) return;
    for (int i = 0; i < fileCacheCap(); i++) {
        if (g_filePx[i] != nullptr && g_filePath[i] == path) {
            g_fileLastUse[i] = millis();  // hit conta como uso recente (LRU)
            if (g_fileA[i]) drawAlpha(tft, g_filePx[i], g_fileA[i], x, y);
            else tft->pushImage(x, y, SIZE, SIZE, g_filePx[i]);
            return;
        }
    }
    if (availableFile(path)) {
        drawFile(tft, path, x, y);
        return;
    }
    drawFallback(tft, x, y);
}

uint32_t Icon::appTileColor(const char* appName) {
    // Paleta de acentos coerente com o tema (RGB888; o painel converte)
    // (tons ja quantizados para RGB565 — ver Theme.h)
    static const uint32_t palette[] = {
        0x3880F0, 0x885CF0, 0xE04890, 0xE89010,
        0x10A878, 0x08A8C8, 0x5860E8, 0xE04848,
    };
    uint32_t h = 0;
    for (const char* p = appName; p && *p; p++) h = h * 31 + (uint8_t)*p;
    return palette[h % 8];
}

uint32_t Icon::mix(uint32_t a, uint32_t b, int t256) {
    auto ch = [&](int sh) {
        int ca = (a >> sh) & 0xFF, cb = (b >> sh) & 0xFF;
        return (uint32_t)((ca * (256 - t256) + cb * t256) >> 8) << sh;
    };
    return ch(16) | ch(8) | ch(0);
}

void Icon::fillGradientRoundRect(lgfx::LGFXBase* tft, int x, int y, int w, int h, int r,
                                 uint32_t top, uint32_t bottom) {
    if (!tft || w <= 0 || h <= 0) return;
    if (r * 2 > h) r = h / 2;
    if (r * 2 > w) r = w / 2;
    for (int i = 0; i < h; i++) {
        // recuo horizontal da linha nos cantos arredondados
        int inset = 0;
        int d = (i < r) ? r - i : (i >= h - r ? i - (h - r - 1) : 0);
        if (d > 0) {
            int e = r * r - d * d;
            int s = 0;
            while ((s + 1) * (s + 1) <= e) s++;  // isqrt (r <= ~20: barato)
            inset = r - s;
        }
        tft->drawFastHLine(x + inset, y + i, w - 2 * inset, mix(top, bottom, h > 1 ? i * 256 / (h - 1) : 0));
    }
}

void Icon::drawAppTile(lgfx::LGFXBase* tft, const char* appName, int x, int y) {
    if (!tft || !appName) return;
    // Tile com gradiente vertical sutil (topo mais claro) + inicial em negrito
    uint32_t base = appTileColor(appName);
    fillGradientRoundRect(tft, x, y, SIZE, SIZE, SIZE / 4, mix(base, 0xFFFFFF, 48), mix(base, 0x000000, 40));
    char letter = 'A';
    for (const char* p = appName; p && *p; p++) {
        char c = *p;
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
            letter = (c >= 'a' && c <= 'z') ? c - 32 : c;
            break;
        }
    }
    char s[2] = {letter, 0};
    tft->setTextColor((uint32_t)0xFFFFFF);  // transparente sobre o gradiente
    tft->setTextDatum(MC_DATUM);
    tft->drawString(s, x + SIZE / 2, y + SIZE / 2 + 1, &celer::fonts::FreeSansBold18pt);
}

void Icon::drawFallback(lgfx::LGFXBase* tft, int x, int y) {
    tft->fillRoundRect(x, y, SIZE, SIZE, SIZE / 4, THEME_CARD);
    tft->drawRoundRect(x, y, SIZE, SIZE, SIZE / 4, THEME_STROKE);
    tft->setTextColor(THEME_TEXT_DIM);
    tft->setTextDatum(MC_DATUM);
    tft->drawString("?", x + SIZE / 2, y + SIZE / 2, &celer::fonts::FreeSansBold18pt);
}
