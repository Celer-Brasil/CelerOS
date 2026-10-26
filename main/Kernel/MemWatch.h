#ifndef CELER_KERNEL_MEMWATCH_H
#define CELER_KERNEL_MEMWATCH_H

#include <stdint.h>

// Aviso de RAM interna baixa (Onda 2 do plano do Tactility).
//
// A RAM interna e o recurso escasso do firmware (reservas de 72/24/20 KB no
// CelerKernel); quando ela chega no limite o sintoma e OOM de app sem
// explicacao. O servico le o heap interno 1x/s e so avisa na TRANSICAO para
// baixo (histerese), para nao repetir aviso em oscilacao.
//
// classify() e puro e roda nos testes host; tick() e o lado firmware.
namespace MemWatch {

// Limiares do MemoryCheckerService do Tactility (free < 10 KB ou maior bloco
// < 2 KB) + margem de re-arme em 14 KB livres.
constexpr uint32_t kLowFreeBytes = 10 * 1024;
constexpr uint32_t kLowLargestBytes = 2 * 1024;
constexpr uint32_t kOkFreeBytes = 14 * 1024;

enum class Level : uint8_t { Ok = 0, Low = 1 };

// Decide o nivel com histerese: em Low, so volta a Ok quando free >=
// kOkFreeBytes E o maior bloco >= kLowLargestBytes. Em Ok, cai para Low se
// free < kLowFreeBytes OU o maior bloco < kLowLargestBytes. Bordas exatas
// contam como Ok (comparacao e estrita). Inline para o teste host linkar
// sem o .cpp (que depende de ESP-IDF).
inline Level classify(uint32_t freeBytes, uint32_t largestBytes, Level was) {
    if (was == Level::Low) {
        const bool recovered = freeBytes >= kOkFreeBytes && largestBytes >= kLowLargestBytes;
        return recovered ? Level::Ok : Level::Low;
    }
    const bool low = freeBytes < kLowFreeBytes || largestBytes < kLowLargestBytes;
    return low ? Level::Low : Level::Ok;
}

// Nivel corrente (ultimo tick). Util para diagnostico/UI.
Level level();

// Servico: no maximo 1x/s, sem alocacao no caminho.
void tick();

}  // namespace MemWatch

#endif  // CELER_KERNEL_MEMWATCH_H
