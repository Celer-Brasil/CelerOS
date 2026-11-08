#ifndef CELEROS_BT_BLE_HID_H
#define CELEROS_BT_BLE_HID_H

#include <stddef.h>
#include <stdint.h>

#if CONFIG_CELEROS_BLE_HID

// Gamepad/teclado/mouse Bluetooth LE HID (API 57): HOST HOGP cru — o
// firmware expoe o transporte e NADA de protocolo. Scan de HID devices,
// conexao + pareamento SMP Just Works (bond no NVS do NimBLE), descoberta do
// servico HID 0x1812 (Report Map cru + Report Reference de cada char) e
// roteamento: reports de entrada entram na fila que o JS drena com BT.read();
// bytes de saida (rumble) saem pelo BT.write() para a char de output report.
// Todo o parsing do descriptor e decodificacao vive nas deps JS
// celeros.gamepad (pad) e celeros.hid (teclado/mouse).
//
// API 62: o connect classifica o Report Map (HidDesc.h) e guarda nome+tipo
// por bond — BT.state().kind e BT.paired()[].kind dizem o que esta conectado
// sem o JS precisar parsear nada.
//
// Pads testaveis em modo BLE: Xbox One S/Series, 8bitdo BLE. DualShock 4 e
// Bluetooth CLASSIC — o radio do S3 nao tem BR/EDR e NAO conecta. Fones BT
// (A2DP) tambem nao: o S3 nao tem Classic nem ISO/LE Audio.
//
// Concorrencia: os callbacks rodam na task do host NimBLE; scan/connect sao
// dirigidos pela task do app, passo a passo, sincronizados por bits de um
// event group (mesmo desenho do CelerLink). Durante o scan/connect o
// CelerLink::appBusy() fica true (setExternalBusy) e a malha pausa o
// scanner dela. O enlace do pad coexiste com o Celer Link/Phone Link
// (MAX_CONNECTIONS >= 2 no board).
class BleHid {
public:
    static constexpr size_t MAX_PEERS = 16;    // cache do scan
    static constexpr size_t MAX_NAME = 29;     // nome no adv/scan rsp
    static constexpr size_t MAX_MAP = 512;     // Report Map cru
    static constexpr size_t MAX_REPORT = 64;   // report de entrada (0x11)
    static constexpr int RX_DEPTH = 8;         // fila de reports de entrada

    // Par visto no scan de HID. id = "AA:BB:CC:DD:EE:FF" (17 chars).
    struct Peer {
        char id[18];
        char name[MAX_NAME + 1];
        int8_t rssi;
        uint8_t addrType;      // BLE_ADDR_PUBLIC / BLE_ADDR_RANDOM
        uint16_t appearance;   // 0x03C4 = gamepad
        uint8_t kind;          // HidDesc::Kind (0 = desconhecido)
    };

    // Char de report do pad (Report Reference descobre id+tipo).
    struct ReportInfo {
        uint8_t id;      // report id (0 = descriptor sem id)
        uint8_t type;    // 1=input, 2=output, 3=feature
        uint16_t handle; // val_handle da char Report (0x2A4D)
        uint16_t size;   // bytes do report (ceil dos bits; 0 = desconhecido)
    };

    // Estado para o BT.state() do JS.
    static constexpr int MAX_REPORTS = 8;
    struct Info {
        const char* phase;    // off/scanning/idle/connecting/ready/error
        char addr[18];        // "" sem conexao
        char name[MAX_NAME + 1];
        int8_t rssi;
        int battery;          // 0..100, -1 = pad sem Battery Service
        uint16_t mtu;
        uint8_t kind;         // HidDesc::Kind do device conectado
        ReportInfo reports[MAX_REPORTS];
        int nReports;
        uint16_t queued;      // reports na fila
        uint32_t dropped;     // descartados por fila cheia
        char err[48];         // motivo do phase "error"
    };

    // Inicia o host (CelerLink::ensureStarted) + configura SMP/bond para
    // HID (idempotente; a 1a chamada pode demorar ~300 ms).
    static bool ensure();
    static bool started();

