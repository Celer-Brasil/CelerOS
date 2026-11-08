#pragma once
// Container de save state dos emuladores nativos (CelerOS).
//
// O formato do Anemoia era um header fixo "ANEMOIA"+CRC da ROM seguido de
// secoes em ORDEM FIXA e sem tamanho — acrescentar um campo quebrava todos os
// saves e um arquivo truncado passava. Aqui o save e um container:
//
//   header 32 B: magic "CEMU", versao, console, flags, CRC32 da ROM,
//                tamanho e CRC32 do payload
//   secoes:      tag u32 (fourcc) + len u32 + payload (padding ate 4 B)
//
// O writer/reader sao usados pelo core: cada subsistema grava a propria secao
// (CPU/TIA/cart/...) e o reader pula o que nao conhece. Um save de outro
// console ou de outra ROM e recusado no header; um truncado vira ok()==false
// em vez de estado parcial.

#include "emu_compat.h"

namespace emu {

constexpr uint32_t kStateMagic = 0x554D4543u;  // "CEMU" (little-endian)
constexpr uint16_t kStateVersion = 1;
constexpr uint32_t kStateHeaderSize = 32;

enum ConsoleId : uint8_t {
    kConsoleNone = 0,
    kConsoleNes = 1,     // reservado (o Anemoia mantem o formato "ANEMOIA")
    kConsoleA2600 = 2,
    kConsoleA5200 = 3,
    kConsoleSnes = 4,
};

// fourcc legivel no hexdump: emu_tag('C','P','U',' ') vira "CPU ".
constexpr uint32_t emu_tag(char a, char b, char c, char d)
{
    return (uint32_t)(uint8_t)a | ((uint32_t)(uint8_t)b << 8) |
           ((uint32_t)(uint8_t)c << 16) | ((uint32_t)(uint8_t)d << 24);
}

constexpr uint32_t kTagCpu = emu_tag('C', 'P', 'U', ' ');
constexpr uint32_t kTagBus = emu_tag('B', 'U', 'S', ' ');
constexpr uint32_t kTagVideo = emu_tag('V', 'I', 'D', ' ');
constexpr uint32_t kTagSound = emu_tag('S', 'N', 'D', ' ');
constexpr uint32_t kTagCart = emu_tag('C', 'A', 'R', 'T');
constexpr uint32_t kTagTia = emu_tag('T', 'I', 'A', ' ');
constexpr uint32_t kTagAntic = emu_tag('A', 'N', 'T', 'C');
constexpr uint32_t kTagGtia = emu_tag('G', 'T', 'I', 'A');
constexpr uint32_t kTagPokey = emu_tag('P', 'O', 'K', 'Y');

class StateWriter
{
public:
    StateWriter(void* buf, uint32_t cap, uint8_t console, uint32_t romCrc)
        : buf_((uint8_t*)buf), cap_(cap), pos_(kStateHeaderSize), secStart_(0), ok_(true),
          console_(console), romCrc_(romCrc)
    {
        if (buf_ == nullptr || cap_ < kStateHeaderSize) {
            ok_ = false;
            return;
        }
        memset(buf_, 0, kStateHeaderSize);
        emu_wr32(buf_, kStateMagic);
        emu_wr16(buf_ + 4, kStateVersion);
        buf_[6] = console_;
        buf_[7] = 0;
        emu_wr32(buf_ + 8, romCrc_);
    }

    bool ok() const { return ok_; }

    void begin(uint32_t tag)
    {
        if (!ok_) return;
        align4();
        if (pos_ + 8 > cap_) {
            ok_ = false;
            return;
        }
        secStart_ = pos_;
        emu_wr32(buf_ + pos_, tag);
        emu_wr32(buf_ + pos_ + 4, 0);
        pos_ += 8;
    }

    void end()
    {
        if (!ok_) return;
        if (secStart_ == 0) {
            ok_ = false;
            return;
        }
        align4();
        emu_wr32(buf_ + secStart_ + 4, pos_ - (secStart_ + 8));
        secStart_ = 0;
    }

    // Escrita direta (estados grandes, ex.: SNES ~270 KB): o core serializa
    // em cursor() ate room() bytes e confirma com advance(n) — sem buffer
    // intermediario.
    uint8_t* cursor() { return ok_ ? buf_ + pos_ : nullptr; }
    uint32_t room() const { return ok_ && cap_ > pos_ ? cap_ - pos_ : 0; }
    void advance(uint32_t n)
    {
        if (!ok_ || pos_ + n > cap_) {
            ok_ = false;
            return;
        }
        pos_ += n;
    }

