#include "JSBindings.h"
#include "../USBDevice/LogSink.h"
#include "../Display/Layout.h"
#include "../FileSystem/FileSystem.h"
#include "../UI/Keyboard.h"
#include "../WebManager/WebManager.h"
#include "../WebManager/WebAuth.h"
#include "../Kernel/TimeManager.h"
#include "../Utils/StrUtils.h"
#include "../Utils/PinStore.h"
#include "HttpClient.h"
#include "SystemInfo.h"
#include "esp_rom_md5.h"
#include "../Display/Backlight.h"
#include "../Display/Theme.h"
#include "../Display/Icon.h"
#include "../OTA/OtaManager.h"
#include "../Launcher/LauncherUI.h"
#include "../Launcher/Screens.h"
#include "../Boards/Board.h"
#include <lgfx/v1/misc/DataWrapper.hpp>
#include <new>
#include "JsInternal.h"
#include "JsFsJail.h"

// =====================================================
// Double Buffering
// =====================================================
//
// Sprites multiplos (API 12): pool de ate 16 com PSRAM (8 ate a API 32;
// 1 sem PSRAM — cada sprite come RAM interna no fallback 8-bit). Jogo com
// arte por personagem + texturas estourava 8 (Arrasa). createSprite devolve um id 1..16
// (0 = falhou) e o sprite novo vira o CORRENTE; draw*/pushSprite seguem
// o corrente (compat: apps antigos ignoram o retorno). useSprite(id)
// troca o alvo: 0 = quadro/display, 1..16 = sprite existente.
// System.spriteSlots() (API 29) informa o limite real da placa.

namespace {
constexpr int kSpritePool = 16;
CelerSprite* s_spritePool[kSpritePool] = {};  // nullptr = livre
int spriteCap() { return Board::profile().hasPsram ? kSpritePool : 1; }
}  // namespace

// Canvas nativo (API 28): definido aqui (dominio grafico), lido pelos
// conversores de JsInternal.h e pelo touch (JsSystem.cpp). Zerado no init().
bool s_nativeCanvas = false;

// Reset por app (JSBindings::init): app que saiu sem deleteSprite nao vaza
void JSBindings::deleteAllSprites() {
    for (CelerSprite*& s : s_spritePool) {
        if (s) {
            s->deleteSprite();
            delete s;
            s = nullptr;
        }
    }
    tftSprite = nullptr;  // corrente (ponteiro pertencia ao pool)
    useSprite = false;
}

