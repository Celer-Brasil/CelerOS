#pragma once
// TIA do Atari 2600 (video + som + colisoes + WSYNC).
//
// A TIA nao tem framebuffer: ela desenha ENQUANTO o feixe varre a linha. Por
// isso o core avalia um pixel por color clock (228 por linha) com o estado
// dos registradores NAQUELE instante — um COLUPF/GRP escrito no meio da linha
// muda os pixels seguintes, e um RESP no ciclo certo posiciona o sprite.
//
// Modelo de posicao: RESPx/RESMx/RESBL travam `pos = clock` (color clock da
// escrita); HMOVE aplica o deslocamento de -8..+7 dos registradores HMP/HMM/
// HMBL. E o modelo que acerta os kernels de posicionamento da biblioteca.
//
// Saida: 160x192 RGB565 swap (janela visivel: color clocks 68..227), 2 canais
// de audio decimados para 44,1 kHz pelo AudioDownsampler. O framebuffer NAO
// mora no objeto (60 KB iriam para a RAM interna do loader): o blob aponta
// para a scratch via setFramebuffer().

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

    void reset();
    void setFramebuffer(uint16_t* fb) { frame_ = fb; }
    void setAudio(emu::AudioDownsampler* a) { audio_ = a; }
    void setInputs(uint8_t inpt4, uint8_t inpt5, const uint8_t* paddles);

    uint8_t read(uint16_t addr);
    void write(uint16_t addr, uint8_t v);
    void tick();  // 1 ciclo de CPU = 3 color clocks

    bool wsync() const { return wsync_; }
    bool frameReady() const { return frameReady_; }
    void clearFrameReady() { frameReady_ = false; }
    const uint16_t* lineBuffer() const { return line_; }
    // cor TIA (7 bits) -> RGB565 swap; publico para os testes compararem
    uint16_t color565(uint8_t tiaColor) const { return pal_[tiaColor & 0xFE]; }
    // diagnostico: leituras dos gatilhos (o jogo esta consultando o input?)
    uint32_t dbgInptReads(int i) const { return dbg_inpt_[i & 1]; }

    void save(emu::StateWriter& w) const;
    bool load(emu::StateReader& r);

private:
    void tickClock();
    void endLine();
    void clockAudio();
    uint16_t renderPixel(int clock);
    bool playerPixel(int i, int clock) const;
    bool missilePixel(int i, int clock) const;
    bool ballPixel(int clock) const;
    bool playfieldPixel(int clock) const;
    uint8_t playfieldColorIndex(int clock) const;

    // registradores
    uint8_t vsync_ = 0, vblank_ = 0, nusiz_[2] = {0, 0}, colup_[2] = {0, 0};
    uint8_t colupf_ = 0, colubk_ = 0, ctrlpf_ = 0, refp_[2] = {0, 0};
    uint8_t pf_[3] = {0, 0, 0};
    uint8_t grp_[2] = {0, 0}, grpNew_[2] = {0, 0};
    uint8_t enam_[2] = {0, 0}, enabl_ = 0, enablNew_ = 0;
    uint8_t hmp_[2] = {0, 0}, hmm_[2] = {0, 0}, hmbl_ = 0;
    uint8_t vdelp_[2] = {0, 0}, vdelbl_ = 0;
    uint8_t resmp_[2] = {0, 0};
    uint8_t audc_[2] = {0, 0}, audf_[2] = {0, 0}, audv_[2] = {0, 0};
    uint8_t audDiv_[2] = {0, 0};
    uint8_t poly4_ = 0x0F, poly5_ = 0x1F;

    int pos_[5] = {0, 0, 0, 0, 0};  // P0,P1,M0,M1,BL em color clocks
    uint8_t coll_[8] = {0};
    int scanline_ = 0, clock_ = 0, visibleY_ = 0;
    bool wsync_ = false, frameReady_ = false;
    // Janela visivel da TV: abre quando o VBLANK cai (primeira linha visivel
    // do quadro) e consome TODA linha ate fechar as 192 — inclusive as que o
    // jogo blankar no meio (viram linha PRETA, como no tubo; pular deixava o
    // pixel velho do quadro anterior, ex.: o logo ACTIVISION do titulo do
    // Pitfall aparecendo por cima do jogo).
    bool windowOpen_ = false;

    // entrada
    uint8_t inpt_[2] = {0x80, 0x80};
    uint8_t paddle_[4] = {0, 0, 0, 0};
    uint16_t pot_[4] = {0, 0, 0, 0};

    uint16_t* frame_ = nullptr;
    uint16_t line_[kVisibleWidth] = {0};  // pixels da linha corrente
    uint32_t dbg_inpt_[2] = {0, 0};
    uint16_t pal_[256] = {0};
    emu::AudioDownsampler* audio_ = nullptr;
};

}  // namespace a2600
}  // namespace emu
