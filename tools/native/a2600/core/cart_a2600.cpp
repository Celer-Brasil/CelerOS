// Cartucho do Atari 2600 — implementacao.
//
// Enderecos aqui sao o offset de 12 bits dentro do cartucho (0x000-0xFFF):
// $F000-$FFFF no PC vira 0x000-0xFFF; os hotspots F8/F6/F4 ficam em
// 0xFF8/0xFF6..0xFF9/0xFF4..0xFFB. 3F/3E trocam por ESCRITA em $003F (o bus
// intercepta antes da TIA); UA troca por LEITURA em $0220/$0240 (o bus
// intercepta no espelho da TIA).

#include "cart_a2600.h"

namespace emu {
namespace a2600 {
namespace {

bool validForSize(int m, uint32_t size)
{
    switch (size) {
    case 2048: return m == CartA2600::k2K;
    case 4096: return m == CartA2600::k4K;
    case 8192:
        return m == CartA2600::kF8 || m == CartA2600::kF8SC || m == CartA2600::kFE ||
               m == CartA2600::kE0 || m == CartA2600::k3F || m == CartA2600::k3E ||
               m == CartA2600::kUA;
    case 16384:
        return m == CartA2600::kF6 || m == CartA2600::kF6SC;
    case 32768:
        return m == CartA2600::kF4 || m == CartA2600::kF4SC;
    default: return false;
    }
}

int defaultMapper(uint32_t size)
{
    switch (size) {
    case 2048: return CartA2600::k2K;
    case 4096: return CartA2600::k4K;
    case 8192: return CartA2600::kF8;
    case 16384: return CartA2600::kF6;
    case 32768: return CartA2600::kF4;
    default: return -1;
    }
}

}  // namespace

bool CartA2600::load(const uint8_t* rom, uint32_t size, int overrideMapper)
{
    rom_ = nullptr;
    size_ = 0;
    bank_ = 0;
    memset(ram_, 0, sizeof(ram_));
    if (rom == nullptr) return false;
    const int def = defaultMapper(size);
    if (def < 0) return false;
    mapper_ = (overrideMapper >= 0 && validForSize(overrideMapper, size)) ? overrideMapper : def;
    rom_ = rom;
    size_ = size;
    return true;
}

void CartA2600::reset()
{
    bank_ = 0;
    memset(ram_, 0, sizeof(ram_));
}

const char* CartA2600::mapperName(int m)
{
    switch (m) {
    case k2K: return "2K";
    case k4K: return "4K";
    case kF8: return "F8";
    case kF6: return "F6";
    case kF4: return "F4";
    case kF8SC: return "F8SC";
    case kF6SC: return "F6SC";
    case kF4SC: return "F4SC";
    case kFE: return "FE";
    case kE0: return "E0";
    case k3F: return "3F";
    case k3E: return "3E";
    case kUA: return "UA";
    default: return "?";
    }
}

void CartA2600::switchHotspot(uint16_t addr)
{
    switch (mapper_) {
    case kF8:
    case kF8SC:
        if (addr == 0xFF8) bank_ = 0;
        else if (addr == 0xFF9) bank_ = 1;
        break;
    case kF6:
    case kF6SC:
        if (addr >= 0xFF6 && addr <= 0xFF9) bank_ = addr - 0xFF6;
        break;
    case kF4:
    case kF4SC:
        if (addr >= 0xFF4 && addr <= 0xFFB) bank_ = addr - 0xFF4;
        break;
    case kFE:
        if (addr >= 0xFE0 && addr <= 0xFEF) bank_ = 0;
        else if (addr >= 0xFF0) bank_ = 1;
        break;
    case kE0:
        if (addr >= 0xFE0 && addr <= 0xFE7) bank_ = addr & 0x07;
        break;
    default:
        break;
    }
}

uint8_t CartA2600::read(uint16_t addr)
{
    addr &= 0x0FFF;
    if (rom_ == nullptr) return 0;

    // Hotspots de leitura (F8/F6/F4/FE/E0 tambem trocam por leitura).
    switch (mapper_) {
    case kF8: case kF8SC: case kF6: case kF6SC:
    case kF4: case kF4SC: case kFE: case kE0:
        switchHotspot(addr);
        break;
    default:
        break;
    }

    switch (mapper_) {
    case k2K:
        return rom_[addr & 0x7FF];
    case k4K:
        return rom_[addr & 0xFFF];
    case kF8: case kF8SC:
        if (mapper_ == kF8SC && addr < 0x80) return ram_[addr & 0x7F];
        return rom_[(uint32_t)bank_ * 0x1000 + (addr & 0xFFF)];
    case kF6: case kF6SC:
        if (mapper_ == kF6SC && addr < 0x80) return ram_[addr & 0x7F];
        return rom_[(uint32_t)bank_ * 0x1000 + (addr & 0xFFF)];
    case kF4: case kF4SC:
        if (mapper_ == kF4SC && addr < 0x80) return ram_[addr & 0x7F];
        return rom_[(uint32_t)bank_ * 0x1000 + (addr & 0xFFF)];
    case kFE:
        return rom_[(uint32_t)bank_ * 0x1000 + (addr & 0xFFF)];
    case kE0:
        if (addr < 0x400) return rom_[(uint32_t)bank_ * 0x400 + addr];
        return rom_[0x1000 + addr];  // ultimos 3K fixos
    case k3F:
        return rom_[(uint32_t)bank_ * 0x800 + (addr & 0x7FF)];
    case k3E:
        if (addr < 0x400) return ram_[addr & 0x3FF];
        if (addr < 0x800) return 0;
        return rom_[(uint32_t)bank_ * 0x800 + (addr & 0x7FF)];
    case kUA:
        return rom_[(uint32_t)bank_ * 0x1000 + (addr & 0xFFF)];
    default:
        return 0;
    }
}

void CartA2600::write(uint16_t addr, uint8_t v)
{
    addr &= 0x0FFF;
    if (rom_ == nullptr) return;

    if (mapper_ == k3F || mapper_ == k3E) {
        if (addr == 0x03F) {
            bank_ = v & 0x03;
            return;
        }
        if (mapper_ == k3E && addr < 0x400) {
            ram_[addr & 0x3FF] = v;
            return;
        }
        return;
    }

    // RAM das variantes SC (128 B no inicio do banco).
    if ((mapper_ == kF8SC || mapper_ == kF6SC || mapper_ == kF4SC) && addr < 0x80) {
        ram_[addr & 0x7F] = v;
        return;
    }

    switchHotspot(addr);
}

void CartA2600::save(emu::StateWriter& w) const
{
    w.begin(emu::kTagCart);
    w.u8((uint8_t)mapper_);
    w.u8((uint8_t)bank_);
    w.bytes(ram_, sizeof(ram_));
    w.end();
}

bool CartA2600::loadState(emu::StateReader& r)
{
    if (!r.find(emu::kTagCart)) return false;
    mapper_ = r.u8();
    bank_ = r.u8();
    r.bytes(ram_, sizeof(ram_));
    return r.ok();
}

}  // namespace a2600
}  // namespace emu
