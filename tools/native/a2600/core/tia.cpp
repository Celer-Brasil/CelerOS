// TIA (Atari 2600) — implementacao.
//
// O desenho e preguicoso: o tick so anda o relogio e renderTo() pinta o
// trecho de pixels ainda nao desenhado com o estado ATUAL dos registradores,
// chamado antes de cada escrita (o estado so muda nelas), de cada leitura de
// colisao e na borda do blank. As posicoes sao pixels 0..159 travados por
// RESPx/RESMx/RESBL e deslocados por HMOVE.

#include "tia.h"

namespace emu {
namespace a2600 {
namespace {

// Paleta NTSC (a mesma tabela de 128 cores do Stella): indice = cor >> 1
// (matiz nos 4 bits altos, luminancia nos 3 seguintes; o bit 0 e ignorado).
const uint32_t kNtsc[128] = {
    0x000000, 0x4a4a4a, 0x6f6f6f, 0x8e8e8e, 0xaaaaaa, 0xc0c0c0, 0xd6d6d6, 0xececec,
    0x484800, 0x69690f, 0x86861d, 0xa2a22a, 0xbbbb35, 0xd2d240, 0xe8e84a, 0xfcfc54,
    0x7c2c00, 0x904811, 0xa26221, 0xb47a30, 0xc3903d, 0xd2a44a, 0xdfb755, 0xecc860,
    0x901c00, 0xa33915, 0xb55328, 0xc66c3a, 0xd5824a, 0xe39759, 0xf0aa67, 0xfcbc74,
    0x940000, 0xa71a1a, 0xb83232, 0xc84848, 0xd65c5c, 0xe46f6f, 0xf08080, 0xfc9090,
    0x840064, 0x97197a, 0xa8308f, 0xb846a2, 0xc659b3, 0xd46cc3, 0xe07cd2, 0xec8ce0,
    0x500084, 0x68199a, 0x7d30ad, 0x9246c0, 0xa459d0, 0xb56ce0, 0xc57cee, 0xd48cfc,
    0x140090, 0x331aa3, 0x4e32b5, 0x6848c6, 0x7f5cd5, 0x956fe3, 0xa980f0, 0xbc90fc,
    0x000094, 0x181aa7, 0x2d32b8, 0x4248c8, 0x545cd6, 0x656fe4, 0x7580f0, 0x8490fc,
    0x001c88, 0x183b9d, 0x2d57b0, 0x4272c2, 0x548ad2, 0x65a0e1, 0x75b5ef, 0x84c8fc,
    0x003064, 0x185080, 0x2d6d98, 0x4288b0, 0x54a0c5, 0x65b7d9, 0x75cceb, 0x84e0fc,
    0x004030, 0x18624e, 0x2d8169, 0x429e82, 0x54b899, 0x65d1ae, 0x75e7c2, 0x84fcd4,
    0x004400, 0x1a661a, 0x328432, 0x48a048, 0x5cba5c, 0x6fd26f, 0x80e880, 0x90fc90,
    0x143c00, 0x355f18, 0x527e2d, 0x6e9c42, 0x87b754, 0x9ed065, 0xb4e775, 0xc8fc84,
    0x303800, 0x505916, 0x6d762b, 0x88923e, 0xa0ab4f, 0xb7c25f, 0xccd86e, 0xe0ec7c,
    0x482c00, 0x694d14, 0x866a26, 0xa28638, 0xbb9f47, 0xd2b656, 0xe8cc63, 0xfce070,
};

// HMxx: nibble alto com sinal; positivo move para a ESQUERDA
int motionOf(uint8_t reg)
{
    const int m = (reg >> 4) & 0x0F;
    return m >= 8 ? m - 16 : m;
}

int wrapX(int x)
{
    while (x < 0) x += Tia::kVisibleWidth;
    while (x >= Tia::kVisibleWidth) x -= Tia::kVisibleWidth;
    return x;
}

// NUSIZ: copias e espacamento (players e misseis compartilham)
void nusizCopies(uint8_t n, int& copies, int& spacing)
{
    copies = 1;
    spacing = 16;
    switch (n & 0x07) {
    case 1: copies = 2; spacing = 16; break;
    case 2: copies = 2; spacing = 32; break;
    case 3: copies = 3; spacing = 16; break;
    case 4: copies = 2; spacing = 64; break;
    case 6: copies = 3; spacing = 32; break;
    default: break;
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
    grpNew_[0] = grpNew_[1] = grpOld_[0] = grpOld_[1] = 0;
    enam_[0] = enam_[1] = enablNew_ = enablOld_ = 0;
    hmp_[0] = hmp_[1] = hmm_[0] = hmm_[1] = hmbl_ = 0;
    vdelp_[0] = vdelp_[1] = vdelbl_ = 0;
    resmp_[0] = resmp_[1] = 0;
    for (int ch = 0; ch < 2; ch++) {
        audc_[ch] = audf_[ch] = audv_[ch] = 0;
        audDiv_[ch] = audPulse_[ch] = audNoise_[ch] = 0;
        audClkEn_[ch] = audNoiseFb_[ch] = audBit4_[ch] = audHold_[ch] = 0;
    }
    audDc_ = 0;
    for (int i = 0; i < 5; i++) pos_[i] = 0;
    collBits_ = 0;
    scanline_ = clock_ = visibleY_ = drawn_ = 0;
    wsync_ = frameReady_ = false;
    combNext_ = comb_ = false;
    windowOpen_ = false;
    memset(objw_, 0, sizeof(objw_));
    dirty_ = kAll;
    inpt_[0] = inpt_[1] = 0x80;
    paddle_[0] = paddle_[1] = paddle_[2] = paddle_[3] = 0;
    pot_[0] = pot_[1] = pot_[2] = pot_[3] = 0;
    potDump_ = false;
    for (int i = 0; i < kVisibleWidth; i++) line_[i] = 0;
    if (frame_ != nullptr)
        memset(frame_, 0, (size_t)kVisibleWidth * kVisibleHeight * sizeof(uint16_t));

    for (int i = 0; i < 128; i++) {
        const uint32_t c = kNtsc[i];
        pal_[i] = emu_rgb565((uint8_t)(c >> 16), (uint8_t)(c >> 8), (uint8_t)c);
    }

    // Tabelas por combinacao de objetos no pixel (bits kP0..kPf). Sem o
    // blob ter construtores estaticos, montar aqui custa 128 iteracoes por
    // reset e tira a geometria do laco de pixel.
    for (int k = 0; k < 64; k++) {
        const bool p0 = (k & kP0) != 0, p1 = (k & kP1) != 0;
        const bool m0 = (k & kM0) != 0, m1 = (k & kM1) != 0;
        const bool bl = (k & kBl) != 0, pf = (k & kPf) != 0;
        uint8_t n = 0, f = 0;  // 0 fundo, 1 COLUPF (bola), 2 P0, 3 P1, 4 PF
        if (p0 || m0) n = 2;
        else if (p1 || m1) n = 3;
        else if (pf) n = 4;
        else if (bl) n = 1;
        if (pf) f = 4;
        else if (bl) f = 1;
        else if (p0 || m0) f = 2;
        else if (p1 || m1) f = 3;
        prio_[0][k] = n;
        prio_[1][k] = f;
        uint16_t c = 0;
        if (m0 && p1) c |= 1u << 0;   // CXM0P  D7
        if (m0 && p0) c |= 1u << 1;   //        D6
        if (m1 && p0) c |= 1u << 2;   // CXM1P  D7
        if (m1 && p1) c |= 1u << 3;   //        D6
        if (p0 && pf) c |= 1u << 4;   // CXP0FB D7
        if (p0 && bl) c |= 1u << 5;   //        D6
        if (p1 && pf) c |= 1u << 6;   // CXP1FB D7
        if (p1 && bl) c |= 1u << 7;   //        D6
        if (m0 && pf) c |= 1u << 8;   // CXM0FB D7
        if (m0 && bl) c |= 1u << 9;   //        D6
        if (m1 && pf) c |= 1u << 10;  // CXM1FB D7
        if (m1 && bl) c |= 1u << 11;  //        D6
        if (bl && pf) c |= 1u << 12;  // CXBLPF D7
        if (p0 && p1) c |= 1u << 14;  // CXPPMM D7
        if (m0 && m1) c |= 1u << 15;  //        D6
        collTab_[k] = c;
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
    // O TIA ignora A4/A5 nas LEITURAS: o decode e A0-A3. Por isso INPT4
    // aparece em 0x0C e espelha em 0x1C/0x2C/0x3C, e as colisoes em
    // 0x00-0x07 espelham em 0x10/0x20/0x30.
    const uint16_t a = addr & 0x0F;
    dbg_reads_all_[a]++;
    if (a <= 0x07) {
        // colisao ate o pixel atual; a leitura NAO limpa (so o CXCLR)
        renderTo(clock_);
        const unsigned b = (collBits_ >> (2 * a)) & 3u;
        return (uint8_t)(((b & 1u) << 7) | ((b & 2u) << 5));
    }
    if (a <= 0x0B) {
        if (potDump_) return 0x00;  // capacitor aterrado pelo VBLANK D7
        return pot_[a - 0x08] == 0 ? 0x80 : 0x00;
    }
    if (a == 0x0C) { dbg_inpt_[0]++; return inpt_[0]; }
    if (a == 0x0D) { dbg_inpt_[1]++; return inpt_[1]; }
    return 0x80;  // 0x0E/0x0F: indefinidos
}

int Tia::resetPos(int delay) const
{
    // a escrita vale no FIM do ciclo de CPU (clock_ e o inicio dele)
    int e = clock_ + 3;
    if (e >= kColorClocks) e -= kColorClocks;
    if (e < kVisibleWidth) return wrapX(e + delay);
    return delay - 2;  // no blank: borda esquerda (3 player, 2 missil/bola)
}

void Tia::hmove()
{
    // Kernels da Activision dao HMOVE em TODA linha com HM quase sempre 0:
    // so remonta o objeto que andou de fato.
    const uint8_t hm[5] = {hmp_[0], hmp_[1], hmm_[0], hmm_[1], hmbl_};
    const uint8_t bit[5] = {kP0, kP1, kM0, kM1, kBl};
    for (int i = 0; i < 5; i++) {
        const int m = motionOf(hm[i]);
        if (m == 0) continue;
        pos_[i] = wrapX(pos_[i] - m);
        dirty_ |= bit[i];
    }
    // HMOVE no blank estende o blank da proxima linha em 8 pixels
    if (clock_ >= kVisibleWidth) combNext_ = true;
}

void Tia::write(uint16_t addr, uint8_t v)
{
    const uint8_t a = (uint8_t)(addr & 0x3F);
    // audio nao muda pixel; WSYNC so para a CPU
    if (a != 0x02 && (a < 0x15 || a > 0x1A)) renderTo(clock_ + 3);
    switch (a) {
    case 0x00: {
        const bool nv = (v & 0x02) != 0;
        if (vsync_ && !nv) {
            // borda de descida do VSYNC: fecha o quadro. As linhas que o
            // quadro NAO desenhou (jogo com area ativa menor que 192, ex.:
            // Pitfall em gameplay) viram PRETO — sem isso ficava o pixel do
            // quadro anterior (o logo ACTIVISION do titulo por cima do jogo).
            // O relogio horizontal NAO zera: o VSYNC nao mexe na linha.
            static const uint16_t kBlack[kVisibleWidth] = {0};
            for (int y = visibleY_; y < kVisibleHeight; y++) emitLine(y, kBlack);
            scanline_ = 0;
            visibleY_ = 0;
            windowOpen_ = false;
            frameReady_ = true;
        }
        vsync_ = v;
        break;
    }
    case 0x01:
        vblank_ = v;
        if (v & 0x80) {
            potDump_ = true;  // capacitores dos paddles descarregando
        } else if (potDump_) {
            // soltou o dump: cada paddle carrega em 1..192 linhas
            potDump_ = false;
            for (int i = 0; i < 4; i++) pot_[i] = (uint16_t)(1 + (paddle_[i] * 3) / 4);
        }
        break;
    case 0x02: wsync_ = true; break;
    case 0x03: clock_ = 0; drawn_ = 0; break;  // RSYNC
    case 0x04: if (nusiz_[0] != v) { nusiz_[0] = v; dirty_ |= kP0 | kM0; } break;
    case 0x05: if (nusiz_[1] != v) { nusiz_[1] = v; dirty_ |= kP1 | kM1; } break;
    case 0x06: colup_[0] = v; break;
    case 0x07: colup_[1] = v; break;
    case 0x08: colupf_ = v; break;
    case 0x09: colubk_ = v; break;
    case 0x0A:
        if ((ctrlpf_ ^ v) & 0x31) dirty_ |= kPf | kBl;  // reflexo e tamanho da bola
        ctrlpf_ = v;
        break;
    case 0x0B: if ((refp_[0] ^ v) & 0x08) dirty_ |= kP0; refp_[0] = v; break;
    case 0x0C: if ((refp_[1] ^ v) & 0x08) dirty_ |= kP1; refp_[1] = v; break;
    case 0x0D: if ((pf_[0] ^ v) & 0xF0) dirty_ |= kPf; pf_[0] = v; break;
    case 0x0E: if (pf_[1] != v) dirty_ |= kPf; pf_[1] = v; break;
    case 0x0F: if (pf_[2] != v) dirty_ |= kPf; pf_[2] = v; break;
    case 0x10: pos_[0] = resetPos(5); dirty_ |= kP0; break;
    case 0x11: pos_[1] = resetPos(5); dirty_ |= kP1; break;
    case 0x12: if (!resmp_[0]) { pos_[2] = resetPos(4); dirty_ |= kM0; } break;
    case 0x13: if (!resmp_[1]) { pos_[3] = resetPos(4); dirty_ |= kM1; } break;
    case 0x14: pos_[4] = resetPos(4); dirty_ |= kBl; break;
    case 0x15: audc_[0] = v & 0x0F; break;
    case 0x16: audc_[1] = v & 0x0F; break;
    case 0x17: audf_[0] = v & 0x1F; break;
    case 0x18: audf_[1] = v & 0x1F; break;
    case 0x19: audv_[0] = v & 0x0F; break;
    case 0x1A: audv_[1] = v & 0x0F; break;
    // GRP/ENA: remonta so quando o grafico VISIVEL muda (os jogos escrevem
    // GRP0 = 0 em quase toda linha sem sprite)
    case 0x1B: {
        const uint8_t s0 = shownGrp(0), s1 = shownGrp(1);
        grpNew_[0] = v;
        grpOld_[1] = grpNew_[1];
        if (shownGrp(0) != s0) dirty_ |= kP0;
        if (shownGrp(1) != s1) dirty_ |= kP1;
        break;
    }
    case 0x1C: {
        const uint8_t s0 = shownGrp(0), s1 = shownGrp(1), sb = shownBl();
        grpNew_[1] = v;
        grpOld_[0] = grpNew_[0];
        enablOld_ = enablNew_;
        if (shownGrp(0) != s0) dirty_ |= kP0;
        if (shownGrp(1) != s1) dirty_ |= kP1;
        if (shownBl() != sb) dirty_ |= kBl;
        break;
    }
    case 0x1D: if ((enam_[0] ^ v) & 0x02) dirty_ |= kM0; enam_[0] = v; break;
    case 0x1E: if ((enam_[1] ^ v) & 0x02) dirty_ |= kM1; enam_[1] = v; break;
    case 0x1F: {
        const uint8_t sb = shownBl();
        enablNew_ = v;
        if (shownBl() != sb) dirty_ |= kBl;
        break;
    }
    case 0x20: hmp_[0] = v; break;
    case 0x21: hmp_[1] = v; break;
    case 0x22: hmm_[0] = v; break;
    case 0x23: hmm_[1] = v; break;
    case 0x24: hmbl_ = v; break;
    case 0x25: if (vdelp_[0] != (v & 0x01)) { vdelp_[0] = v & 0x01; dirty_ |= kP0; } break;
    case 0x26: if (vdelp_[1] != (v & 0x01)) { vdelp_[1] = v & 0x01; dirty_ |= kP1; } break;
    case 0x27: if (vdelbl_ != (v & 0x01)) { vdelbl_ = v & 0x01; dirty_ |= kBl; } break;
    case 0x28:
    case 0x29: {
        // RESMPx: missil travado no centro do player e escondido; ao soltar
        // ele fica nessa posicao
        const int i = a - 0x28;
        const uint8_t nv = v & 0x02;
        if (resmp_[i] && !nv) {
            const int size = nusiz_[i] & 0x07;
            const int center = size == 5 ? 6 : (size == 7 ? 10 : 3);
            pos_[2 + i] = wrapX(pos_[i] + center);
        }
        resmp_[i] = nv;
        dirty_ |= (uint8_t)(i == 0 ? kM0 : kM1);
        break;
    }
    case 0x2A: hmove(); break;
    case 0x2B:
        hmp_[0] = hmp_[1] = hmm_[0] = hmm_[1] = hmbl_ = 0;
        break;
    case 0x2C: collBits_ = 0; break;
    default: break;
    }
}

void Tia::renderTo(int end)
{
    if (end > kVisibleWidth) end = kVisibleWidth;
    int x = drawn_;
    if (x >= end) return;
    drawn_ = end;
    if (vblank_ & 0x02) {
        for (; x < end; x++) line_[x] = 0;
        return;
    }
    if (comb_ && x < 8) {
        const int e = end < 8 ? end : 8;
        for (; x < e; x++) line_[x] = 0;
        if (x >= end) return;
    }
    if (dirty_ != 0) rebuildObjects();
    if (ctrlpf_ & 0x02) {  // score: PF da metade esquerda COLUP0, direita COLUP1
        const int half = kVisibleWidth / 2;
        if (x < half) {
            const int e = end < half ? end : half;
            renderSpan(x, e, color565(colup_[0]));
            x = e;
        }
        if (x < end) renderSpan(x, end, color565(colup_[1]));
        return;
    }
    renderSpan(x, end, color565(colupf_));
}

void Tia::renderSpan(int x, int end, uint16_t pfColor)
{
    const uint16_t col[5] = {color565(colubk_), color565(colupf_), color565(colup_[0]),
                             color565(colup_[1]), pfColor};
    const uint8_t* pri = prio_[(ctrlpf_ & 0x04) ? 1 : 0];
    const uint8_t* o = objs();
    uint16_t acc = 0;
    // Caminho rapido de 4 em 4 (palavra de objw_ alinhada): fundo puro ou
    // playfield puro, o grosso da tela, nao colidem e tem cor unica.
    const uint32_t pfWord = (uint32_t)kPf * 0x01010101u;
    while (x < end) {
        if ((x & 3) == 0 && x + 4 <= end) {
            const uint32_t w = objw_[x >> 2];
            if (w == 0 || w == pfWord) {
                const uint16_t c = col[pri[w & 0xFF]];
                line_[x] = c;
                line_[x + 1] = c;
                line_[x + 2] = c;
                line_[x + 3] = c;
                x += 4;
                continue;
            }
        }
        const uint8_t k = o[x];
        acc |= collTab_[k];
        line_[x] = col[pri[k]];
        x++;
    }
    collBits_ |= acc;
}

void Tia::endLine()
{
    renderTo(kVisibleWidth);  // RSYNC pode ter pulado a borda do blank
    // A janela de 192 linhas abre na primeira linha com o feixe aceso depois
    // do VSYNC; dai em diante TODA linha consome uma, mesmo as que o jogo
    // blankar no meio (line_ ja veio preenchida de preto no renderTo).
    if (!windowOpen_ && visibleY_ == 0 && !(vblank_ & 0x02)) windowOpen_ = true;
    if (windowOpen_) {
        if (visibleY_ < kVisibleHeight) {
            emitLine(visibleY_, line_);
            visibleY_++;
        }
        if (visibleY_ >= kVisibleHeight) windowOpen_ = false;
    }
    drawn_ = 0;
    comb_ = combNext_;
    combNext_ = false;
    if (!potDump_) {
        for (int i = 0; i < 4; i++)
            if (pot_[i] > 0) pot_[i]--;
    }
    clockAudio();
    scanline_++;
    if (scanline_ >= kLines) scanline_ = 0;
}

// Um canal = divisor de frequencia (AUDF) + contador de pulso (4 bits) +
// contador de ruido (5 bits), com o AUDC escolhendo as realimentacoes. E o
// modelo de contadores do chip (o mesmo do Stella): fase 0 decide hold/
// realimentacao do ruido, fase 1 desloca os contadores; a saida e o bit 0 do
// contador de pulso vezes o volume.
uint8_t Tia::audioPhase(int ch)
{
    const uint8_t audc = audc_[ch];
    // fase 0
    if (audClkEn_[ch]) {
        const uint8_t noise = audNoise_[ch], pulse = audPulse_[ch];
        audBit4_[ch] = noise & 0x01;
        switch (audc & 0x03) {
        case 0x02: audHold_[ch] = (noise & 0x1E) != 0x02; break;
        case 0x03: audHold_[ch] = !audBit4_[ch]; break;
        default: audHold_[ch] = 0; break;
        }
        if ((audc & 0x03) == 0)
            audNoiseFb_[ch] = (((pulse ^ noise) & 0x01) != 0) || (noise == 0 && pulse == 0x0A) ||
                              (audc & 0x0C) == 0;
        else
            audNoiseFb_[ch] = ((((noise & 0x04) ? 1 : 0) ^ (noise & 0x01)) != 0) || noise == 0;
    }
    audClkEn_[ch] = audDiv_[ch] == audf_[ch];
    if (audDiv_[ch] == audf_[ch] || audDiv_[ch] == 0x1F) audDiv_[ch] = 0;
    else audDiv_[ch]++;

    // fase 1
    if (audClkEn_[ch]) {
        const uint8_t pulse = audPulse_[ch];
        bool fb = false;
        switch (audc >> 2) {
        case 0x00:
            fb = ((((pulse & 0x02) ? 1 : 0) ^ (pulse & 0x01)) != 0) && pulse != 0x0A &&
                 (audc & 0x03) != 0;
            break;
        case 0x01: fb = (pulse & 0x08) == 0; break;
        case 0x02: fb = !audBit4_[ch]; break;
        default: fb = !((pulse & 0x02) != 0 || (pulse & 0x0E) == 0); break;
        }
        audNoise_[ch] = (uint8_t)(audNoise_[ch] >> 1);
        if (audNoiseFb_[ch]) audNoise_[ch] |= 0x10;
        if (!audHold_[ch]) {
            audPulse_[ch] = (uint8_t)(~(pulse >> 1) & 0x07);
            if (fb) audPulse_[ch] |= 0x08;
        }
    }
    return (uint8_t)((audPulse_[ch] & 0x01) * audv_[ch]);
}

void Tia::clockAudio()
{
    // duas amostras por linha (31,4 kHz)
    for (int i = 0; i < 2; i++) {
        const int32_t v = audioPhase(0) + audioPhase(1);
        if (audio_ == nullptr) continue;
        // 0..30 -> nivel positivo; o filtro de DC centra a onda em zero
        const int32_t s = v * 900;
        audDc_ += ((s << 8) - audDc_) >> 9;
        audio_->push(s - (audDc_ >> 8));
    }
}

void Tia::clearBit(uint8_t bit)
{
    const uint32_t m = ~((uint32_t)bit * 0x01010101u);
    for (int i = 0; i < kVisibleWidth / 4; i++) objw_[i] &= m;
}

void Tia::buildPlayfield()
{
    // 20 bits por metade, cada bit = 4 pixels = uma palavra de objw_
    const uint32_t on = (uint32_t)kPf * 0x01010101u;
    for (int k = 0; k < 20; k++) {
        bool l;
        if (k < 4) l = (pf_[0] & (0x10 << k)) != 0;
        else if (k < 12) l = (pf_[1] & (0x80 >> (k - 4))) != 0;
        else l = (pf_[2] & (0x01 << (k - 12))) != 0;
        const int right = (ctrlpf_ & 0x01) ? 39 - k : 20 + k;
        if (l) {
            objw_[k] |= on;
            objw_[right] |= on;
        } else {
            objw_[k] &= ~on;
            objw_[right] &= ~on;
        }
    }
}

void Tia::buildPlayer(int i)
{
    const uint8_t bit = i == 0 ? kP0 : kP1;
    clearBit(bit);
    const uint8_t g = shownGrp(i);
    if (g == 0) return;
    const uint8_t n = nusiz_[i] & 0x07;
    int copies, spacing;
    nusizCopies(n, copies, spacing);
    // largura dupla/quadrupla comeca 1 pixel depois (atraso do escalador)
    const int shift = n == 5 ? 1 : (n == 7 ? 2 : 0);
    const int lead = shift ? 1 : 0;
    const int width = 8 << shift;
    const bool reflect = (refp_[i] & 0x08) != 0;
    // grafico na ordem da tela (bit 7 primeiro; REFP inverte)
    uint8_t gs = g;
    if (!reflect) {
        gs = (uint8_t)(((g & 0x01) << 7) | ((g & 0x02) << 5) | ((g & 0x04) << 3) |
                       ((g & 0x08) << 1) | ((g & 0x10) >> 1) | ((g & 0x20) >> 3) |
                       ((g & 0x40) >> 5) | ((g & 0x80) >> 7));
    }
    uint8_t* o = objs();
    for (int k = 0; k < copies; k++) {
        const int start = pos_[i] + k * spacing + lead;
        if (start + width <= kVisibleWidth) {
            uint8_t* p = o + start;
            for (int d = 0; d < width; d++)
                if ((gs >> (d >> shift)) & 1) p[d] |= bit;
            continue;
        }
        for (int d = 0; d < width; d++)
            if ((gs >> (d >> shift)) & 1) setPixel(start + d, bit);
    }
}

void Tia::buildMissile(int i)
{
    const uint8_t bit = i == 0 ? kM0 : kM1;
    clearBit(bit);
    if ((enam_[i] & 0x02) == 0 || resmp_[i]) return;
    const uint8_t n = nusiz_[i];
    const int width = 1 << ((n >> 4) & 0x03);
    int copies, spacing;
    nusizCopies(n, copies, spacing);
    for (int k = 0; k < copies; k++) {
        const int start = pos_[2 + i] + k * spacing;
        for (int d = 0; d < width; d++) setPixel(start + d, bit);
    }
}

void Tia::buildBall()
{
    clearBit(kBl);
    if (shownBl() == 0) return;
    const int width = 1 << ((ctrlpf_ >> 4) & 0x03);
    for (int d = 0; d < width; d++) setPixel(pos_[4] + d, kBl);
}

void Tia::rebuildObjects()
{
    const uint8_t d = dirty_;
    dirty_ = 0;
    if (d & kPf) buildPlayfield();
    if (d & kP0) buildPlayer(0);
    if (d & kP1) buildPlayer(1);
    if (d & kM0) buildMissile(0);
    if (d & kM1) buildMissile(1);
    if (d & kBl) buildBall();
}

// 'TIA2': layout novo (latches de GRP, contadores de audio, pente do HMOVE).
// Um state do formato antigo ('TIA ') nao e encontrado e o load recusa.
static constexpr uint32_t kTagTia2 = emu_tag('T', 'I', 'A', '2');

void Tia::save(emu::StateWriter& w) const
{
    w.begin(kTagTia2);
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
    w.bytes(pf_, 3);
    w.bytes(grpNew_, 2);
    w.bytes(grpOld_, 2);
    w.bytes(enam_, 2);
    w.u8(enablNew_);
    w.u8(enablOld_);
    w.bytes(hmp_, 2);
    w.bytes(hmm_, 2);
    w.u8(hmbl_);
    w.bytes(vdelp_, 2);
    w.u8(vdelbl_);
    w.bytes(resmp_, 2);
    w.bytes(audc_, 2);
    w.bytes(audf_, 2);
    w.bytes(audv_, 2);
    w.bytes(audDiv_, 2);
    w.bytes(audPulse_, 2);
    w.bytes(audNoise_, 2);
    w.bytes(audClkEn_, 2);
    w.bytes(audNoiseFb_, 2);
    w.bytes(audBit4_, 2);
    w.bytes(audHold_, 2);
    w.u32((uint32_t)audDc_);
    for (int i = 0; i < 5; i++) w.u16((uint16_t)pos_[i]);
    w.u16(collBits_);
    w.u16((uint16_t)scanline_);
    w.u16((uint16_t)clock_);
    w.u16((uint16_t)visibleY_);
    w.u16((uint16_t)drawn_);
    w.u8(wsync_ ? 1 : 0);
    w.u8(frameReady_ ? 1 : 0);
    w.u8(windowOpen_ ? 1 : 0);
    w.u8(combNext_ ? 1 : 0);
    w.u8(comb_ ? 1 : 0);
    w.u8(potDump_ ? 1 : 0);
    w.bytes(inpt_, 2);
    w.bytes(paddle_, 4);
    for (int i = 0; i < 4; i++) w.u16(pot_[i]);
    w.bytes((const uint8_t*)line_, sizeof(line_));
    w.end();
}

bool Tia::load(emu::StateReader& r)
{
    if (!r.find(kTagTia2)) return false;
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
    r.bytes(pf_, 3);
    r.bytes(grpNew_, 2);
    r.bytes(grpOld_, 2);
    r.bytes(enam_, 2);
    enablNew_ = r.u8();
    enablOld_ = r.u8();
    r.bytes(hmp_, 2);
    r.bytes(hmm_, 2);
    hmbl_ = r.u8();
    r.bytes(vdelp_, 2);
    vdelbl_ = r.u8();
    r.bytes(resmp_, 2);
    r.bytes(audc_, 2);
    r.bytes(audf_, 2);
    r.bytes(audv_, 2);
    r.bytes(audDiv_, 2);
    r.bytes(audPulse_, 2);
    r.bytes(audNoise_, 2);
    r.bytes(audClkEn_, 2);
    r.bytes(audNoiseFb_, 2);
    r.bytes(audBit4_, 2);
    r.bytes(audHold_, 2);
    audDc_ = (int32_t)r.u32();
    for (int i = 0; i < 5; i++) pos_[i] = wrapX((int16_t)r.u16());
    collBits_ = r.u16();
    scanline_ = (int16_t)r.u16();
    clock_ = (int16_t)r.u16();
    visibleY_ = (int16_t)r.u16();
    drawn_ = (int16_t)r.u16();
    wsync_ = r.u8() != 0;
    frameReady_ = r.u8() != 0;
    windowOpen_ = r.u8() != 0;
    combNext_ = r.u8() != 0;
    comb_ = r.u8() != 0;
    potDump_ = r.u8() != 0;
    r.bytes(inpt_, 2);
    r.bytes(paddle_, 4);
    for (int i = 0; i < 4; i++) pot_[i] = r.u16();
    r.bytes((uint8_t*)line_, sizeof(line_));
    dirty_ = kAll;  // objs_ derivado dos registradores restaurados
    if (clock_ < 0 || clock_ >= kColorClocks) clock_ = 0;
    if (drawn_ < 0 || drawn_ > kVisibleWidth) drawn_ = 0;
    if (visibleY_ < 0 || visibleY_ > kVisibleHeight) visibleY_ = 0;
    return r.ok();
}

}  // namespace a2600
}  // namespace emu