duk_ret_t JSBindings::js_createSprite(duk_context *ctx) {
    if (!tftInstance) return 0;

    int w = duk_require_int(ctx, 0);
    int h = duk_require_int(ctx, 1);
    // Canvas virtual: o sprite e alocado no tamanho FISICO equivalente
    int pw = jsx(w);
    int ph = appSh(h);  // sprite = canvas do app: area abaixo da topbar
    // createSprite(70000, 70000): as escalas e o teste `pw * ph * 2` abaixo
    // estouram o int (o alocador do LovyanGFX pode receber um tamanho
    // envolvido = escrever alem do buffer). O maior vidro e 480x480: teto
    // folgado e falha limpa (id 0) acima dele.
    if (pw < 1 || ph < 1 || pw > 2048 || ph > 2048) {
        duk_push_int(ctx, 0);
        return 1;
    }

    int slot = -1;
    for (int i = 0; i < spriteCap(); i++) {
        if (s_spritePool[i] == nullptr) { slot = i; break; }
    }
    if (slot < 0) {
        // pool cheio: apps antigos esperam que createSprite recicle o
        // anterior — mantem a compat derrubando o sprite corrente
        if (tftSprite != nullptr) {
            for (int i = 0; i < spriteCap(); i++) {
                if (s_spritePool[i] == tftSprite) { slot = i; break; }
            }
        }
        if (slot < 0) { duk_push_int(ctx, 0); return 1; }
        tftSprite->deleteSprite();
        delete tftSprite;
        s_spritePool[slot] = nullptr;
        tftSprite = nullptr;
    }

    // nothrow: com -fno-exceptions o new normal ABORTA o aparelho quando a
    // RAM acabou; o app deve receber 0 (createSprite ja tem esse contrato).
    CelerSprite* spr = new (std::nothrow) CelerSprite(tftInstance);
    if (spr == nullptr) {
        duk_push_int(ctx, 0);
        return 1;
    }
    // Prefere PSRAM quando disponivel (sem PSRAM o LovyanGFX usa o heap)
    spr->setPsram(true);

    void* ptr = nullptr;

    // 16 bits primeiro: com PSRAM o buffer vai para la (o teste de bloco
    // INTERNO derrubava sprites grandes do S3 para 8 bits a toa); sem PSRAM
    // so com folga contigua no heap interno
    if (Board::profile().hasPsram || ESP.getMaxAllocHeap() > (uint32_t)(pw * ph * 2 + 10000)) {
        spr->setColorDepth(16);
        ptr = spr->createSprite(pw, ph);
    }

    // Fallback to 8-bit color if 16-bit failed or wasn't attempted
    if (!ptr) {
        spr->setColorDepth(8);
        ptr = spr->createSprite(pw, ph);
    }

    if (!ptr) {
        delete spr;
        duk_push_int(ctx, 0);
        return 1;
    }

    s_spritePool[slot] = spr;
    tftSprite = spr;   // novo sprite vira o corrente (compat)
    useSprite = false; // createSprite nao binda: quem desenha chama bind/use
    duk_push_int(ctx, slot + 1);
    return 1;
}

duk_ret_t JSBindings::js_deleteSprite(duk_context *ctx) {
    // Sem arg: apaga o CORRENTE (compat). Com id: apaga aquele.
    CelerSprite* victim = tftSprite;
    if (duk_is_number(ctx, 0)) {
        int id = duk_require_int(ctx, 0);
        if (id < 1 || id > spriteCap()) return 0;
        victim = s_spritePool[id - 1];
        if (victim == nullptr) return 0;
    }
    if (victim != nullptr) {
        for (CelerSprite*& s : s_spritePool) {
            if (s == victim) {
                victim->deleteSprite();
                delete victim;
                s = nullptr;
                break;
            }
        }
        if (tftSprite == victim) {
            tftSprite = nullptr;
            useSprite = false;
        }
    }
    return 0;
}

duk_ret_t JSBindings::js_pushSprite(duk_context *ctx) {
    if (!tftInstance || !tftSprite) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    // API 28: 3o arg = cor-chave de transparencia (RGB565). Pixels do sprite
    // com essa cor NAO sao transferidos — sprites com fundo preto blitam
    // sobre a cena (estrelas, glow) sem o quadrado. Sem o arg (undefined no
    // stack fixo de nargs=3), mantem o blit opaco dos apps antigos.
    uint32_t key = 0;
    bool chroma = !duk_is_null_or_undefined(ctx, 2);
    if (chroma) key = duk_require_uint(ctx, 2);
    // Destino (quadro/display): origem do app (abaixo da topbar no fixo)
    if (s_frame != nullptr) {
        if (chroma) tftSprite->pushSprite(s_frame, jsx(x), JSBindings::mapY(y), jsc(key));
        else tftSprite->pushSprite(s_frame, jsx(x), JSBindings::mapY(y));  // caixa suja do quadro marca
    } else {
        if (chroma) tftSprite->pushSprite(jsx(x), JSBindings::mapY(y), jsc(key));
        else tftSprite->pushSprite(jsx(x), JSBindings::mapY(y));
    }
    return 0;
}

duk_ret_t JSBindings::js_bindSprite(duk_context *ctx) {
    bool enable = duk_require_boolean(ctx, 0);
    if (tftSprite) useSprite = enable;
    else useSprite = false;
    return 0;
}

