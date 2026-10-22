#pragma once

// ============================================================================
// Descritores USB (parser puro, sem dependencia do IDF)
//
// O core USB Host guarda dos devices apenas o que o JS precisa para escolher
// driver/interface/endpoint. O parser le o Configuration Descriptor CRU
// (o mesmo blob que usb_host_get_active_config_descriptor devolve), pula
// descritores especificos de classe e preenche uma estrutura fixa — sem
// malloc, sem std::, host-testavel em test/cpp.
//
// Campos numericos crus de proposito: nenhum driver de dispositivo mora no
// firmware. A traducao (classe 7 = printer, 3 = HID, usage IDs, ESC/POS)
// vive nas deps JS.
// ============================================================================

#include <stddef.h>
#include <stdint.h>

namespace usbdesc {

constexpr int kMaxIfaces = 6;   // por device (alts contam como entradas)
constexpr int kMaxEps = 6;      // por interface

// bmAttributes & 0x03 do endpoint
enum EpType : uint8_t {
    kEpControl = 0,
    kEpIso = 1,
    kEpBulk = 2,
    kEpInterrupt = 3,
};

struct EpDesc {
    uint8_t addr = 0;      // bit7 = IN
    uint8_t type = 0;      // EpType
    uint16_t mps = 0;      // wMaxPacketSize (low 11 bits no FS; cru aqui)
    uint8_t interval = 0;  // bInterval
};

struct IfDesc {
    uint8_t num = 0;
    uint8_t alt = 0;
    uint8_t cls = 0;
    uint8_t subcls = 0;
    uint8_t proto = 0;
    uint8_t nEps = 0;
    EpDesc eps[kMaxEps];
};

struct DevDesc {
    uint16_t vid = 0;
    uint16_t pid = 0;
    uint8_t cls = 0;
    uint8_t subcls = 0;
    uint8_t proto = 0;
    uint8_t mps0 = 0;
    uint8_t speed = 0;     // USB_SPEED_* do IDF (0 = desconhecido)
    uint8_t nIfs = 0;
    IfDesc ifs[kMaxIfaces];
};

// Parse do Configuration Descriptor (comeca no descritor de configuracao,
// bDescriptorType=0x02). Devolve false se o blob nao tem config valida ou
// nenhuma interface. `out.ifs` e zerado antes de preencher.
bool parseConfig(const uint8_t* cfg, size_t len, DevDesc& out);

}  // namespace usbdesc
