#pragma once
// TIA do Atari 2600 (video + som + colisoes + WSYNC).
//
// A TIA nao tem framebuffer: ela desenha ENQUANTO o feixe varre a linha. Um
// COLUPF/GRP escrito no meio da linha muda os pixels seguintes, e um RESP no
// ciclo certo posiciona o sprite.
//
// Desenho PREGUICOSO por trechos: o tick so anda o relogio (3 color clocks
// por ciclo de CPU). Os pixels saem em lote (renderTo) quando algo pode
// muda-los — antes de toda escrita de registrador, de toda leitura de
// colisao e na borda do blank. O resultado e o mesmo de avaliar pixel a
// pixel (o estado e constante entre duas escritas), mas o caminho quente do
// quadro deixa de pagar uma chamada por color clock.
//
// Objetos: um byte por pixel (objs_) com um bit por objeto (P0,P1,M0,M1,BL,
// PF). Cada objeto so e remontado quando um registrador dele muda; o pixel e
// uma leitura + duas tabelas (prioridade e colisao).
//
// Posicao: RESPx/RESMx/RESBL travam a posicao no fim do ciclo da escrita com
// o atraso do contador do hardware (+5 players, +4 missil/bola; durante o
// blank: 3 e 2). HMOVE move para a ESQUERDA nos valores positivos (HMxx
// 0x10 = 1 px para a esquerda, 0xF0 = 1 px para a direita) e, no blank,
// apaga os 8 primeiros pixels da linha seguinte (o "pente" do HMOVE).
//
// Saida: 160x192 RGB565 swap. Audio: os dois canais da TIA clocados duas
// vezes por linha (31,4 kHz, como o chip) e reamostrados para 44,1 kHz pelo
// AudioDownsampler. O framebuffer NAO mora no objeto (60 KB iriam para a RAM
// interna do loader): o blob aponta para a scratch via setFramebuffer().

#include "../../common/emu_compat.h"
#include "../../common/emu_state.h"
#include "../../common/emu_video.h"
#include "../../common/emu_audio.h"

namespace emu {
namespace a2600 {

class Tia
{
public:
    static constexpr int kColorClocks = 228;
    // A linha e 160 color clocks VISIVEIS (0..159) seguidos de 68 de
    // horizontal blank (160..227): o feixe desenha e depois retorna. O WSYNC
    // libera a CPU na BORDA do blank (clock 160), dando os 68 clocks para o
    // kernel preparar a proxima linha; RESP durante o blank = borda esquerda.
    static constexpr int kVisibleStart = 0;
    static constexpr int kVisibleWidth = 160;
    static constexpr int kVisibleHeight = 192;
    static constexpr int kLines = 262;   // NTSC
    // 3.579.545 Hz / 114 color clocks: duas amostras de audio por linha.
    static constexpr int kAudioRate = 31400;

    void reset();
    void setFramebuffer(uint16_t* fb) { frame_ = fb; }
    // Saida por linha (FRAME_SCREEN): a linha y da janela vai para o sink em
    // vez do framebuffer — a composicao direta no vidro le da RAM interna.
    typedef void (*LineSink)(void* ctx, int y, const uint16_t* line);
    void setLineSink(LineSink fn, void* ctx)
    {
        sink_ = fn;
        sinkCtx_ = ctx;
    }
    void setAudio(emu::AudioDownsampler* a) { audio_ = a; }
    void setInputs(uint8_t inpt4, uint8_t inpt5, const uint8_t* paddles);

    uint8_t read(uint16_t addr);
    void write(uint16_t addr, uint8_t v);