// API 12: troca o alvo do desenho. useSprite(0) volta ao quadro/display;
// useSprite(id) seleciona (e binda) o sprite id criado pelo createSprite.
duk_ret_t JSBindings::js_useSprite(duk_context *ctx) {
    int id = duk_require_int(ctx, 0);
    if (id == 0) {
        useSprite = false;
        duk_push_boolean(ctx, 1);
        return 1;
    }
    if (id < 1 || id > spriteCap() || s_spritePool[id - 1] == nullptr) {
        useSprite = false;
        duk_push_boolean(ctx, 0);
        return 1;
    }
    tftSprite = s_spritePool[id - 1];
    useSprite = true;
    duk_push_boolean(ctx, 1);
    return 1;
}

#if CONFIG_CELEROS_JS_GAME_ACCEL
// API 33: desenha o sprite `id` GIRADO/ESCALADO com o centro em (x, y) no
// alvo corrente (quadro, display ou outro sprite do useSprite) — angulo em
// graus (horario), zoom por eixo, cor-chave opcional e `smooth` (amostragem
// com anti-alias: reduzir/ampliar arte no load sem serrilhado; o padrao e
// o vizinho mais proximo, mais rapido por quadro). Pecas que giram (fisica
// rigida) e fundo ampliado de um PNG pequeno saem daqui.
duk_ret_t JSBindings::js_drawSprite(duk_context *ctx) {
    if (!tftInstance) return 0;
    int id = duk_require_int(ctx, 0);
    if (id < 1 || id > spriteCap() || s_spritePool[id - 1] == nullptr) return 0;
    CelerSprite* src = s_spritePool[id - 1];
    float x = (float)duk_require_number(ctx, 1);
    float y = (float)duk_require_number(ctx, 2);
    float ang = duk_is_number(ctx, 3) ? (float)duk_get_number(ctx, 3) : 0.0f;
    float zx = duk_is_number(ctx, 4) ? (float)duk_get_number(ctx, 4) : 1.0f;
    float zy = duk_is_number(ctx, 5) ? (float)duk_get_number(ctx, 5) : zx;
    bool chroma = !duk_is_null_or_undefined(ctx, 6);
    uint32_t key = chroma ? duk_require_uint(ctx, 6) : 0;
    bool smooth = duk_is_boolean(ctx, 7) && duk_get_boolean(ctx, 7);
    lgfx::LovyanGFX* dst;
    if (useSprite && tftSprite) {
        if (tftSprite == src) return 0;   // nao desenha sobre si mesmo
        dst = tftSprite;
    } else if (s_frame != nullptr) {
        dst = s_frame;                    // o FrameSprite marca a caixa suja
    } else {
        dst = tftInstance;
    }
    // canvas virtual: centro e zoom seguem a escala do app (o sprite ja foi
    // alocado no tamanho fisico equivalente pelo createSprite)
    float px = s_nativeCanvas ? x : (float)jsx(0) + x * (float)UI::sx(1000) / 1000.0f;
    float py = s_nativeCanvas ? y : (float)JSBindings::mapY(0) + y * appScaleY();
    if (smooth) {
        if (chroma) src->pushRotateZoomWithAA(dst, px, py, ang, zx, zy, jsc(key));
        else src->pushRotateZoomWithAA(dst, px, py, ang, zx, zy);
    } else if (chroma) {
        src->pushRotateZoom(dst, px, py, ang, zx, zy, jsc(key));
    } else {
        src->pushRotateZoom(dst, px, py, ang, zx, zy);
    }
    return 0;
}

