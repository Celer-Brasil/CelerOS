#pragma once
// Saida de audio comum dos emuladores nativos.
//
// O firmware expoe PCM16 mono a 44,1 kHz (nativeAudio/PcmFeed). Os chips dos
// consoles rodam em taxas proprias (TIA 1,19 MHz, POKEY 1,79 MHz, VDC...),
// entao o core integra/decima para 44,1 kHz aqui. A media de bloco e o
// suficiente para ondas quadradas/polifonicas dos 8 bits; o buffer e o da
// scratch (offset devolvido por core_ctl PCM_OFF) e o app drena por quadro.

#include "emu_compat.h"

namespace emu {

static inline int16_t emu_clamp16(int32_t v)
{
    if (v < -32768) return -32768;
    if (v > 32767) return 32767;
    return (int16_t)v;
}

class AudioDownsampler
{
public:
    // srcRate: taxa dos samples empurrados; dstRate: 44100 (firmware).
    void configure(int srcRate, int dstRate, int16_t* out, uint32_t cap)
    {
        srcRate_ = srcRate > 0 ? srcRate : 44100;
        dstRate_ = dstRate > 0 ? dstRate : 44100;
        out_ = out;
        cap_ = cap;
        reset();
    }

    void reset()
    {
        acc_ = 0;
        sum_ = 0;
        n_ = 0;
        count_ = 0;
    }

    // Um sample na taxa de origem (ex.: 1 por ciclo de CPU do 2600).
    void push(int32_t s)
    {
        sum_ += s;
        n_++;
        acc_ += (uint32_t)dstRate_;
        if (acc_ >= (uint32_t)srcRate_) {
            acc_ -= (uint32_t)srcRate_;
            // soma de ate ~1024 samples de 16 bits cabe em int32; divisao de
            // 64 bits chamaria __divdi3, que o blob freestanding nao linka.
            const int32_t avg = n_ > 0 ? sum_ / n_ : 0;
            if (count_ < cap_ && out_ != nullptr) out_[count_++] = emu_clamp16(avg);
            sum_ = 0;
            n_ = 0;
        }
    }

    uint32_t count() const { return count_; }
    uint32_t bytes() const { return count_ * 2u; }
    bool overflowed() const { return count_ >= cap_; }

private:
    int srcRate_ = 0;
    int dstRate_ = 44100;
    uint32_t acc_ = 0;
    int32_t sum_ = 0;
    uint32_t n_ = 0;
    int16_t* out_ = nullptr;
    uint32_t cap_ = 0;
    uint32_t count_ = 0;
};

}  // namespace emu