    // 1 ciclo de CPU = 3 color clocks. So anda o relogio: o desenho sai em
    // lote nas bordas (blank/fim da linha) e antes de cada escrita.
    void tick() { advance(1); }
    // `cycles` ciclos de CPU de uma vez: o barramento so sincroniza a TIA
    // quando o jogo acessa um registrador dela (o estado nao muda entre dois
    // acessos), entao o caminho quente da CPU nao paga nada por ciclo.
    void advance(uint32_t cycles)
    {
        int target = clock_ + 3 * (int)cycles;
        while (target >= kColorClocks) {
            if (clock_ < kVisibleWidth) crossBlank();
            target -= kColorClocks;
            clock_ = 0;
            endLine();
        }
        if (clock_ < kVisibleWidth && target >= kVisibleWidth) crossBlank();
        clock_ = target;
    }
    // Ciclos de CPU que um WSYNC escrito AGORA prende a CPU depois do ciclo
    // da propria escrita: ela solta no 1o ciclo que cruza a borda do blank.
    int wsyncStall() const
    {
        int t;
        if (clock_ < kVisibleWidth) {
            t = (kVisibleWidth - clock_ + 2) / 3;
        } else {
            const int w = (kColorClocks - clock_ + 2) / 3;  // ciclos ate virar a linha
            const int c = clock_ + 3 * w - kColorClocks;
            t = w + (kVisibleWidth - c + 2) / 3;
        }
        return t - 1;
    }

    bool wsync() const { return wsync_; }
    bool frameReady() const { return frameReady_; }
    void clearFrameReady() { frameReady_ = false; }
    const uint16_t* lineBuffer() const { return line_; }
    // cor TIA (7 bits) -> RGB565 swap; publico para os testes compararem
    uint16_t color565(uint8_t tiaColor) const { return pal_[(tiaColor >> 1) & 0x7F]; }
    // diagnostico: leituras dos gatilhos (o jogo esta consultando o input?)
    uint32_t dbgInptReads(int i) const { return dbg_inpt_[i & 1]; }
    // posicao horizontal atual dos objetos (pixel 0..159): P0,P1,M0,M1,BL
    int dbgPos(int i) const { return pos_[i < 5 ? i : 0]; }
    // leituras por endereco canonico (A0-A3) — diagnostico de input
    uint32_t dbgReadCounter(int a) const { return dbg_reads_all_[a & 0x0F]; }

    void save(emu::StateWriter& w) const;
    bool load(emu::StateReader& r);

private:
    void crossBlank()
    {
        // borda do horizontal blank: fecha os pixels da linha e solta o
        // WSYNC (a CPU prepara a proxima linha nos 68 clocks de blank)
        renderTo(kVisibleWidth);
        wsync_ = false;
    }
    void renderTo(int end);
    void renderSpan(int x, int end, uint16_t pfColor);
    void endLine();
    void clockAudio();
    uint8_t audioPhase(int ch);
    void rebuildObjects();
    void buildPlayer(int i);
    void buildMissile(int i);
    void buildBall();
    void buildPlayfield();
    void clearBit(uint8_t bit);
    void setPixel(int x, uint8_t bit)
    {
        if (x >= kVisibleWidth) x -= kVisibleWidth;
        objs()[x] |= bit;
    }
    uint8_t* objs() { return reinterpret_cast<uint8_t*>(objw_); }
    // grafico/enable que a TIA mostra agora (o latch que o VDEL escolhe)
    uint8_t shownGrp(int i) const { return vdelp_[i] ? grpOld_[i] : grpNew_[i]; }
    uint8_t shownBl() const { return (uint8_t)((vdelbl_ ? enablOld_ : enablNew_) & 0x02); }
    // posicao do RESP: fim do ciclo da escrita + atraso do contador
    int resetPos(int delay) const;
    void hmove();

    // bits por objeto no byte de pixel (e na mascara de remontagem)
    enum : uint8_t {
        kP0 = 1,
        kP1 = 2,
        kM0 = 4,
        kM1 = 8,
        kBl = 16,
        kPf = 32,
        kAll = 0x3F,
    };
    // 160 pixels, um byte cada; uint32 para limpar um objeto em 40 ANDs e o
    // playfield sair em palavras (cada bit do PF cobre 4 pixels alinhados)
    uint32_t objw_[kVisibleWidth / 4] = {0};
    uint8_t dirty_ = kAll;
    // tabelas: prioridade (indice 0 fundo, 1 COLUPF, 2 P0, 3 P1, 4 cor do
    // PF/score) por modo PFP e colisao (bits do collBits_) por combinacao
    uint8_t prio_[2][64] = {{0}};
    uint16_t collTab_[64] = {0};
    // colisoes acumuladas: registrador r usa os bits 2r (D7) e 2r+1 (D6)
    uint16_t collBits_ = 0;

