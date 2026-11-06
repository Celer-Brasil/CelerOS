#pragma once
// Cartucho do Atari 2600: mapeamento 2K/4K + bank switching.
//
// O 6507 tem 13 linhas de endereco; o cartucho ocupa A12=1 (o bus mascara o
// endereco para 0x000-0xFFF antes de chamar aqui). Mappers da v1:
//   2K (espelhado), 4K, F8 (2x4K), F6 (4x4K), F4 (8x4K) e as variantes SC
//   (128 B de RAM), FE (2x4K), E0 (8x1K + 3K fixo), 3F/3E (Tigervision, 4x2K),
//   UA (2x4K, hotspot em $0220/$0240).
// DPC (Pitfall II) e CDF ficam fora: exigem coprocessador/musica proprios.
//
// A deteccao e por TAMANHO; 8K e ambiguo (F8/FE/E0/3F/3E/UA), entao o app
// deixa o usuario escolher o mapper por ROM (override) e o core valida.

#include "../../common/emu_compat.h"
#include "../../common/emu_state.h"

namespace emu {
namespace a2600 {

class CartA2600
{
public:
    enum Mapper : uint8_t {
        k2K = 0, k4K, kF8, kF6, kF4, kF8SC, kF6SC, kF4SC,
        kFE, kE0, k3F, k3E, kUA,
    };

    // override = -1 usa o default do tamanho. Devolve false para tamanho nao
    // suportado (o app mostra a tela de erro).
    bool load(const uint8_t* rom, uint32_t size, int overrideMapper = -1);
    void reset();

    uint8_t read(uint16_t addr);   // addr ja mascarado (0x000-0xFFF)
    void write(uint16_t addr, uint8_t v);

    int mapper() const { return mapper_; }
    int bank() const { return bank_; }
    bool isUA() const { return mapper_ == kUA; }
    bool is3F() const { return mapper_ == k3F || mapper_ == k3E; }
    void selectBank(int b) { bank_ = b; }
    static const char* mapperName(int m);

    void save(emu::StateWriter& w) const;
    bool loadState(emu::StateReader& r);

private:
    void switchHotspot(uint16_t addr);

    const uint8_t* rom_ = nullptr;
    uint32_t size_ = 0;
    int mapper_ = k4K;
    int bank_ = 0;
    uint8_t ram_[1024] = {0};  // SC usa 128 B; 3E usa 1 KB
};

}  // namespace a2600
}  // namespace emu
