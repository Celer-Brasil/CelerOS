// TIA (Atari 2600) — implementacao.
//
// O desenho e incremental: cada color clock avalia os registradores NAQUELE
// instante. As posicoes dos objetos sao color clocks travados por RESPx/
// RESMx/RESBL e deslocados por HMOVE. A janela visivel (160 px) sai dos
// color clocks 68..227; a linha inteira tem 228.

#include "tia.h"

namespace emu {
namespace a2600 {
namespace {

// Paleta NTSC aproximada: 16 matizes x 8 luminancias. O TIA usa 7 bits
// (matiz 4 + luminancia 3); o bit 0 e ignorado. Matiz 0 e a escala de cinza.
const uint8_t kHue[16][3] = {
    {255, 255, 255},  // 0 cinza
    {255, 226, 80},   // 1 ouro
    {255, 170, 40},   // 2 laranja
    {255, 110, 40},   // 3 vermelho-laranja
    {255, 60, 110},   // 4 rosa
    {230, 60, 200},   // 5 purpura
    {150, 70, 230},   // 6 violeta
    {80, 100, 255},   // 7 azul-violeta
    {50, 150, 255},   // 8 azul
    {40, 200, 255},   // 9 azul-ciano
    {40, 255, 230},   // 10 ciano
    {60, 255, 140},   // 11 verde-ciano
    {80, 255, 60},    // 12 verde
    {160, 255, 50},   // 13 verde-amarelo
    {230, 255, 60},   // 14 verde-amarelo
    {255, 230, 80},   // 15 amarelo
};

int motionOf(uint8_t reg)
{
    const int m = (reg >> 4) & 0x0F;
    return m >= 8 ? m - 16 : m;
}

bool polyBit(uint8_t type, uint8_t p4, uint8_t p5)
{
    switch (type) {
    case 0: return true;  // constante (sem tom)
    case 1: case 2: case 5: case 10: case 11:
    case 12: case 13: case 14: case 15:
        return (p4 & 1) != 0;
    default:
        return (p5 & 1) != 0;
    }
}

}  // namespace

void Tia::reset()
{
    vsync_ = vblank_ = 0;
    nusiz_[0] = nusiz_[1] = 0;
    colup_[0] = colup_[1] = colupf_ = colubk_ = ctrlpf_ = 0;
    refp_[0] = refp_[1] = 0;
    pf_[0] = pf_[1] = pf_[2] = 0;
    grp_[0] = grp_[1] = grpNew_[0] = grpNew_[1] = 0;
    enam_[0] = enam_[1] = enabl_ = enablNew_ = 0;
    hmp_[0] = hmp_[1] = hmm_[0] = hmm_[1] = hmbl_ = 0;
    vdelp_[0] = vdelp_[1] = vdelbl_ = 0;
    resmp_[0] = resmp_[1] = 0;
    audc_[0] = audc_[1] = audf_[0] = audf_[1] = audv_[0] = audv_[1] = 0;
    audDiv_[0] = audDiv_[1] = 0;
    poly4_ = 0x0F;
    poly5_ = 0x1F;
    for (int i = 0; i < 5; i++) pos_[i] = 0;
    memset(coll_, 0, sizeof(coll_));
    scanline_ = clock_ = visibleY_ = 0;
    wsync_ = frameReady_ = false;
    inpt_[0] = inpt_[1] = 0x80;
    paddle_[0] = paddle_[1] = paddle_[2] = paddle_[3] = 0;
    pot_[0] = pot_[1] = pot_[2] = pot_[3] = 0;
    for (int i = 0; i < kVisibleWidth; i++) line_[i] = 0;
    if (frame_ != nullptr)
        memset(frame_, 0, (size_t)kVisibleWidth * kVisibleHeight * sizeof(uint16_t));

    for (int i = 0; i < 256; i++) {
        const int hue = (i >> 4) & 0x0F;
        const int lum = (i >> 1) & 0x07;
        const int scale = lum * 255 / 7;
        const int r = kHue[hue][0] * scale / 255;
        const int g = kHue[hue][1] * scale / 255;
        const int b = kHue[hue][2] * scale / 255;
        pal_[i] = emu_rgb565((uint8_t)r, (uint8_t)g, (uint8_t)b);
    }
}

void Tia::setInputs(uint8_t inpt4, uint8_t inpt5, const uint8_t* paddles)
{
    inpt_[0] = inpt4;
    inpt_[1] = inpt5;
    if (paddles != nullptr) {
        for (int i = 0; i < 4; i++) paddle_[i] = paddles[i];
    }
}

uint8_t Tia::read(uint16_t addr)
{
    const uint16_t a = addr & 0x3F;
    if (a >= 0x30 && a <= 0x37) {
        const int i = a - 0x30;
        const uint8_t v = coll_[i];
        coll_[i] = 0;  // leitura limpa o registrador de colisao
        return v;
    }
    switch (a) {
    case 0x38: case 0x39: case 0x3A: case 0x3B: {
        const int i = a - 0x38;
        return pot_[i] == 0 ? 0x80 : 0x00;
    }
    case 0x3C: dbg_inpt_[0]++; return inpt_[0];
    case 0x3D: dbg_inpt_[1]++; return inpt_[1];
    case 0x3E: case 0x3F: return 0x80;
    default: return 0;  // registradores write-only
    }
}

void Tia::write(uint16_t addr, uint8_t v)
{
    switch (addr & 0x3F) {
    case 0x00: {
        const bool nv = (v & 0x02) != 0;
        if (vsync_ && !nv) {
            // borda de descida do VSYNC: fecha o quadro. O buffer ainda tem
            // as 192 linhas visiveis do quadro que acabou.
            scanline_ = 0;
            clock_ = 0;
            visibleY_ = 0;
            frameReady_ = true;
        }
        vsync_ = v;
        break;
    }
    case 0x01:
        vblank_ = v;
        if (v & 0x80) {  // dump dos capacitores dos paddles
            for (int i = 0; i < 4; i++)
                pot_[i] = (uint16_t)(12 + paddle_[i] * 12);
        }
        break;
    case 0x02: wsync_ = true; break;
    case 0x03: clock_ = 0; break;
    case 0x04: nusiz_[0] = v; break;
    case 0x05: nusiz_[1] = v; break;
    case 0x06: colup_[0] = v; break;
    case 0x07: colup_[1] = v; break;
    case 0x08: colupf_ = v; break;
    case 0x09: colubk_ = v; break;
    case 0x0A: ctrlpf_ = v; break;
    case 0x0B: refp_[0] = v; break;
    case 0x0C: refp_[1] = v; break;
    case 0x0D: pf_[0] = v; break;
    case 0x0E: pf_[1] = v; break;
    case 0x0F: pf_[2] = v; break;
    case 0x10: pos_[0] = (clock_ < kVisibleWidth) ? clock_ : 0; break;
    case 0x11: pos_[1] = (clock_ < kVisibleWidth) ? clock_ : 0; break;
    case 0x12: pos_[2] = (clock_ < kVisibleWidth) ? clock_ : 0; break;
    case 0x13: pos_[3] = (clock_ < kVisibleWidth) ? clock_ : 0; break;
    case 0x14: pos_[4] = (clock_ < kVisibleWidth) ? clock_ : 0; break;
    case 0x15: audc_[0] = v; break;
    case 0x16: audc_[1] = v; break;
    case 0x17: audf_[0] = v; break;
    case 0x18: audf_[1] = v; break;
    case 0x19: audv_[0] = v; break;
    case 0x1A: audv_[1] = v; break;
    case 0x1B:
        grpNew_[0] = v;
        if (!vdelp_[0]) grp_[0] = v;
        break;
    case 0x1C:
        grpNew_[1] = v;
        if (!vdelp_[1]) grp_[1] = v;
        break;
    case 0x1D: enam_[0] = v; break;
    case 0x1E: enam_[1] = v; break;
    case 0x1F:
        enablNew_ = v;
        if (!vdelbl_) enabl_ = v;
        break;
    case 0x20: hmp_[0] = v; break;
    case 0x21: hmp_[1] = v; break;
    case 0x22: hmm_[0] = v; break;
    case 0x23: hmm_[1] = v; break;
    case 0x24: hmbl_ = v; break;
    case 0x25: vdelp_[0] = v & 0x02; break;
    case 0x26: vdelp_[1] = v & 0x02; break;
    case 0x27: vdelbl_ = v & 0x02; break;
    case 0x28:
        resmp_[0] = v & 0x02;
        if (resmp_[0]) pos_[2] = pos_[0];
        break;
    case 0x29:
        resmp_[1] = v & 0x02;
        if (resmp_[1]) pos_[3] = pos_[1];
        break;
    case 0x2A:  // HMOVE: aplica o deslocamento dos tres registradores
        pos_[0] += motionOf(hmp_[0]);
        pos_[1] += motionOf(hmp_[1]);
        pos_[2] += motionOf(hmm_[0]);
        pos_[3] += motionOf(hmm_[1]);
        pos_[4] += motionOf(hmbl_);
        break;
    case 0x2B:
        hmp_[0] = hmp_[1] = hmm_[0] = hmm_[1] = hmbl_ = 0;
        break;
    case 0x2C: memset(coll_, 0, sizeof(coll_)); break;
    default: break;
    }
}

void Tia::tick()
{
    for (int i = 0; i < 3; i++) tickClock();
    if (audio_ != nullptr) {
        int32_t s = 0;
        for (int ch = 0; ch < 2; ch++) {
            const uint8_t type = (uint8_t)((audc_[ch] >> 4) & 0x0F);
            const bool bit = polyBit(type, poly4_, poly5_);
            const int vol = ((audc_[ch] & 0x0F) * (audv_[ch] & 0x0F) + 7) / 15;
            s += bit ? vol : -vol;
        }
        audio_->push(s * 800);
    }
}

void Tia::tickClock()
{
    const int c = clock_;
    if (c >= kVisibleStart && c < kVisibleStart + kVisibleWidth) {
        line_[c - kVisibleStart] = (vblank_ & 0x02) ? 0 : renderPixel(c);
    }
    clockAudio();
    if (pot_[0] | pot_[1] | pot_[2] | pot_[3]) {
        for (int i = 0; i < 4; i++)
            if (pot_[i] > 0) pot_[i]--;
    }
    clock_++;
    // Borda do horizontal blank: solta o WSYNC (a CPU prepara a proxima
    // linha durante os 68 clocks de blank).
    if (clock_ == kVisibleStart + kVisibleWidth) wsync_ = false;
    if (clock_ >= kColorClocks) endLine();
}

void Tia::endLine()
{
    clock_ = 0;
    if (!(vblank_ & 0x02)) {
        if (visibleY_ < kVisibleHeight && frame_ != nullptr) {
            memcpy(frame_ + (size_t)visibleY_ * kVisibleWidth, line_, sizeof(line_));
            visibleY_++;
        }
    }
    if (vdelp_[0]) grp_[0] = grpNew_[0];
    if (vdelp_[1]) grp_[1] = grpNew_[1];
    if (vdelbl_) enabl_ = enablNew_;
    scanline_++;
    if (scanline_ >= kLines) scanline_ = 0;
}

void Tia::clockAudio()
{
    for (int i = 0; i < 2; i++) {
        const int period = (audf_[i] & 0x1F) + 1;
        audDiv_[i]++;
        if (audDiv_[i] >= period) {
            audDiv_[i] = 0;
            const uint8_t b4 = (uint8_t)(((poly4_ >> 0) ^ (poly4_ >> 1)) & 1);
            poly4_ = (uint8_t)((poly4_ >> 1) | (b4 << 3));
            const uint8_t b5 = (uint8_t)(((poly5_ >> 0) ^ (poly5_ >> 2)) & 1);
            poly5_ = (uint8_t)((poly5_ >> 1) | (b5 << 4));
        }
    }
}

bool Tia::playerPixel(int i, int c) const
{
    const uint8_t n = nusiz_[i];
    int copies = 1, spacing = 16, size = 1;
    switch (n & 0x07) {
    case 0: copies = 1; break;
    case 1: copies = 2; spacing = 16; break;
    case 2: copies = 2; spacing = 32; break;
    case 3: copies = 3; spacing = 16; break;
    case 4: copies = 2; spacing = 64; break;
    case 5: size = 2; break;
    case 6: copies = 3; spacing = 32; break;
    case 7: size = 4; break;
    }
    const int width = 8 * size;
    for (int k = 0; k < copies; k++) {
        const int start = pos_[i] + k * spacing;
        const int d = c - start;
        if (d < 0 || d >= width) continue;
        int bitIdx = d / size;
        if (refp_[i] & 0x08) bitIdx = 7 - bitIdx;
        if ((grp_[i] >> (7 - bitIdx)) & 1) return true;
    }
    return false;
}

bool Tia::missilePixel(int i, int c) const
{
    if ((enam_[i] & 0x02) == 0) return false;
    const uint8_t n = nusiz_[i];
    const int width = 1 << ((n >> 4) & 0x03);
    int copies = 1, spacing = 16;
    switch (n & 0x07) {
    case 0: copies = 1; break;
    case 1: copies = 2; spacing = 16; break;
    case 2: copies = 2; spacing = 32; break;
    case 3: copies = 3; spacing = 16; break;
    case 4: copies = 2; spacing = 64; break;
    case 5: copies = 1; break;
    case 6: copies = 3; spacing = 32; break;
    case 7: copies = 1; break;
    }
    for (int k = 0; k < copies; k++) {
        const int start = pos_[2 + i] + k * spacing;
        if (c >= start && c < start + width) return true;
    }
    return false;
}

bool Tia::ballPixel(int c) const
{
    if ((enabl_ & 0x02) == 0) return false;
    int width = 1;
    switch ((ctrlpf_ >> 4) & 0x03) {
    case 0: width = 1; break;
    case 1: width = 2; break;
    case 2: width = 4; break;
    case 3: width = 8; break;
    }
    return c >= pos_[4] && c < pos_[4] + width;
}

bool Tia::playfieldPixel(int c) const
{
    // O playfield comeca a varrer no FIM do horizontal blank (borda esquerda
    // do vidro), nao no clock 0 da linha: 20 bits de 4 color clocks cobrem a
    // metade esquerda dos 160 visiveis; a direita duplica (CTRLPF D0=0) ou
    // espelha (D0=1). `c` e o color clock da LINHA (0..227).
    int p = c - kVisibleStart;
    if (p < 0 || p >= kVisibleWidth) return false;
    if (ctrlpf_ & 0x01) {  // reflect: segunda metade espelhada
        if (p >= 80) p = 159 - p;
    } else {
        p %= 80;
    }
    const int idx = p >> 2;  // 20 bits de 4 color clocks cada
    if (idx < 4) return (pf_[0] & (0x10 << idx)) != 0;
    if (idx < 12) return (pf_[1] & (0x80 >> (idx - 4))) != 0;
    return (pf_[2] & (0x01 << (idx - 12))) != 0;
}

uint8_t Tia::playfieldColorIndex(int c) const
{
    if (ctrlpf_ & 0x02) {  // score: metade esquerda COLUP0, direita COLUP1
        return (c - kVisibleStart) < (kVisibleWidth / 2) ? colup_[0] : colup_[1];
    }
    return colupf_;
}

uint16_t Tia::renderPixel(int c)
{
    const bool p0 = playerPixel(0, c), p1 = playerPixel(1, c);
    const bool m0 = missilePixel(0, c), m1 = missilePixel(1, c);
    const bool bl = ballPixel(c);
    const bool pf = playfieldPixel(c);

    if (m0 && p1) coll_[0] |= 0x80;
    if (m0 && p0) coll_[0] |= 0x40;
    if (m1 && p0) coll_[1] |= 0x80;
    if (m1 && p1) coll_[1] |= 0x40;
    if (p0 && pf) coll_[2] |= 0x80;
    if (p0 && bl) coll_[2] |= 0x40;
    if (p1 && pf) coll_[3] |= 0x80;
    if (p1 && bl) coll_[3] |= 0x40;
    if (m0 && pf) coll_[4] |= 0x80;
    if (m0 && bl) coll_[4] |= 0x40;
    if (m1 && pf) coll_[5] |= 0x80;
    if (m1 && bl) coll_[5] |= 0x40;
    if (bl && pf) coll_[6] |= 0x80;
    if (p0 && p1) coll_[7] |= 0x80;
    if (m0 && m1) coll_[7] |= 0x40;

    if (ctrlpf_ & 0x04) {  // prioridade do playfield
        if (pf) return color565(playfieldColorIndex(c));
        if (p0 || m0) return color565(colup_[0]);
        if (p1 || m1) return color565(colup_[1]);
        if (bl) return color565(colupf_);
        return color565(colubk_);
    }
    if (p0 || m0) return color565(colup_[0]);
    if (p1 || m1) return color565(colup_[1]);
    if (pf) return color565(playfieldColorIndex(c));
    if (bl) return color565(colupf_);
    return color565(colubk_);
}

void Tia::save(emu::StateWriter& w) const
{
    w.begin(emu::kTagTia);
    w.u8(vsync_);
    w.u8(vblank_);
    w.u8(nusiz_[0]);
    w.u8(nusiz_[1]);
    w.u8(colup_[0]);
    w.u8(colup_[1]);
    w.u8(colupf_);
    w.u8(colubk_);
    w.u8(ctrlpf_);
    w.u8(refp_[0]);
    w.u8(refp_[1]);
    w.u8(pf_[0]);
    w.u8(pf_[1]);
    w.u8(pf_[2]);
    w.u8(grp_[0]);
    w.u8(grp_[1]);
    w.u8(grpNew_[0]);
    w.u8(grpNew_[1]);
    w.u8(enam_[0]);
    w.u8(enam_[1]);
    w.u8(enabl_);
    w.u8(enablNew_);
    w.u8(hmp_[0]);
    w.u8(hmp_[1]);
    w.u8(hmm_[0]);
    w.u8(hmm_[1]);
    w.u8(hmbl_);
    w.u8(vdelp_[0]);
    w.u8(vdelp_[1]);
    w.u8(vdelbl_);
    w.u8(resmp_[0]);
    w.u8(resmp_[1]);
    w.u8(audc_[0]);
    w.u8(audc_[1]);
    w.u8(audf_[0]);
    w.u8(audf_[1]);
    w.u8(audv_[0]);
    w.u8(audv_[1]);
    w.u8(audDiv_[0]);
    w.u8(audDiv_[1]);
    w.u8(poly4_);
    w.u8(poly5_);
    for (int i = 0; i < 5; i++) w.u16((uint16_t)pos_[i]);
    w.bytes(coll_, 8);
    w.u16((uint16_t)scanline_);
    w.u16((uint16_t)clock_);
    w.u16((uint16_t)visibleY_);
    w.u8(wsync_ ? 1 : 0);
    w.u8(frameReady_ ? 1 : 0);
    w.u8(inpt_[0]);
    w.u8(inpt_[1]);
    w.bytes(paddle_, 4);
    for (int i = 0; i < 4; i++) w.u16(pot_[i]);
    w.end();
}

bool Tia::load(emu::StateReader& r)
{
    if (!r.find(emu::kTagTia)) return false;
    vsync_ = r.u8();
    vblank_ = r.u8();
    nusiz_[0] = r.u8();
    nusiz_[1] = r.u8();
    colup_[0] = r.u8();
    colup_[1] = r.u8();
    colupf_ = r.u8();
    colubk_ = r.u8();
    ctrlpf_ = r.u8();
    refp_[0] = r.u8();
    refp_[1] = r.u8();
    pf_[0] = r.u8();
    pf_[1] = r.u8();
    pf_[2] = r.u8();
    grp_[0] = r.u8();
    grp_[1] = r.u8();
    grpNew_[0] = r.u8();
    grpNew_[1] = r.u8();
    enam_[0] = r.u8();
    enam_[1] = r.u8();
    enabl_ = r.u8();
    enablNew_ = r.u8();
    hmp_[0] = r.u8();
    hmp_[1] = r.u8();
    hmm_[0] = r.u8();
    hmm_[1] = r.u8();
    hmbl_ = r.u8();
    vdelp_[0] = r.u8();
    vdelp_[1] = r.u8();
    vdelbl_ = r.u8();
    resmp_[0] = r.u8();
    resmp_[1] = r.u8();
    audc_[0] = r.u8();
    audc_[1] = r.u8();
    audf_[0] = r.u8();
    audf_[1] = r.u8();
    audv_[0] = r.u8();
    audv_[1] = r.u8();
    audDiv_[0] = r.u8();
    audDiv_[1] = r.u8();
    poly4_ = r.u8();
    poly5_ = r.u8();
    for (int i = 0; i < 5; i++) pos_[i] = (int16_t)r.u16();
    r.bytes(coll_, 8);
    scanline_ = (int16_t)r.u16();
    clock_ = (int16_t)r.u16();
    visibleY_ = (int16_t)r.u16();
    wsync_ = r.u8() != 0;
    frameReady_ = r.u8() != 0;
    inpt_[0] = r.u8();
    inpt_[1] = r.u8();
    r.bytes(paddle_, 4);
    for (int i = 0; i < 4; i++) pot_[i] = r.u16();
    return r.ok();
}

}  // namespace a2600
}  // namespace emu