    void u8(uint8_t v)
    {
        if (!ok_) return;
        if (pos_ >= cap_) {
            ok_ = false;
            return;
        }
        buf_[pos_++] = v;
    }
    void u16(uint16_t v)
    {
        if (!ok_ || pos_ + 2 > cap_) {
            ok_ = false;
            return;
        }
        emu_wr16(buf_ + pos_, v);
        pos_ += 2;
    }
    void u32(uint32_t v)
    {
        if (!ok_ || pos_ + 4 > cap_) {
            ok_ = false;
            return;
        }
        emu_wr32(buf_ + pos_, v);
        pos_ += 4;
    }
    void u64(uint64_t v)
    {
        u32((uint32_t)v);
        u32((uint32_t)(v >> 32));
    }
    void bytes(const void* p, uint32_t n)
    {
        if (!ok_) return;
        if (n > 0 && p == nullptr) {
            ok_ = false;
            return;
        }
        if (pos_ + n > cap_) {
            ok_ = false;
            return;
        }
        memcpy(buf_ + pos_, p, n);
        pos_ += n;
    }

    // Fecha o container (header + CRC do payload) e devolve os bytes escritos.
    // 0 = nao coube/erro de secao; o chamador nao persiste nada.
    uint32_t finish()
    {
        if (!ok_) return 0;
        align4();
        const uint32_t payload = pos_ - kStateHeaderSize;
        emu_wr32(buf_ + 12, payload);
        emu_wr32(buf_ + 16, emu_crc32(buf_ + kStateHeaderSize, payload));
        return pos_;
    }

    uint32_t pos() const { return pos_; }

private:
    void align4()
    {
        while ((pos_ & 3u) != 0) {
            if (pos_ >= cap_) {
                ok_ = false;
                return;
            }
            buf_[pos_++] = 0;
        }
    }

    uint8_t* buf_;
    uint32_t cap_;
    uint32_t pos_;
    uint32_t secStart_;
    bool ok_;
    uint8_t console_;
    uint32_t romCrc_;
};

class StateReader
{
public:
    StateReader(const void* buf, uint32_t size, uint8_t console, uint32_t romCrc)
        : buf_((const uint8_t*)buf), size_(size), pos_(0), secEnd_(0), ok_(true),
          payloadLen_(0)
    {
        if (buf_ == nullptr || size_ < kStateHeaderSize) {
            ok_ = false;
            return;
        }
        if (emu_rd32(buf_) != kStateMagic || emu_rd16(buf_ + 4) != kStateVersion ||
            buf_[6] != console || emu_rd32(buf_ + 8) != romCrc) {
            ok_ = false;
            return;
        }
        payloadLen_ = emu_rd32(buf_ + 12);
        if (payloadLen_ > size_ - kStateHeaderSize) {
            ok_ = false;
            return;
        }
        if (emu_crc32(buf_ + kStateHeaderSize, payloadLen_) != emu_rd32(buf_ + 16)) {
            ok_ = false;
            return;
        }
    }

    bool ok() const { return ok_; }

    // Procura a secao `tag` no payload (pula as desconhecidas). Se achou,
    // posiciona o cursor nela; as leituras seguintes ficam limitadas a ela.
    bool find(uint32_t tag)
    {
        if (!ok_) return false;
        const uint32_t end = kStateHeaderSize + payloadLen_;
        uint32_t p = kStateHeaderSize;
        while (p + 8 <= end) {
            const uint32_t t = emu_rd32(buf_ + p);
            const uint32_t len = emu_rd32(buf_ + p + 4);
            p += 8;
            if (len > end - p) {
                ok_ = false;
                return false;
            }
            if (t == tag) {
                pos_ = p;
                secEnd_ = p + len;
                return true;
            }
            p += (len + 3u) & ~3u;
        }
        return false;
    }

    uint8_t u8()
    {
        if (!ok_ || pos_ + 1 > secEnd_) {
            ok_ = false;
            return 0;
        }
        return buf_[pos_++];
    }
    uint16_t u16()
    {
        if (!ok_ || pos_ + 2 > secEnd_) {
            ok_ = false;
            return 0;
        }
        const uint16_t v = emu_rd16(buf_ + pos_);
        pos_ += 2;
        return v;
    }
    uint32_t u32()
    {
        if (!ok_ || pos_ + 4 > secEnd_) {
            ok_ = false;
            return 0;
        }
        const uint32_t v = emu_rd32(buf_ + pos_);
        pos_ += 4;
        return v;
    }
    uint64_t u64()
    {
        const uint64_t lo = u32();
        const uint64_t hi = u32();
        return lo | (hi << 32);
    }
    bool bytes(void* p, uint32_t n)
    {
        if (!ok_ || n > secEnd_ - pos_) {
            ok_ = false;
            return false;
        }
        if (n > 0) memcpy(p, buf_ + pos_, n);
        pos_ += n;
        return true;
    }

    // Leitura direta de n bytes da secao atual (nullptr = passou do fim).
    const uint8_t* ptr(uint32_t n)
    {
        if (!ok_ || pos_ > secEnd_ || n > secEnd_ - pos_) {
            ok_ = false;
            return nullptr;
        }
        const uint8_t* p = buf_ + pos_;
        pos_ += n;
        return p;
    }

    uint32_t remaining() const { return ok_ && pos_ <= secEnd_ ? secEnd_ - pos_ : 0; }

private:
    const uint8_t* buf_;
    uint32_t size_;
    uint32_t pos_;
    uint32_t secEnd_;
    bool ok_;
    uint32_t payloadLen_;
};

}  // namespace emu