// API 34: devolve o retangulo (x, y, w, h) do sprite `id` para a MESMA
// posicao do alvo corrente — o sprite cobre o canvas a partir de (0, 0)
// (fundo de tela inteira). E o painter da camada suja das engines numa
// chamada: setClip + useSprite + pushSprite + useSprite(0) + clearClip
// eram 5 bindings por caixa, dezenas de caixas por quadro de jogo. O
// recorte do alvo volta ao que era (o do sistema no display direto fica).
duk_ret_t JSBindings::js_blitSprite(duk_context *ctx) {
    if (!tftInstance) return 0;
    int id = duk_require_int(ctx, 0);
    if (id < 1 || id > spriteCap() || s_spritePool[id - 1] == nullptr) return 0;
    CelerSprite* src = s_spritePool[id - 1];
    int x = duk_require_int(ctx, 1), y = duk_require_int(ctx, 2);
    int w = duk_require_int(ctx, 3), h = duk_require_int(ctx, 4);
    if (w <= 0 || h <= 0) return 0;
    lgfx::LovyanGFX* dst;
    if (useSprite && tftSprite) {
        if (tftSprite == src) return 0;   // nao copia sobre si mesmo
        dst = tftSprite;
    } else if (s_frame != nullptr) {
        dst = s_frame;                    // o FrameSprite marca so o recorte
    } else {
        dst = tftInstance;
    }
    // mesmo mapeamento das primitivas no alvo corrente (canvas nativo = 1:1)
    int cx = jsx(x), cy = jsy(y);
    int cw = jsx(x + w) - cx, ch = jsy(y + h) - cy;
    int32_t ox, oy, ow, oh;
    dst->getClipRect(&ox, &oy, &ow, &oh);
    int x0 = cx > ox ? cx : ox, y0 = cy > oy ? cy : oy;
    int x1 = cx + cw < ox + ow ? cx + cw : ox + ow;
    int y1 = cy + ch < oy + oh ? cy + ch : oy + oh;
    if (x1 <= x0 || y1 <= y0) return 0;
    dst->setClipRect(x0, y0, x1 - x0, y1 - y0);
    src->pushSprite(dst, jsx(0), jsy(0));
    dst->setClipRect(ox, oy, ow, oh);
    return 0;
}

// API 45: copia a regiao (sx, sy, w, h) do sprite `id` para (dx, dy) do alvo
// CORRENTE — o quadro/display ou um sprite selecionado com useSprite — sem
// escala; 8o arg opcional = cor-chave RGB565 (pixels dessa cor nao copiam).
// E o stamp de tile de folha em escala 1 DENTRO de um sprite (o world grava
// a sala de 195 tiles: so havia o drawSprite afim com recorte, ~240 us por
// tile 32x32 no 4848 contra ~150-200 aqui) e o mesmo stamp no quadro em 1
// chamada no lugar de
// setClip + useSprite + pushSprite + useSprite(0) + clearClip. O recorte do
// alvo volta ao que era.
duk_ret_t JSBindings::js_copySprite(duk_context *ctx) {
    if (!tftInstance) return 0;
    int id = duk_require_int(ctx, 0);
    if (id < 1 || id > spriteCap() || s_spritePool[id - 1] == nullptr) return 0;
    CelerSprite* src = s_spritePool[id - 1];
    int sx = duk_require_int(ctx, 1), sy = duk_require_int(ctx, 2);
    int w = duk_require_int(ctx, 3), h = duk_require_int(ctx, 4);
    int dx = duk_require_int(ctx, 5), dy = duk_require_int(ctx, 6);
    const bool chroma = !duk_is_null_or_undefined(ctx, 7);
    const uint32_t key = chroma ? duk_require_uint(ctx, 7) : 0;
    if (w <= 0 || h <= 0) return 0;
    lgfx::LovyanGFX* dst;
    if (useSprite && tftSprite) {
        if (tftSprite == src) return 0;   // nao copia sobre si mesmo
        dst = tftSprite;
    } else if (s_frame != nullptr) {
        dst = s_frame;                    // o FrameSprite marca so o recorte
    } else {
        dst = tftInstance;
    }
    // destino no mapa do alvo corrente; a origem DENTRO do sprite e escala
    // pura (o offset da faixa no modo fixo nao vale para coords de sprite)
    int cx = jsx(dx), cy = jsy(dy);
    int cw = jsx(dx + w) - cx, ch = jsy(dy + h) - cy;
    int px0 = jsx(sx) - jsx(0), py0 = jsy(sy) - jsy(0);
    int32_t ox, oy, ow, oh;
    dst->getClipRect(&ox, &oy, &ow, &oh);
    int x0 = cx > ox ? cx : ox, y0 = cy > oy ? cy : oy;
    int x1 = cx + cw < ox + ow ? cx + cw : ox + ow;
    int y1 = cy + ch < oy + oh ? cy + ch : oy + oh;
    if (x1 <= x0 || y1 <= y0) return 0;
    dst->setClipRect(x0, y0, x1 - x0, y1 - y0);
    if (chroma) src->pushSprite(dst, cx - px0, cy - py0, jsc(key));
    else src->pushSprite(dst, cx - px0, cy - py0);
    dst->setClipRect(ox, oy, ow, oh);
    return 0;
}
#endif

