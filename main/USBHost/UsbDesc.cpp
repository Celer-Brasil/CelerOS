#include "UsbDesc.h"

#include <string.h>

namespace usbdesc {

// Layouts USB 2.0 (cap. 9). Nada de struct packing: leitura byte a byte em
// little-endian, o que tambem aceita blobs desalinhados vindos do host lib.
namespace {
constexpr uint8_t kTypeConfig = 0x02;
constexpr uint8_t kTypeInterface = 0x04;
constexpr uint8_t kTypeEndpoint = 0x05;
constexpr uint8_t kTypeCsInterface = 0x24;  // HID/CDC/etc (ignorado)

inline uint16_t rd16(const uint8_t* p) {
    return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}
}  // namespace

bool parseConfig(const uint8_t* cfg, size_t len, DevDesc& out) {
    out.nIfs = 0;
    if (cfg == nullptr || len < 9) return false;
    if (cfg[0] < 9 || cfg[1] != kTypeConfig) return false;

    size_t total = rd16(cfg + 2);
    if (total < 9) return false;
    if (total > len) total = len;  // blobs truncados: para no que existe

    IfDesc* cur = nullptr;
    size_t off = cfg[0];
    while (off + 2 <= total) {
        const uint8_t blen = cfg[off];
        const uint8_t btype = cfg[off + 1];
        if (blen < 2 || off + blen > total) break;

        if (btype == kTypeInterface) {
            if (blen >= 9 && out.nIfs < kMaxIfaces) {
                cur = &out.ifs[out.nIfs++];
                *cur = IfDesc{};
                cur->num = cfg[off + 2];
                cur->alt = cfg[off + 3];
                cur->cls = cfg[off + 5];
                cur->subcls = cfg[off + 6];
                cur->proto = cfg[off + 7];
            } else {
                cur = nullptr;  // sem espaco: ignora a interface e seus EPs
            }
        } else if (btype == kTypeEndpoint) {
            if (blen >= 7 && cur != nullptr && cur->nEps < kMaxEps) {
                EpDesc& ep = cur->eps[cur->nEps++];
                ep = EpDesc{};
                ep.addr = cfg[off + 2];
                ep.type = (uint8_t)(cfg[off + 3] & 0x03);
                ep.mps = (uint16_t)(rd16(cfg + off + 4) & 0x7FF);
                ep.interval = cfg[off + 6];
            }
        } else if (btype == kTypeCsInterface) {
            // descritor de classe (HID report, CDC functional...): o driver
            // JS pede o que precisar por controlIn
        }
        off += blen;
    }
    return out.nIfs > 0;
}

}  // namespace usbdesc