    // registradores
    uint8_t vsync_ = 0, vblank_ = 0, nusiz_[2] = {0, 0}, colup_[2] = {0, 0};
    uint8_t colupf_ = 0, colubk_ = 0, ctrlpf_ = 0, refp_[2] = {0, 0};
    uint8_t pf_[3] = {0, 0, 0};
    // GRP/ENABL tem dois latches (novo/velho): escrever GRP0 copia o novo do
    // GRP1 para o velho; escrever GRP1 copia os novos do GRP0 e do ENABL. O
    // VDELxx escolhe qual deles aparece (kernels de 6 digitos/48 px).
    uint8_t grpNew_[2] = {0, 0}, grpOld_[2] = {0, 0};
    uint8_t enam_[2] = {0, 0}, enablNew_ = 0, enablOld_ = 0;
    uint8_t hmp_[2] = {0, 0}, hmm_[2] = {0, 0}, hmbl_ = 0;
    uint8_t vdelp_[2] = {0, 0}, vdelbl_ = 0;
    uint8_t resmp_[2] = {0, 0};

    // audio (modelo de contadores do chip: divisor de 5 bits, contador de
    // pulso de 4 bits e contador de ruido de 5 bits por canal)
    uint8_t audc_[2] = {0, 0}, audf_[2] = {0, 0}, audv_[2] = {0, 0};
    uint8_t audDiv_[2] = {0, 0}, audPulse_[2] = {0, 0}, audNoise_[2] = {0, 0};
    uint8_t audClkEn_[2] = {0, 0}, audNoiseFb_[2] = {0, 0}, audBit4_[2] = {0, 0};
    uint8_t audHold_[2] = {0, 0};
    int32_t audDc_ = 0;  // filtro de DC (o chip so gera nivel positivo)

    int pos_[5] = {0, 0, 0, 0, 0};  // P0,P1,M0,M1,BL (pixel 0..159)
    int scanline_ = 0, clock_ = 0, visibleY_ = 0, drawn_ = 0;
    bool wsync_ = false, frameReady_ = false;
    // HMOVE no blank: os 8 primeiros pixels da proxima linha saem pretos
    bool combNext_ = false, comb_ = false;
    // Janela visivel da TV: abre quando o VBLANK cai (primeira linha visivel
    // do quadro) e consome TODA linha ate fechar as 192 — inclusive as que o
    // jogo blankar no meio (viram linha PRETA, como no tubo; pular deixava o
    // pixel velho do quadro anterior, ex.: o logo ACTIVISION do titulo do
    // Pitfall aparecendo por cima do jogo).
    bool windowOpen_ = false;

    // entrada: paddles carregam por LINHAS depois que o VBLANK solta o dump
    uint8_t inpt_[2] = {0x80, 0x80};
    uint8_t paddle_[4] = {0, 0, 0, 0};
    uint16_t pot_[4] = {0, 0, 0, 0};
    bool potDump_ = false;

    uint16_t* frame_ = nullptr;
    LineSink sink_ = nullptr;
    void* sinkCtx_ = nullptr;
    void emitLine(int y, const uint16_t* line)
    {
        if (sink_ != nullptr) sink_(sinkCtx_, y, line);
        else if (frame_ != nullptr)
            memcpy(frame_ + (size_t)y * kVisibleWidth, line, sizeof(uint16_t) * kVisibleWidth);
    }
    uint16_t line_[kVisibleWidth] = {0};  // pixels da linha corrente
    uint32_t dbg_inpt_[2] = {0, 0};
    uint32_t dbg_reads_all_[16] = {0};
    uint16_t pal_[128] = {0};
    emu::AudioDownsampler* audio_ = nullptr;
};

}  // namespace a2600
}  // namespace emu