// API 29: o limite real do pool (8 com PSRAM, 1 sem) — engines e jogos
// orcamentam os slots em vez de chumbar o maximo historico
duk_ret_t JSBindings::js_spriteSlots(duk_context *ctx) {
    duk_push_int(ctx, spriteCap());
    return 1;
}

duk_ret_t JSBindings::js_drawFastVLine(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    int h = duk_require_int(ctx, 2);
    uint32_t color = duk_require_uint(ctx, 3);
    gfx()->drawFastVLine(jsx(x), jsy(y), jsH(h), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_drawFastHLine(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    int w = duk_require_int(ctx, 2);
    uint32_t color = duk_require_uint(ctx, 3);
    gfx()->drawFastHLine(jsx(x), jsy(y), jsx(w), jsc(color));
    return 0;
}

// =====================================================
// Display Bindings - Drawing Primitives
// =====================================================

duk_ret_t JSBindings::js_fillScreen(duk_context *ctx) {
    if (!tftInstance) return 0;
    uint32_t color = duk_require_uint(ctx, 0);
    gfx()->fillScreen(jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_fillRect(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    int w = duk_require_int(ctx, 2);
    int h = duk_require_int(ctx, 3);
    uint32_t color = duk_require_uint(ctx, 4);
    gfx()->fillRect(jsx(x), jsy(y), jsx(w), jsH(h), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_drawRect(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    int w = duk_require_int(ctx, 2);
    int h = duk_require_int(ctx, 3);
    uint32_t color = duk_require_uint(ctx, 4);
    gfx()->drawRect(jsx(x), jsy(y), jsx(w), jsH(h), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_drawLine(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x0 = duk_require_int(ctx, 0);
    int y0 = duk_require_int(ctx, 1);
    int x1 = duk_require_int(ctx, 2);
    int y1 = duk_require_int(ctx, 3);
    uint32_t color = duk_require_uint(ctx, 4);
    gfx()->drawLine(jsx(x0), jsy(y0), jsx(x1), jsy(y1), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_drawPixel(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    uint32_t color = duk_require_uint(ctx, 2);
    const int px = jsx(x), py = jsy(y);
    // Fast path: pixel direto no buffer do quadro. Ponto ESPALHADO pelo
    // caminho completo do LGFX custava ~0,2 ms (60 estrelas = 12 ms de
    // quadro); aqui e escrita + caixa suja, microssegundos. A cor segue
    // RGB565 crua (o buffer do quadro e 16 bpp; o jsc expande p/ 888 so
    // porque o LGFX decide formato pelo tipo do argumento).
    if (s_frame != nullptr && !useSprite && !clipActive()) {
        // o System.setClip do app com quadro recorta o PROPRIO quadro (nao o
        // display): o fast path respeita esse recorte (antes a estrela
        // vazava por cima do HUD que a arena recortava)
        int32_t cx, cy, cw, ch;
        s_frame->getClipRect(&cx, &cy, &cw, &ch);
        if (px < cx || py < cy || px >= cx + cw || py >= cy + ch) return 0;
        if (s_frame->pokePixel(px, py, (uint16_t)(color & 0xFFFF))) return 0;
    }
    gfx()->drawPixel(px, py, jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_drawCircle(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    int r = duk_require_int(ctx, 2);
    uint32_t color = duk_require_uint(ctx, 3);
    gfx()->drawCircle(jsx(x), jsy(y), jsu(r), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_fillCircle(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    int r = duk_require_int(ctx, 2);
    uint32_t color = duk_require_uint(ctx, 3);
    gfx()->fillCircle(jsx(x), jsy(y), jsu(r), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_drawTriangle(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x0 = duk_require_int(ctx, 0);
    int y0 = duk_require_int(ctx, 1);
    int x1 = duk_require_int(ctx, 2);
    int y1 = duk_require_int(ctx, 3);
    int x2 = duk_require_int(ctx, 4);
    int y2 = duk_require_int(ctx, 5);
    uint32_t color = duk_require_uint(ctx, 6);
    gfx()->drawTriangle(jsx(x0), jsy(y0), jsx(x1), jsy(y1), jsx(x2), jsy(y2), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_fillTriangle(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x0 = duk_require_int(ctx, 0);
    int y0 = duk_require_int(ctx, 1);
    int x1 = duk_require_int(ctx, 2);
    int y1 = duk_require_int(ctx, 3);
    int x2 = duk_require_int(ctx, 4);
    int y2 = duk_require_int(ctx, 5);
    uint32_t color = duk_require_uint(ctx, 6);
    gfx()->fillTriangle(jsx(x0), jsy(y0), jsx(x1), jsy(y1), jsx(x2), jsy(y2), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_drawRoundRect(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    int w = duk_require_int(ctx, 2);
    int h = duk_require_int(ctx, 3);
    int r = duk_require_int(ctx, 4);
    uint32_t color = duk_require_uint(ctx, 5);
    gfx()->drawRoundRect(jsx(x), jsy(y), jsx(w), jsH(h), jsu(r), jsc(color));
    return 0;
}

duk_ret_t JSBindings::js_fillRoundRect(duk_context *ctx) {
    if (!tftInstance) return 0;
    int x = duk_require_int(ctx, 0);
    int y = duk_require_int(ctx, 1);
    int w = duk_require_int(ctx, 2);
    int h = duk_require_int(ctx, 3);
    int r = duk_require_int(ctx, 4);
    uint32_t color = duk_require_uint(ctx, 5);
    gfx()->fillRoundRect(jsx(x), jsy(y), jsx(w), jsH(h), jsu(r), jsc(color));
    return 0;
}

// Caminhos de imagem aceitos: canonicos dentro de /local ou /sd (o prefixo
// cru aceitava "/sdfoo" e "/local/../")
bool imagePathOk(const char* path) {
    return fsPathCanonical(path);
}

duk_ret_t JSBindings::js_drawBMP(duk_context *ctx) {
    // Decoder do LovyanGFX (16/24/32 bpp, RLE) com a escala do canvas
    // virtual: a imagem ocupa na tela fisica o mesmo espaco que no 240x320.
    if (!tftInstance) return 0;
    const char *path = duk_require_string(ctx, 0);
    int x = duk_require_int(ctx, 1);
    int y = duk_require_int(ctx, 2);
    if (!imagePathOk(path)) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    CelerFileWrapper file;
    bool ok = gfx()->drawBmpFile(&file, path, jsx(x), jsy(y), 0, 0, 0, 0,
                                 s_nativeCanvas ? 1.0f : (float)UI::W / 240.0f,
                                 appScaleY());
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

// =====================================================
// Display Bindings - Text
// =====================================================

duk_ret_t JSBindings::js_drawString(duk_context *ctx) {
    if (!tftInstance) return 0;
    const char *str = duk_require_string(ctx, 0);
    int x = duk_require_int(ctx, 1);
    int y = duk_require_int(ctx, 2);
    int font = duk_get_int_default(ctx, 3, 2); // default to font 2
    // datum = o do System.setTextDatum (API 12; TL por padrao, resetado a
    // cada app). Antes era forcado TL aqui e o setTextDatum nao fazia nada.
    gfx()->drawString(str, jsx(x), jsy(y), jsFont(font));
    return 0;
}

duk_ret_t JSBindings::js_setTextColor(duk_context *ctx) {
    if (!tftInstance) return 0;
    uint32_t fg = duk_require_uint(ctx, 0);
    // Optional background color (defaults to foreground = transparent)
    if (duk_is_number(ctx, 1)) {
        uint32_t bg = duk_require_uint(ctx, 1);
        gfx()->setTextColor(jsc(fg), jsc(bg));
    } else {
        gfx()->setTextColor(jsc(fg));
    }
    return 0;
}

duk_ret_t JSBindings::js_setTextSize(duk_context *ctx) {
    if (!tftInstance) return 0;
    int size = duk_require_int(ctx, 0);
    if (size < 1) size = 1;   // 0/negativo: glifo degenerado
    if (size > 10) size = 10; // enorme: cada glifo varre a tela inteira (lento)
    gfx()->setTextSize(size);
    return 0;
}

// API 12: datum de ancoragem do drawString no ALVO corrente (quadro,
// display ou sprite). 0=TL (default, comportamento anterior), 1=TC,
// 2=TR, 4=ML, 5=MC, 6=MR, 8=BL, 9=BC, 10=BR (mesmos valores do LovyanGFX).
// textWidth/fontHeight continuam medindo a string — centralizar na mao
// continua possivel; com datum o drawString ja posiciona.
duk_ret_t JSBindings::js_setTextDatum(duk_context *ctx) {
    if (!tftInstance) return 0;
    int d = duk_require_int(ctx, 0);
    if (d < 0 || d > 10) d = 0;
    gfx()->setTextDatum((textdatum_t)d);
    return 0;
}

// =====================================================
// Display Bindings - Utility
// =====================================================

// Convert RGB888 (0-255 per channel) to the target's native color format
duk_ret_t JSBindings::js_color(duk_context *ctx) {
    int r = duk_require_int(ctx, 0);
    int g = duk_require_int(ctx, 1);
    int b = duk_require_int(ctx, 2);
    // Clamp values
    if (r < 0) r = 0;
    if (r > 255) r = 255;
    if (g < 0) g = 0;
    if (g > 255) g = 255;
    if (b < 0) b = 0;
    if (b > 255) b = 255;
    // Convencao JS: cores sao RGB565 (mesmo valor em qualquer placa)
    duk_push_uint(ctx, ((uint32_t)(r & 0xF8) << 8) | ((uint32_t)(g & 0xFC) << 3) | ((uint32_t)b >> 3));
    return 1;
}

duk_ret_t JSBindings::js_screenWidth(duk_context *ctx) {
    // Canvas virtual: os apps veem o tamanho de projeto (240); no nativo,
    // pixels fisicos do vidro (480 na 4848)
    duk_push_int(ctx, (s_nativeCanvas && tftInstance) ? tftInstance->width() : 240);
    return 1;
}

duk_ret_t JSBindings::js_screenHeight(duk_context *ctx) {
    // Canvas virtual: os apps veem o tamanho de projeto (320); no nativo,
    // pixels fisicos do vidro
    duk_push_int(ctx, (s_nativeCanvas && tftInstance) ? tftInstance->height() : 320);
    return 1;
}

// API 28: canvas nativo. true = desenho, sprites e touch em pixels FISICOS
// do vidro (sem a escala 240x320 -> tela). Exige app SEM topbar fixa (o X
// de sair teria os pixels contados de outra forma); devolve false e nao muda
// nada quando o app tem a faixa. Reversivel no mesmo app (menus no canvas
// virtual com UI.*, jogo no nativo) — quem alterna repinta a tela inteira.
duk_ret_t JSBindings::js_setNativeCanvas(duk_context *ctx) {
    bool enable = duk_require_boolean(ctx, 0);
    if (enable && s_topbarFixed) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    s_nativeCanvas = enable;
    // A mudanca de escala vale do proximo draw em diante; o quadro atual
    // misturaria as duas resolucoes — pede push integral (o app repinta).
    if (s_frame != nullptr) s_frame->markAllDirty();
    duk_push_boolean(ctx, 1);
    return 1;
}