    // Scan bloqueante de HID devices (appearance 0x03C0..0x03CF ou servico
    // 0x1812 no adv). Preenche ate max entradas de out (RSSI mais forte
    // primeiro). A malha CelerNet pausa o scanner enquanto roda.
    static bool scan(uint32_t ms);
    // Entradas do ultimo scan (nao bloqueia).
    static int scanResults(Peer* out, int max);

    // Conecta por "AA:BB:..." (tipo do endereco vem do cache do scan ou do
    // ultimo bond; default publico). Bloqueante: conexao + SMP + descoberta
    // + inscricao dentro do prazo total ms.
    static bool connect(const char* id, uint32_t ms);
    static bool disconnect();
    static bool connected();

    // Pareados (bonds do NimBLE — inclui o celular no watch; o JS filtra).
    static int paired(Peer* out, int max);
    // Apaga o bond do endereco (ou todos, id nullptr) + o slot "ultimo pad".
    static bool forget(const char* id);

    // Report de entrada da fila; false = vazia. len recebe os bytes copiados
    // (JA COM o byte do report id quando o pad usa id).
    static bool poll(uint8_t* id, void* buf, size_t cap, size_t* len);
    // Bytes de saida (rumble; JS manda JA COM o report id se houver) para a
    // char de output report. Bloqueia o write ate ~1 s.
    static bool write(const void* data, size_t len);

    static void info(Info* out);
    // Kind do device conectado (HidDesc::Kind; 0 = nada/desconhecido).
    // O KeyboardScreen usa para esconder a grade quando ha teclado fisico.
    static uint8_t kind();
    // Report Map cru do pad conectado (null/0 sem mapa lido).
    static size_t reportMap(uint8_t* out, size_t cap);

    // Reset entre apps (JSBindings::init): limpa fila/cache de scan — o
    // ENLACE do pad segue vivo (trocar de app nao derruba o controle).
    static void appReset();

    // Servico (CelerServices): so alimenta o watchdog de conexao presa.
    static void tick();

    // scan/connect em andamento (a malha consulta via CelerLink::appBusy).
    static bool busy();
};

#else  // !CONFIG_CELEROS_BLE_HID — callers C++ sem #ifdef (objeto JS some)

class BleHid {
public:
    static constexpr size_t MAX_PEERS = 16;
    static constexpr size_t MAX_NAME = 29;
    static constexpr size_t MAX_MAP = 512;
    static constexpr size_t MAX_REPORT = 64;
    static constexpr int RX_DEPTH = 8;
    struct Peer { char id[18]; char name[30]; int8_t rssi; uint8_t addrType; uint16_t appearance; uint8_t kind; };
    struct ReportInfo { uint8_t id; uint8_t type; uint16_t handle; uint16_t size; };
    static constexpr int MAX_REPORTS = 8;
    struct Info {
        const char* phase; char addr[18]; char name[30]; int8_t rssi;
        int battery; uint16_t mtu; uint8_t kind; ReportInfo reports[MAX_REPORTS];
        int nReports; uint16_t queued; uint32_t dropped; char err[48];
    };
    static inline bool ensure() { return false; }
    static inline bool started() { return false; }
    static inline bool scan(uint32_t) { return false; }
    static inline int scanResults(Peer*, int) { return 0; }
    static inline bool connect(const char*, uint32_t) { return false; }
    static inline bool disconnect() { return false; }
    static inline bool connected() { return false; }
    static inline int paired(Peer*, int) { return 0; }
    static inline bool forget(const char*) { return false; }
    static inline bool poll(uint8_t*, void*, size_t, size_t*) { return false; }
    static inline bool write(const void*, size_t) { return false; }
    static inline void info(Info*) {}
    static inline uint8_t kind() { return 0; }
    static inline size_t reportMap(uint8_t*, size_t) { return 0; }
    static inline void appReset() {}
    static inline void tick() {}
    static inline bool busy() { return false; }
};

#endif  // CONFIG_CELEROS_BLE_HID

#endif  // CELEROS_BT_BLE_HID_H
