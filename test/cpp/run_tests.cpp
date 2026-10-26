// Testes host da lógica C++ pura do firmware (F5) — rodam no CI e local:
//   g++ -std=c++17 -Wall -Wextra -o celeros_tests test/cpp/run_tests.cpp && ./celeros_tests
// Sem framework: asserts com contagem (falha = exit 1). O alvo aqui é o
// código header-only extraído para main/Utils (SemVer, AppPerms) — a barra
// é subir a cada PR o que antes só era validado no device.

#include "../../main/Utils/SemVer.h"
#include "../../main/Utils/AppPerms.h"
#include "../../main/Utils/JsStrip.h"
#include "../../main/USBDevice/HostFrame.h"
#include "../../main/Utils/AlarmCalc.h"
#include "../../main/Utils/GbProto.h"
#include "../../main/Kernel/DeviceStats.h"
#include "../../main/Kernel/MemWatch.h"
#include "../../main/Utils/Settings.h"
#include "../../main/Hardware/MusicEngine.h"
#include "../../main/Display/DirtyRects.h"
#include "../../main/Utils/JsonMap.h"
#include "../../main/Bluetooth/NetFrame.h"
#include "../../main/Pack/ResProto.h"
#include "../../main/Pack/Reflex.h"
#include "../../main/USBDevice/UsbRes.h"
#include "../../main/Pack/PackId.h"
#include "../../main/Pack/ProvProto.h"
#include "../../main/Utils/Rigid2D.h"
#include "../../main/Utils/Verlet2D.h"
#include "../../main/Utils/ShellLogic.h"
#include "../../main/USBHost/UsbDesc.h"

// Jail do FS dos apps JS: o teste faz o papel do runtime (perm/s_appPkg)
#include <cstdint>
#include <dirent.h>
#include <cstdio>
#include <string>
static uint32_t s_perms = 0;
static std::string s_appPkg;
inline bool perm(uint32_t bit) { return (s_perms & bit) != 0; }
#define CELER_HOST_TEST 1
#include "../../main/Runtime/JsFsJail.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static int g_failed = 0, g_total = 0;

// PRNG deterministico dos martelos (LCG classico): semeado fixo, cada
// corrida reproduz a mesma sequencia adversaria
static uint32_t g_rng = 0xC0FFEE42u;

#define CHECK(cond)                                                        \
    do {                                                                   \
        g_total++;                                                         \
        if (!(cond)) {                                                     \
            g_failed++;                                                    \
            printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);         \
        }                                                                  \
    } while (0)

using namespace celer;

static void testSemVer() {
    CHECK(versionGreater("1.2.1", "1.2.0"));
    CHECK(versionGreater("1.3.0", "1.2.9"));
    CHECK(versionGreater("2.0.0", "1.99.99"));
    CHECK(!versionGreater("1.2.0", "1.2.0"));
    CHECK(!versionGreater("1.2.0", "1.2.1"));
    CHECK(!versionGreater("1.2.9", "1.3.0"));
    // formas incompletas (firmware antigo publicava x.y)
    CHECK(versionGreater("1.3", "1.2.5"));
    CHECK(!versionGreater("1.2", "1.2.0"));
    CHECK(versionGreater("0.9.1", "0.9"));
    // sujeira nao numerica: atoi para em letra (mesma semantica do device)
    CHECK(!versionGreater("abc", "0.0.1"));
}


static void testPermissions() {
    CHECK(parsePermissions("{\"name\":\"x\"}") == PERM_LEGACY);                    // ausente: so as antigas
    CHECK(parsePermissions("{\"name\":\"x\"}") != PERM_ALL);                       // usb/input nao herdam
    CHECK((parsePermissions("{\"name\":\"x\"}") & (PERM_USB | PERM_INPUT)) == 0);
    CHECK(parsePermissions("{\"permissions\":[\"fs\",\"net\"]}") == (PERM_FS | PERM_NET));
    CHECK(parsePermissions("{\"permissions\":[\"gpio\"]}") == PERM_GPIO);
    CHECK(parsePermissions("{\"permissions\":[\"system\"]}") == PERM_SYSTEM);
    CHECK(parsePermissions("{\"permissions\":[\"mic\"]}") == PERM_MIC);             // API 19
    CHECK(parsePermissions("{\"permissions\":[\"usb\"]}") == PERM_USB);             // API 48
    CHECK(parsePermissions("{\"permissions\":[\"input\"]}") == PERM_INPUT);         // API 48
    CHECK(parsePermissions("{\"permissions\":[\"fs\",\"gpio\",\"system\",\"net\",\"mic\"]}") ==
          (PERM_FS | PERM_NET | PERM_GPIO | PERM_SYSTEM | PERM_MIC));
    CHECK(parsePermissions("{\"permissions\":[]}") == 0);                         // vazio = nenhuma
    CHECK(parsePermissions("{\"permissions\":[}") == PERM_LEGACY);                // invalido = nao tranca
    // campo vizinho nao confunde (ordem no JSON nao importa)
    CHECK(parsePermissions("{\"api\":6,\"permissions\":[\"fs\"],\"topbar\":true}") == PERM_FS);
    // token desconhecido nao concede nada
    CHECK((parsePermissions("{\"permissions\":[\"fs\",\"netfs\"]}") & (PERM_NET | PERM_GPIO | PERM_SYSTEM)) == 0);
    // "camera" e perm valida desde a API 35 (Camera.* na esp32-cam)
    CHECK(parsePermissions("{\"permissions\":[\"camera\"]}") == PERM_CAMERA);
    CHECK(parsePermissions("{\"permissions\":[\"webcam\"]}") == 0);  // desconhecida segue nao concedendo
}

// Enxuga em chunks de 3 bytes (estado atravessa a fronteira dos pedacos)
static std::string strip(const char* src) {
    size_t n = strlen(src);
    JsStripper count;
    for (size_t i = 0; i < n; i += 3) count.feed(src + i, n - i < 3 ? n - i : 3);
    std::string out(count.finish(), '\0');
    JsStripper fill(&out[0]);
    fill.feed(src, n);
    fill.finish();
    return out;
}

// In-place (CelerKernel com PSRAM: le o fonte uma vez e enxuga no proprio
// buffer) tem que dar o mesmo resultado das duas passadas
static std::string stripInPlace(const std::string& src) {
    std::string buf = src;
    JsStripper fill(&buf[0]);
    fill.feed(buf.data(), buf.size());
    buf.resize(fill.finish());
    return buf;
}

static void testJsStripInPlaceApps() {
    // todo main.js de fabrica e da loja (rodando da raiz do repo, como no CI)
    const char* roots[] = {"data/apps", "hub_apps"};
    int files = 0;
    for (const char* root : roots) {
        DIR* d = opendir(root);
        if (d == nullptr) continue;
        while (struct dirent* e = readdir(d)) {
            if (e->d_name[0] == '.') continue;
            std::string path = std::string(root) + "/" + e->d_name + "/main.js";
            FILE* f = fopen(path.c_str(), "rb");
            if (f == nullptr) continue;
            std::string src;
            char chunk[4096];
            size_t n;
            while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) src.append(chunk, n);
            fclose(f);
            if (stripInPlace(src) != strip(src.c_str())) {
                printf("FALHA in-place: %s\n", path.c_str());
                CHECK(false);
            }
            files++;
        }
        closedir(d);
    }
    CHECK(files > 10);
}

static void testJsStrip() {
    CHECK(stripInPlace("a = b / c; r = /x\\/y/g; /* k */ d") == strip("a = b / c; r = /x\\/y/g; /* k */ d"));
    CHECK(stripInPlace("x=1/**/2;// fim") == strip("x=1/**/2;// fim"));
    CHECK(strip("var a = 1; // c\nvar b = 2;") == "var a = 1;\nvar b = 2;");
    CHECK(strip("    if (x) {\n\t\ty();   \n    }\n") == "if (x) {\ny();\n}\n");
    CHECK(strip("a/**/b") == "a b");
    CHECK(strip("a /* x\n y */ b") == "a\nb");                  // linhas preservadas
    CHECK(strip("s = \"// nao\"; t = '/* nao */';") == "s = \"// nao\"; t = '/* nao */';");
    CHECK(strip("r = /\\/\\//g; // c") == "r = /\\/\\//g;");  // regex com barras escapadas
    CHECK(strip("r = /[/]/.test(x)") == "r = /[/]/.test(x)");      // '/' dentro de classe
    CHECK(strip("return /a\\/b/.test(s)") == "return /a\\/b/.test(s)");
    CHECK(strip("x = a / b / c") == "x = a / b / c");             // divisao
    CHECK(strip("y = (a)/2; z = arr[0]/2") == "y = (a)/2; z = arr[0]/2");
    CHECK(strip("s = 'it\\'s // ok'") == "s = 'it\\'s // ok'");
    CHECK(strip("a\n\n\nb") == "a\n\n\nb");                    // linhas vazias ficam
}

// ------------------------------------------------------------------ HostFrame

struct RxFrame {
    uint8_t cmd = 0;
    std::vector<uint8_t> payload;
    int count = 0;
};

static void onFrame(void* ctx, uint8_t cmd, const uint8_t* payload, uint16_t len) {
    RxFrame* rx = (RxFrame*)ctx;
    rx->cmd = cmd;
    rx->payload.assign(payload, payload + len);
    rx->count++;
}

// alimenta o parser com um buffer, na cadencia de relogio dada
static RxFrame parseAll(hostframe::FrameParser& p, const uint8_t* d, size_t n, int64_t now = 0) {
    RxFrame rx;
    for (size_t i = 0; i < n; i++) p.feed(d[i], now, onFrame, &rx);
    return rx;
}

static void testHostFrame() {
    using namespace hostframe;

    // CRC32: valor canonico (mesma conta do zlib.crc32 do celerctl)
    const uint8_t probe[] = "123456789";
    CHECK(crc32(probe, 9) == 0xCBF43926u);
    // encadeamento: crc32(a||b) == crc32(b, seed=crc32(a))
    const uint8_t ab[] = "abcdef";
    CHECK(crc32(ab, 6) == crc32(ab + 3, 3, crc32(ab, 3)));

    uint8_t payload[4096];
    uint8_t frame[4104];

    // ---- proto 1: montagem e roundtrip
    memcpy(payload, "CELERCTL1", 9);
    size_t n = build(frame, sizeof(frame), false, 0x01, payload, 9);
    CHECK(n == 13);
    CHECK(frame[0] == MAGIC && frame[1] == 0x01 && frame[2] == 9 && frame[3] == 0);
    uint8_t pbuf[256];
    FrameParser p1(pbuf, sizeof(pbuf));
    RxFrame rx = parseAll(p1, frame, n);
    CHECK(rx.count == 1 && rx.cmd == 0x01 && rx.payload.size() == 9);
    CHECK(memcmp(rx.payload.data(), "CELERCTL1", 9) == 0);

    // frame com len 0 (REBOOT/WRITE_END sem payload)
    n = build(frame, sizeof(frame), false, 0x0D, nullptr, 0);
    CHECK(n == 4);
    p1.setV2(false);
    rx = parseAll(p1, frame, n);
    CHECK(rx.count == 1 && rx.cmd == 0x0D && rx.payload.empty());

    // ---- proto 2: CRC no fio, roundtrip, corrupcao
    memcpy(payload, "CELERCTL2", 9);
    n = build(frame, sizeof(frame), true, 0x01, payload, 9);
    CHECK(n == 17);  // 8 de header + 9 de payload
    FrameParser p2(pbuf, sizeof(pbuf));
    p2.setV2(true);
    rx = parseAll(p2, frame, n);
    CHECK(rx.count == 1 && rx.cmd == 0x01 && rx.payload.size() == 9);
    CHECK(memcmp(rx.payload.data(), "CELERCTL2", 9) == 0);

    p2.setV2(true);
    frame[n - 1] ^= 0xFF;  // corrompe o ultimo byte do payload
    rx = parseAll(p2, frame, n);
    CHECK(rx.count == 0);                 // CRC rejeita: nada entregue
    CHECK(p2.takeReject() == FrameParser::REJ_CRC);
    frame[n - 1] ^= 0xFF;

    // payload grande (limite do parser). A cauda vai a ZERO de proposito: o
    // TOO_BIG rejeita no comprimento e o parser re-escaneia os bytes do
    // payload como stream — lixo nao inicializado (ou 0x43 do padrao i*7)
    // podia re-sincronizar um frame falso e entregar count>1 de vez em
    // quando (flake 2/150 com ASLR; zero nunca tem MAGIC).
    for (size_t i = 0; i < sizeof(payload); i++) payload[i] = i < sizeof(pbuf) ? (uint8_t)(i * 7) : 0;
    n = build(frame, sizeof(frame), true, 0x07, payload, sizeof(pbuf));
    CHECK(n == 8 + sizeof(pbuf));
    p2.setV2(true);
    rx = parseAll(p2, frame, n);
    CHECK(rx.count == 1 && rx.payload.size() == sizeof(pbuf));
    CHECK(memcmp(rx.payload.data(), payload, sizeof(pbuf)) == 0);

    // payload acima do limite: rejeitado sem entregar
    n = build(frame, sizeof(frame), false, 0x07, payload, 4096);
    CHECK(n > 0);
    rx = parseAll(p1, frame, n);
    CHECK(rx.count == 0);
    CHECK(p1.takeReject() == FrameParser::REJ_TOO_BIG);

    // frame v2 com len 0 consome o CRC (nao deixa sujeira para o proximo)
    n = build(frame, sizeof(frame), true, 0x08, nullptr, 0);
    CHECK(n == 8);
    uint8_t two[16];
    size_t m = build(two, sizeof(two), true, 0x02, nullptr, 0);
    memcpy(frame + n, two, m);
    p2.setV2(true);
    rx = parseAll(p2, frame, n + m);
    CHECK(rx.count == 2);

    // ---- troca de buffer (HostLink sob demanda): pequeno ate o HELLO,
    // grande depois — inclusive trocando DENTRO do callback de entrega
    {
        uint8_t small[16];
        static uint8_t big[4096];
        FrameParser ps(small, sizeof(small));
        struct Swap { FrameParser* p; uint8_t* big; RxFrame rx; } sw{&ps, big, RxFrame()};
        auto swapFn = [](void* ctx, uint8_t cmd, const uint8_t* pl, uint16_t len) {
            Swap* s = (Swap*)ctx;
            onFrame(&s->rx, cmd, pl, len);
            if (cmd == 0x01) s->p->setBuffer(s->big, 4096);
        };
        n = build(frame, sizeof(frame), false, 0x07, payload, 1000);
        for (size_t i = 0; i < n; i++) ps.feed(frame[i], 0, swapFn, &sw);
        CHECK(sw.rx.count == 0 && ps.takeReject() == FrameParser::REJ_TOO_BIG);  // antes do HELLO
        memcpy(payload, "CELERCTL1", 9);
        n = build(frame, sizeof(frame), false, 0x01, payload, 9);
        size_t m2 = build(frame + n, sizeof(frame) - n, false, 0x07, payload, 1000);
        for (size_t i = 0; i < n + m2; i++) ps.feed(frame[i], 0, swapFn, &sw);
        CHECK(sw.rx.count == 2 && sw.rx.cmd == 0x07 && sw.rx.payload.size() == 1000);
        CHECK(memcmp(sw.rx.payload.data(), payload, 1000) == 0);
        ps.setBuffer(small, sizeof(small));  // fim de sessao: volta ao pequeno
        n = build(frame, sizeof(frame), false, 0x07, payload, 1000);
        sw.rx = RxFrame();
        for (size_t i = 0; i < n; i++) ps.feed(frame[i], 0, swapFn, &sw);
        CHECK(sw.rx.count == 0 && ps.takeReject() == FrameParser::REJ_TOO_BIG);
    }

    // ---- resync de silencio: frame cortado descartado, o proximo passa
    p2.setV2(true);
    n = build(frame, sizeof(frame), true, 0x05, payload, 16);
    // alimenta metade no instante 0...
    for (size_t i = 0; i < n / 2; i++) p2.feed(frame[i], 0, onFrame, &rx);
    rx = RxFrame();
    // ...outra metade 300ms depois: parser volta ao WANT_MAGIC
    for (size_t i = n / 2; i < n; i++) p2.feed(frame[i], 300000, onFrame, &rx);
    CHECK(rx.count == 0);

    // lixo antes do magic e ignorado (resync byte a byte)
    p2.setV2(true);
    n = build(frame, sizeof(frame), true, 0x03, payload, 8);
    uint8_t noisy[520];
    memset(noisy, 0x41, sizeof(noisy));
    memcpy(noisy + 500, frame, n);
    rx = parseAll(p2, noisy, 500 + n);
    CHECK(rx.count == 1 && rx.cmd == 0x03);

    // ---- fallback v2 -> v1: HELLO de host antigo numa sessao proto 2
    // host v1 manda [43 01 09 00]"CELERCTL1"; parser em v2 le "CELE" no
    // lugar do crc, devolve os bytes ao payload e cai para proto 1
    p2.setV2(true);
    uint8_t hello1[13] = {MAGIC, 0x01, 9, 0, 'C', 'E', 'L', 'E', 'R', 'C', 'T', 'L', '1'};
    rx = parseAll(p2, hello1, sizeof(hello1));
    CHECK(rx.count == 1 && rx.cmd == 0x01);
    CHECK(rx.payload.size() == 9 && memcmp(rx.payload.data(), "CELERCTL1", 9) == 0);
    CHECK(!p2.v2());  // sessao caiu para proto 1

    // frame v1 comum (nao-HELLO) numa sessao v2: o fallback "CELE" nao
    // vale — o frame fica pendente (4 bytes "roubados" pelo crc) e o
    // silencio de 250ms descarta; nada entregue, sessao intacta
    FrameParser p2b(pbuf, sizeof(pbuf));
    p2b.setV2(true);
    uint8_t stat1[13] = {MAGIC, 0x04, 9, 0, 'C', 'E', 'L', 'E', 'R', 'C', 'T', 'L', '1'};
    rx = parseAll(p2b, stat1, sizeof(stat1));
    CHECK(rx.count == 0);
    CHECK(p2b.v2());  // sessao permanece em proto 2
}

static void testFsJail() {
    s_perms = celer::PERM_FS;
    s_appPkg = "celeros.snake";
    // forma canonica: segmento inteiro, sem "//", "." ou ".."
    CHECK(fsPathCanonical("/local/x.txt"));
    CHECK(fsPathCanonical("/sd/"));
    CHECK(fsPathCanonical("/local"));
    CHECK(!fsPathCanonical("/local/./wifi.txt"));
    CHECK(!fsPathCanonical("/local//wifi.txt"));
    CHECK(!fsPathCanonical("/local/data/../wifi.txt"));
    CHECK(!fsPathCanonical("/local/.."));
    CHECK(!fsPathCanonical("/sdcard/x"));
    CHECK(!fsPathCanonical("/dev/uart/0"));
    // arquivos do sistema (e o .tmp da escrita atomica)
    CHECK(!fsPathAllowed("/local/wifi.txt"));
    CHECK(!fsPathAllowed("/local/settings_pin2.bin"));
    CHECK(!fsPathAllowed("/local/ota_url.txt.tmp"));
    CHECK(fsPathAllowed("/local/x.txt"));
    // pastas de apps: leitura sim, escrita so "system"
    CHECK(fsPathAllowed("/local/apps/Settings/main.js"));
    CHECK(!fsWriteAllowed("/local/apps/Settings/main.js"));
    CHECK(!fsWriteAllowed("/sd/apps"));
    CHECK(fsWriteAllowed("/sd/appsX/a"));
    // modulos compartilhados (deps do hub): leitura livre (o require le),
    // escrita/remocao so "system" — trocar a engine ali e trocar o codigo
    // que outros apps carregam
    CHECK(fsPathAllowed("/local/modules/celeros.engine/1.0.0/celeros.engine.js"));
    CHECK(!fsWriteAllowed("/local/modules/celeros.engine/1.0.0/celeros.engine.js"));
    CHECK(!fsWriteAllowed("/local/modules"));
    CHECK(!fsTreeWriteAllowed("/local/modules/celeros.engine"));
    CHECK(fsWriteAllowed("/local/modulesX/a"));
    // appData: so a do proprio pacote
    CHECK(fsWriteAllowed("/local/data/celeros.snake/s.txt"));
    CHECK(!fsPathAllowed("/local/data/celeros.snak/x"));
    CHECK(!fsPathAllowed("/local/data/other/x"));
    // arvores: raizes e pastas de apps
    CHECK(!fsTreeAllowed("/local"));
    CHECK(!fsTreeAllowed("/local/"));
    CHECK(!fsTreeAllowed("/local/data"));
    CHECK(fsTreeAllowed("/sd"));
    CHECK(!fsTreeWriteAllowed("/sd"));
    CHECK(!fsTreeWriteAllowed("/local/apps/X"));
    CHECK(fsTreeWriteAllowed("/sd/music"));
    // "system" passa nas regras de dono, nunca na forma canonica
    s_perms = celer::PERM_SYSTEM;
    CHECK(fsPathAllowed("/local/wifi.txt"));
    CHECK(fsWriteAllowed("/local/apps/Settings/main.js"));
    CHECK(fsTreeWriteAllowed("/local"));
    CHECK(!fsPathAllowed("/local/./wifi.txt"));
    s_perms = 0;
}

static void testAlarmCalc() {
    setenv("TZ", "UTC0", 1);
    tzset();
    // formato ida e volta
    AlarmSpec a;
    a.hour = 7; a.minute = 5; a.days = 0x3E; a.enabled = true; a.label = "Trab|alho\n";
    std::string f = formatAlarm(a);
    CHECK(f == "07:05|62|1|Trabalho");
    AlarmSpec b;
    CHECK(parseAlarm(f, b));
    CHECK(b.hour == 7 && b.minute == 5 && b.days == 0x3E && b.enabled && b.label == "Trabalho");
    CHECK(parseAlarm("23:59|0|0|", b) && !b.enabled && b.label.empty());
    CHECK(!parseAlarm("24:00|0|1|x", b));
    CHECK(!parseAlarm("lixo", b));
    CHECK(f.size() <= 63 && formatAlarm(AlarmSpec{1, 2, 3, true, std::string(200, 'x')}).size() <= 63);

    // 2026-10-02 (sexta) 10:00:00 UTC
    const time_t fri10 = 1790935200;
    struct tm chk;
    gmtime_r(&fri10, &chk);
    CHECK(chk.tm_wday == 5 && chk.tm_hour == 10);
    AlarmSpec once{9, 0, 0, true, ""};
    CHECK(nextAlarmAfter(once, fri10) == fri10 + 23 * 3600);       // amanha 09:00
    AlarmSpec later{10, 30, 0, true, ""};
    CHECK(nextAlarmAfter(later, fri10) == fri10 + 1800);            // hoje 10:30
    AlarmSpec exact{10, 0, 0, true, ""};
    CHECK(nextAlarmAfter(exact, fri10) == fri10 + 24 * 3600);       // estritamente depois
    AlarmSpec weekdays{8, 0, 0x3E, true, ""};                       // seg..sex
    CHECK(nextAlarmAfter(weekdays, fri10) == fri10 + 2 * 86400 + 22 * 3600);  // segunda 08:00
    AlarmSpec sunday{8, 0, 0x01, true, ""};
    CHECK(nextAlarmAfter(sunday, fri10) == fri10 + 86400 + 22 * 3600);        // domingo 08:00
    AlarmSpec bad{25, 0, 0, true, ""};
    CHECK(nextAlarmAfter(bad, fri10) == 0);
}

static void testGbProto() {
    using namespace celer::gb;
    // linhas quebradas em varios writes + DLE + \r
    LineAssembler la(64);
    std::vector<std::string> lines;
    auto sink = [&](const std::string& l) { lines.push_back(l); };
    const char* p1 = "\x10GB({\"t\":\"no";
    const char* p2 = "tify\",\"id\":7})\r\nsetTime(1790935200);E.setTimeZone(-3.0);(s=>{})(1)\n";
    la.feed((const uint8_t*)p1, strlen(p1), sink);
    CHECK(lines.empty());
    la.feed((const uint8_t*)p2, strlen(p2), sink);
    CHECK(lines.size() == 2);
    Line a = classify(lines[0]);
    CHECK(a.kind == Kind::Gb && a.json == "{\"t\":\"notify\",\"id\":7}");
    Line b = classify(lines[1]);
    CHECK(b.kind == Kind::SetTime && b.epoch == 1790935200LL && b.hasTz && b.tzHours == -3.0f);
    CHECK(classify("print(1)").kind == Kind::Unknown);
    CHECK(classify("GB(nada)").kind == Kind::Unknown);
    // linha longa demais e descartada inteira, a seguinte passa
    lines.clear();
    std::string big(100, 'x');
    big += "\nGB({})\n";
    la.feed((const uint8_t*)big.data(), big.size(), sink);
    CHECK(lines.size() == 1 && lines[0] == "GB({})");
    // fusos
    CHECK(tzPosix(-3.0f) == "<-03>3");
    CHECK(tzPosix(0.0f) == "<+00>0");
    CHECK(tzPosix(5.5f) == "<+0530>-5:30");
    CHECK(tzPosix(-9.5f) == "<-0930>9:30");
    // texto do Android -> Latin-1 desenhavel
    CHECK(latin1Safe("Olá, João!", 64) == "Olá, João!");
    CHECK(latin1Safe("oi \xF0\x9F\x98\x80 tudo", 64) == "oi tudo");           // emoji some
    CHECK(latin1Safe("\xE2\x80\x9C" "disse" "\xE2\x80\x9D \xE2\x80\x94 ok\xE2\x80\xA6", 64) == "\"disse\" - ok...");
    CHECK(latin1Safe("linha1\nlinha2", 64) == "linha1 linha2");
    CHECK(latin1Safe("ação", 4) == "aç");                                     // nao parte o UTF-8
    CHECK(latin1Safe("\xC3", 8).empty());                                      // sequencia truncada
    CHECK(latin1Safe("\x80" "abc", 8) == "abc");
    CHECK(jsonStr("a\"b\\c\n") == "\"a\\\"b\\\\c\\u000a\"");
}

static DeviceStats::Snapshot statsFixture() {
    DeviceStats::Snapshot s{};
    s.uptimeUs = 1234567890ULL;
    s.cpuFreqMHz = 240;
    s.heapFree = 100000; s.heapMin = 80000; s.heapLargest = 60000;
    s.intFree = 90000; s.intMin = 70000; s.intLargest = 50000;
    s.psramFree = 4000000; s.psramTotal = 8000000; s.psramMin = 3900000; s.psramLargest = 3000000;
    s.jsActive = true; s.jsLaunchFree = 180000; s.jsNowFree = 160000;
    s.jsAllocs = 500; s.jsAllocsPeak = 700;
    s.loopBusyUs = 1000; s.loopTotalUs = 10000;
    s.uiFrames = 20; s.uiPresents = 30; s.uiFrameUs = 40000; s.uiFrameUsMax = 8000;
    s.totalRunTimeUs = 999999;
    strcpy(s.tasks[0].name, "IDLE0");
    s.tasks[0].state = 'r'; s.tasks[0].prio = 0; s.tasks[0].stackFree = 900;
    s.tasks[0].runTimeUs = 500000;
    strcpy(s.tasks[1].name, "main");
    s.tasks[1].state = 'R'; s.tasks[1].prio = 1; s.tasks[1].stackFree = 12000;
    s.tasks[1].runTimeUs = 499999;
    s.taskCount = 2;
    return s;
}

// toJson do DeviceStats: a resposta KL_STATS inteira. Pura sobre a struct —
// aqui valida o formato e a degradacao graciosa quando o cap nao basta
// (task parcial volta para tras, "trunc":1, nunca JSON quebrado).
static void testDeviceStatsJson() {
    DeviceStats::Snapshot s = statsFixture();
    char buf[2048];
    size_t n = DeviceStats::toJson(s, buf, sizeof(buf));
    CHECK(n > 0 && n < sizeof(buf));
    std::string js(buf, n);
    CHECK(js.front() == '{' && js.back() == '}');
    CHECK(js.find("\"uptime_us\":1234567890") != std::string::npos);
    CHECK(js.find("\"cpu_mhz\":240") != std::string::npos);
    CHECK(js.find("\"psram_total\":8000000") != std::string::npos);
    CHECK(js.find("\"n\":\"IDLE0\"") != std::string::npos);
    CHECK(js.find("\"rt\":499999") != std::string::npos);
    CHECK(js.find("\"stk\":12000") != std::string::npos);
    CHECK(js.find("\"trunc\":0") != std::string::npos);
    CHECK(js.find("\"allocs_peak\":700") != std::string::npos);
    CHECK(js.find("\"low\":0") != std::string::npos);
    s.memLow = true;
    char lb[2048];
    size_t ln = DeviceStats::toJson(s, lb, sizeof(lb));
    CHECK(ln > 0);
    CHECK(std::string(lb, ln).find("\"low\":1") != std::string::npos);

    // caps cada vez maiores: JSON sempre fechado, nunca estoura o buffer
    for (size_t cap : {40u, 200u, 400u, 520u, 700u, 1000u}) {
        char small[1000];
        CHECK(cap <= sizeof(small));
        size_t m = DeviceStats::toJson(s, small, cap);
        CHECK(m > 0 && m < cap);
        CHECK(small[0] == '{' && small[m - 1] == '}');
    }
    // buffer impossivel: 0 (host descarta em vez de parsear lixo)
    char tiny[16];
    CHECK(DeviceStats::toJson(s, tiny, sizeof(tiny)) == 0);
    // sem tasks: lista vazia fecha certo
    DeviceStats::Snapshot e = statsFixture();
    e.taskCount = 0;
    char eb[600];
    size_t en = DeviceStats::toJson(e, eb, sizeof(eb));
    CHECK(en > 0 && std::string(eb, en).find("\"tasks\":[],\"trunc\":0") != std::string::npos);
}

// MemWatch::classify: limiares, bordas exatas e histerese (sem ESP-IDF).
static void testMemWatch() {
    using MemWatch::Level;
    const uint32_t k = 1024;
    CHECK(MemWatch::classify(20 * k, 8 * k, Level::Ok) == Level::Ok);
    CHECK(MemWatch::classify(9 * k, 8 * k, Level::Ok) == Level::Low);
    CHECK(MemWatch::classify(20 * k, 1 * k, Level::Ok) == Level::Low);
    // bordas exatas contam como Ok (comparacao estrita)
    CHECK(MemWatch::classify(10 * k, 2 * k, Level::Ok) == Level::Ok);
    // em Low, 12 KB ainda nao re-arma (precisa de 14 KB)
    CHECK(MemWatch::classify(12 * k, 8 * k, Level::Low) == Level::Low);
    // re-arme exige free >= 14 KB E largest >= 2 KB
    CHECK(MemWatch::classify(14 * k, 2 * k, Level::Low) == Level::Ok);
    CHECK(MemWatch::classify(15 * k, 1 * k, Level::Low) == Level::Low);
}

// Settings: registro tipado puro (defaults, faixas, parse). O backend NVS
// fica no .cpp do firmware; aqui valida o que decide o valor.
static void testSettings() {
    using Settings::Type;
    const Settings::KeyDef* b = Settings::lookup("brightness");
    CHECK(b != nullptr && b->type == Type::Int);
    CHECK(Settings::parseInt(b->def, nullptr) == false);  // nullptr = recusa
    int def = 0;
    CHECK(Settings::parseInt(b->def, &def) && def == 100);
    CHECK(Settings::clampInt(*b, 0) == 5);
    CHECK(Settings::clampInt(*b, 200) == 100);
    CHECK(Settings::clampInt(*b, 50) == 50);
    CHECK(Settings::lookup("nao_existe") == nullptr);

    bool v = false;
    CHECK(Settings::parseBool("1", &v) && v);
    CHECK(Settings::parseBool("true", &v) && v);
    CHECK(Settings::parseBool("on", &v) && v);
    CHECK(Settings::parseBool("0", &v) && !v);
    CHECK(Settings::parseBool("", &v) && !v);
    CHECK(Settings::parseBool("false", &v) && !v);
    CHECK(Settings::parseBool("off", &v) && !v);
    CHECK(!Settings::parseBool("talvez", &v));

    int n = 0;
    CHECK(Settings::parseInt("42", &n) && n == 42);
    CHECK(Settings::parseInt("-5", &n) && n == -5);
    CHECK(!Settings::parseInt("", &n));
    CHECK(!Settings::parseInt("12x", &n));
    CHECK(!Settings::parseInt("1.5", &n));

    // Sanidade do manifesto: chave unica, default na faixa, min <= max.
    for (size_t i = 0; i < Settings::kKeyCount; ++i) {
        const Settings::KeyDef& d = Settings::kKeys[i];
        CHECK(Settings::lookup(d.key) == &d);  // lookup acha a primeira
        CHECK(d.min <= d.max);
        if (d.type == Type::Int) {
            int dv = 0;
            CHECK(Settings::parseInt(d.def, &dv));
            CHECK(dv >= d.min && dv <= d.max);
        } else if (d.type == Type::Bool) {
            bool dv = false;
            CHECK(Settings::parseBool(d.def, &dv));
        }
    }
}

// ---- MusicEngine (System.playMusic, API 25) ----
// O motor puro e o mesmo do device: compilacao (clamps + eventos em
// amostras) e renderizacao inteira/deterministica.
static void testMusicEngine() {
    using namespace MusicEngine;
    const uint32_t kRate = 16000;

    // musica valida: bateria + baixo, 8 semicolcheias por volta
    Song s;
    s.bpm = 120;   // semicolcheia = 125 ms = 2000 amostras
    s.loops = 2;
    s.nTracks = 2;
    s.tracks[0].drum = true;
    s.tracks[0].vol = 100;
    s.tracks[0].count = 4;
    s.tracks[0].notes[0] = {36, 2};
    s.tracks[0].notes[1] = {42, 2};
    s.tracks[0].notes[2] = {38, 2};
    s.tracks[0].notes[3] = {42, 2};
    s.tracks[1].wave = kWaveTri;
    s.tracks[1].vol = 90;
    s.tracks[1].count = 2;
    s.tracks[1].notes[0] = {40, 4};
    s.tracks[1].notes[1] = {47, 4};

    Compiled c;
    CHECK(compile(s, kRate, c));
    CHECK(c.nTracks == 2);
    CHECK(c.loopSamples == 8 * 2000);      // trilha mais longa manda
    CHECK(c.totalSamples == 2 * c.loopSamples);
    CHECK(c.loops == 2);
    // eventos do baixo: 2 notas, 4 semicolcheias cada
    CHECK(c.tracks[1].count == 2);
    CHECK(c.tracks[1].evs[0].start == 0);
    CHECK(c.tracks[1].evs[0].end == 4 * 2000);
    CHECK(c.tracks[1].evs[1].start == 4 * 2000);

    // clamps: bpm fora da faixa, loops altos demais (teto de 120 s corta),
    // midi > 96, duracao 0 -> 1
    Song bad = s;
    bad.bpm = 999;   // clampado a 200: semicolcheia = 75 ms = 1200 amostras
    bad.loops = 8;
    bad.tracks[1].notes[0] = {120, 0};
    Compiled cb;
    CHECK(compile(bad, kRate, cb));
    CHECK(cb.loops < 8 || cb.totalSamples <= kMaxTotalMs * kRate / 1000);
    CHECK(cb.tracks[1].evs[0].midi == 96);
    CHECK(cb.tracks[1].evs[0].end - cb.tracks[1].evs[0].start == 1200);  // len 0 -> 1

    // musica vazia (so pausas / sem trilhas): nao compila
    Song empty; empty.nTracks = 1; empty.tracks[0].count = 1; empty.tracks[0].notes[0] = {0, 4};
    Compiled ce;
    CHECK(!compile(empty, kRate, ce));

    // render: nota melodica produz som na regiao da nota
    Renderer r;
    r.reset(&c, 100);
    static int16_t buf[16000];
    r.render(buf, 16000);
    bool noteLoud = false;
    for (int i = 1000; i < 7000; i++)   // dentro da nota do baixo
        if (buf[i] > 500 || buf[i] < -500) noteLoud = true;
    CHECK(noteLoud);
    CHECK(r.pos == 16000);
    // mistura inteira/deterministica: dois renderers iguais, mesma saida
    Renderer r2;
    r2.reset(&c, 100);
    static int16_t buf2[16000];
    r2.render(buf2, 16000);
    CHECK(memcmp(buf, buf2, sizeof(buf)) == 0);

    // bateria: bumbo na 1a semicolcheia produz graves fortes
    r.reset(&c, 100);
    int16_t one[2000];
    r.render(one, 2000);
    bool kick = false;
    for (int i = 0; i < 2000; i++) if (one[i] > 1000 || one[i] < -1000) kick = true;
    CHECK(kick);

    // teto de amplitude: nunca estoura o int16
    Song loud = s;
    loud.nTracks = 1;
    loud.tracks[0].drum = false;
    loud.tracks[0].vol = 100;
    loud.tracks[0].count = 1;
    loud.tracks[0].notes[0] = {96, 8};
    Compiled cl;
    CHECK(compile(loud, kRate, cl));
    Renderer rl;
    rl.reset(&cl, 100);
    int16_t lb[8000];
    rl.render(lb, 8000);
    bool clipped = false;
    for (int i = 0; i < 8000; i++) {
        if (lb[i] > 24000 || lb[i] < -24000) clipped = true;
    }
    CHECK(!clipped);
}

// Handoff da musica (API 27): encodeSong/decodeSong compactos (caber numa
// mensagem da malha) e o seek do Renderer (retomar do meio, deterministico).
static void testMusicHandoff() {
    using namespace MusicEngine;

    // song CHEIA: 4 trilhas x 48 notas com timbres/volumes variados
    Song full;
    full.bpm = 160;
    full.loops = 4;
    full.nTracks = kMaxTracks;
    for (int t = 0; t < kMaxTracks; t++) {
        full.tracks[t].drum = (t == 3);
        full.tracks[t].wave = (uint8_t)(t % 4);
        full.tracks[t].vol = (uint8_t)(50 + t);
        full.tracks[t].count = kMaxNotes;
        for (int i = 0; i < kMaxNotes; i++)
            full.tracks[t].notes[i] = {(uint8_t)(36 + ((i * 5) % 60)), (uint8_t)(1 + i % 16)};
    }
    uint8_t buf[netframe::MSG_MAX];
    size_t len = encodeSong(full, buf, sizeof(buf));
    CHECK(len > 0 && len <= 403);  // 4 + 4x3 + 4x48x2 — cabe na msg da malha
    Song back;
    CHECK(decodeSong(buf, len, &back));
    CHECK(back.bpm == 160 && back.loops == 4 && back.nTracks == kMaxTracks);
    for (int t = 0; t < kMaxTracks; t++) {
        CHECK(back.tracks[t].drum == full.tracks[t].drum);
        CHECK(back.tracks[t].wave == full.tracks[t].wave);
        CHECK(back.tracks[t].vol == full.tracks[t].vol);
        CHECK(back.tracks[t].count == kMaxNotes);
    }
    CHECK(back.tracks[1].notes[47].midi == full.tracks[1].notes[47].midi);
    CHECK(back.tracks[1].notes[47].len16 == full.tracks[1].notes[47].len16);

    // round-trip por bytes: re-encode da decodificada e identica
    uint8_t buf2[netframe::MSG_MAX];
    size_t len2 = encodeSong(back, buf2, sizeof(buf2));
    CHECK(len2 == len && memcmp(buf, buf2, len) == 0);

    // lixo nao decoda: magic errado e truncado no meio
    buf[0] = 'X';
    CHECK(!decodeSong(buf, len, &back));
    buf[0] = kSongMagic;
    CHECK(!decodeSong(buf, 3, &back));
    CHECK(!decodeSong(buf, 10, &back));  // cortado dentro das notas

    // seek: duas instancias pulando para o mesmo ponto geram o MESMO
    // audio dali em diante, e a nota em curso soa (nao silencio)
    Song solo;
    solo.bpm = 120;
    solo.loops = 1;
    solo.nTracks = 1;
    solo.tracks[0].wave = kWaveSq;
    solo.tracks[0].vol = 80;
    solo.tracks[0].count = 2;
    solo.tracks[0].notes[0] = {69, 64};  // notas longas (64 s16 ~ 8 s a 120bpm)
    solo.tracks[0].notes[1] = {76, 64};
    constexpr uint32_t rate = 16000;
    Compiled c1, c2;
    CHECK(compile(solo, rate, c1));
    c2 = c1;
    Renderer a, b;
    a.reset(&c1, 90);
    b.reset(&c2, 90);
    b.seek(rate / 2);  // 500 ms: dentro da 1a nota
    int16_t ra[400], rb[400];
    a.render(ra, 400);
    b.render(rb, 400);
    CHECK(memcmp(ra, rb, sizeof(ra)) != 0);  // um comecou do zero, outro do meio
    Renderer d;
    d.reset(&c2, 90);
    d.seek(rate / 2);
    int16_t rd[400];
    d.render(rd, 400);
    CHECK(memcmp(rb, rd, sizeof(rb)) == 0);  // seek e deterministico
    bool sounding = false;
    for (int i = 0; i < 400; i++)
        if (rb[i] > 2000 || rb[i] < -2000) sounding = true;
    CHECK(sounding);  // a nota em curso soa (freqStep calculado no meio)

    // seek alem do fim: clampa no total (task encerra na hora)
    Renderer e;
    e.reset(&c2, 90);
    e.seek(c2.totalSamples + 9999);
    CHECK(e.pos == c2.totalSamples);
}

// CelerNet v3 (NetFrame.h): quadro seguro — round-trip cifrado, ofuscacao,
// MIC adulterado, rede errada, relay sem recifrar, janela anti-replay, dedup
// e remontagem por seqZero (juntando copias). A cifra e FALSA (o PSA do
// firmware tem o self-test no device: shell "mesh selftest").
namespace fakenet {
struct Key { uint8_t k; };
uint8_t mixOf(const Key* key, const uint8_t n[13], const uint8_t* aad, size_t aadLen,
              const uint8_t* data, size_t len, int salt) {
    uint32_t h = 2166136261u ^ key->k ^ (uint32_t)salt;
    for (int i = 0; i < 13; i++) h = (h ^ n[i]) * 16777619u;
    for (size_t i = 0; i < aadLen; i++) h = (h ^ aad[i]) * 16777619u;
    for (size_t i = 0; i < len; i++) h = (h ^ data[i]) * 16777619u;
    return (uint8_t)(h ^ (h >> 8) ^ (h >> 16));
}
bool seal(void* ctx, const uint8_t n[13], const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
          uint8_t* out) {
    const Key* key = (const Key*)ctx;
    for (size_t i = 0; i < len; i++) out[i] = (uint8_t)(in[i] ^ key->k ^ n[i % 13]);
    for (int m = 0; m < 4; m++) out[len + m] = mixOf(key, n, aad, aadLen, in, len, m);
    return true;
}
bool open(void* ctx, const uint8_t n[13], const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
          uint8_t* out) {
    const Key* key = (const Key*)ctx;
    for (size_t i = 0; i < len; i++) out[i] = (uint8_t)(in[i] ^ key->k ^ n[i % 13]);
    for (int m = 0; m < 4; m++) {
        if (in[len + m] != mixOf(key, n, aad, aadLen, out, len, m)) return false;
    }
    return true;
}
void ecb(void* ctx, const uint8_t in[16], uint8_t out[16]) {
    const Key* key = (const Key*)ctx;
    for (int i = 0; i < 16; i++) out[i] = (uint8_t)(in[i] * 7 + key->k + i);
}
netframe::Cipher cipher(Key* k, uint8_t nid) {
    netframe::Cipher c;
    c.ctx = k;
    c.nid = nid;
    c.seal = seal;
    c.open = open;
    c.ecb = ecb;
    return c;
}
}  // namespace fakenet

static void testNetFrame() {
    using namespace netframe;
    fakenet::Key ka{0x5A}, kb{0x3C};
    Cipher na = fakenet::cipher(&ka, 0x11), nb = fakenet::cipher(&kb, 0x22);
    Cipher nbSameNid = fakenet::cipher(&kb, 0x11);  // colisao de nid, chave diferente

    uint8_t buf[ADV_MAX];
    Frame f;
    f.type = TYPE_DATA;
    f.src = 0x1234;
    f.dst = 0xA1B2;
    f.seq = 0xABCDEF;
    f.ttl = 4;
    f.hops = 2;
    const uint8_t payload[DATA_MAX] = "0123456789ABCDE";
    f.dlen = DATA_MAX;
    f.data = payload;
    size_t n = encode(f, na, buf, sizeof(buf));
    CHECK(n == ADV_MAX);
    CHECK(buf[0] == 'C' && (buf[1] >> 4) == 3 && buf[2] == 0x11 && buf[3] == 0x42);
    // seq/src/dst nao aparecem em claro
    CHECK(!(buf[7] == 0x12 && buf[8] == 0x34 && buf[9] == 0xA1 && buf[10] == 0xB2));
    CHECK(memcmp(buf + HDR, payload, DATA_MAX) != 0);
    Frame g;
    uint8_t plain[DATA_MAX];
    int net = -1;
    Cipher both[2] = {nb, na};
    CHECK(decode(buf, n, both, 2, &g, plain, &net) && net == 1);
    CHECK(g.type == TYPE_DATA && g.src == 0x1234 && g.dst == 0xA1B2 && g.seq == 0xABCDEF);
    CHECK(g.ttl == 4 && g.hops == 2 && g.dlen == DATA_MAX && memcmp(g.data, payload, DATA_MAX) == 0);
    // outra rede (nid diferente) e chave errada com o mesmo nid: nao decifra
    CHECK(!decode(buf, n, &nb, 1, &g, plain, &net));
    CHECK(!decode(buf, n, &nbSameNid, 1, &g, plain, &net));
    // MIC adulterado / dado adulterado / cabecalho ofuscado adulterado
    uint8_t bad[ADV_MAX];
    memcpy(bad, buf, n); bad[n - 1] ^= 1;  CHECK(!decode(bad, n, &na, 1, &g, plain, &net));
    memcpy(bad, buf, n); bad[HDR] ^= 1;    CHECK(!decode(bad, n, &na, 1, &g, plain, &net));
    memcpy(bad, buf, n); bad[8] ^= 1;      CHECK(!decode(bad, n, &na, 1, &g, plain, &net));
    memcpy(bad, buf, n); bad[1] ^= 1;      CHECK(!decode(bad, n, &na, 1, &g, plain, &net));  // tipo no AAD
    // relay: so o byte de ttl/saltos muda e o quadro segue autenticando
    memcpy(bad, buf, n);
    CHECK(relayPatch(bad, n) && bad[3] == 0x33);
    CHECK(memcmp(bad + 4, buf + 4, n - 4) == 0);
    CHECK(decode(bad, n, &na, 1, &g, plain, &net) && g.ttl == 3 && g.hops == 3 && g.seq == 0xABCDEF);
    bad[3] = 0x10;
    CHECK(!relayPatch(bad, n));  // ttl 1 nao repete
    // rejeicoes de encode e lixo no ar
    Frame e = f; e.dlen = DATA_MAX + 1; CHECK(encode(e, na, buf, sizeof(buf)) == 0);
    e = f; e.ttl = 0;            CHECK(encode(e, na, buf, sizeof(buf)) == 0);
    e = f; e.ttl = TTL_MAX + 1;  CHECK(encode(e, na, buf, sizeof(buf)) == 0);
    e = f; e.seq = SEQ_MAX + 1;  CHECK(encode(e, na, buf, sizeof(buf)) == 0);
    CHECK(!looksLike(buf, HDR + MIC - 1));
    n = encode(f, na, buf, sizeof(buf));
    buf[1] = (uint8_t)((2 << 4) | TYPE_DATA);  // v2 no ar
    CHECK(!decode(buf, n, &na, 1, &g, plain, &net));
    // BEAT curto (1 byte de dados): mascara com menos de 7 bytes cifrados
    Frame bt;
    bt.type = TYPE_BEAT;
    bt.src = 0x0E0E;
    bt.seq = 1;
    const uint8_t caps = CAPS_MIC;
    bt.data = &caps;
    bt.dlen = 1;
    n = encode(bt, na, buf, sizeof(buf));
    CHECK(n == HDR + 1 + MIC && decode(buf, n, &na, 1, &g, plain, &net) && g.dlen == 1 && plain[0] == CAPS_MIC);

    // anti-replay: janela de 64 com reordenacao
    Rpl<4> rpl;
    CHECK(rpl.check(0, 0xAA, 100) == Rpl<4>::NEW);
    rpl.commit(0, 0xAA, 100, 1);
    CHECK(rpl.check(0, 0xAA, 100) == Rpl<4>::REPLAY);
    CHECK(rpl.check(0, 0xAA, 99) == Rpl<4>::NEW);     // chegou fora de ordem: vale
    rpl.commit(0, 0xAA, 99, 2);
    CHECK(rpl.check(0, 0xAA, 99) == Rpl<4>::REPLAY);
    rpl.commit(0, 0xAA, 180, 3);                       // janela andou
    CHECK(rpl.check(0, 0xAA, 116) == Rpl<4>::REPLAY);  // 64 atras: velho demais
    CHECK(rpl.check(0, 0xAA, 117) == Rpl<4>::NEW);
    CHECK(rpl.check(1, 0xAA, 100) == Rpl<4>::NEW);     // outra rede, outra janela
    for (uint16_t s = 1; s <= 4; s++) rpl.commit(2, s, 5, 10 + s);  // enche: recicla o mais velho
    CHECK(rpl.check(0, 0xAA, 180) == Rpl<4>::NEW);     // (0,AA) era o mais antigo
    // chave MAC (ESP-NOW): 48 bits nao colidem nos 16 de baixo
    Rpl<4, uint64_t> rm;
    rm.commit(0, 0x24A1600112ABull, 7, 1);
    CHECK(rm.check(0, 0x24A1600112ABull, 7) == (Rpl<4, uint64_t>::REPLAY));
    CHECK(rm.check(0, 0x30AE000112ABull, 7) == (Rpl<4, uint64_t>::NEW));

    // dedup por (src, seq)
    DedupRing<4> d;
    CHECK(!d.seen(1, 10) && d.seen(1, 10) && !d.seen(1, 11) && !d.seen(2, 10));

    // remontagem: 40 B em 3 fragmentos, 2 copias; seqs consecutivos
    uint8_t msg[40];
    for (int i = 0; i < 40; i++) msg[i] = (uint8_t)(i * 3);
    const uint8_t total = 3;
    const uint32_t seqZero = 500;
    Reassembler ra;
    uint8_t outMsg[MSG_MAX];
    size_t outLen = 0;
    auto chunkOf = [&](uint8_t i) { return msg + i * CHUNK_MAX; };
    auto lenOf = [&](uint8_t i) { return (uint8_t)(i + 1 < total ? CHUNK_MAX : 40 - CHUNK_MAX * (total - 1)); };
    // copia 0 perde o frag 1; a copia 1 traz o frag 1 com seq proprio
    CHECK(fragSeqZero(seqZero + 0, 0, total) == seqZero);
    CHECK(!ra.feed(7, fragSeqZero(500, 0, total), 0, total, chunkOf(0), lenOf(0), 1, outMsg, sizeof(outMsg), &outLen));
    CHECK(!ra.feed(7, fragSeqZero(502, 2, total), 2, total, chunkOf(2), lenOf(2), 2, outMsg, sizeof(outMsg), &outLen));
    const uint8_t idxCopy1 = (uint8_t)(1 | (1 << FRAG_COPY_SHIFT));
    CHECK(fragSeqZero(seqZero + total + 1, idxCopy1, total) == seqZero);
    CHECK(ra.feed(7, fragSeqZero(seqZero + total + 1, idxCopy1, total), idxCopy1, total, chunkOf(1), lenOf(1), 3,
                  outMsg, sizeof(outMsg), &outLen));
    CHECK(outLen == 40 && memcmp(outMsg, msg, 40) == 0);
    // a mesma mensagem nao remonta de novo (resto das copias)
    CHECK(!ra.feed(7, seqZero, 0, total, chunkOf(0), lenOf(0), 4, outMsg, sizeof(outMsg), &outLen));
    // fragmento perdido: o slot vence no prune
    Reassembler rb;
    CHECK(!rb.feed(8, 900, 0, total, chunkOf(0), lenOf(0), 0, outMsg, sizeof(outMsg), &outLen));
    rb.prune(10000, 6000);
    CHECK(!rb.feed(8, 900, 1, total, chunkOf(1), lenOf(1), 10001, outMsg, sizeof(outMsg), &outLen));
    CHECK(!rb.feed(8, 900, 2, total, chunkOf(2), lenOf(2), 10002, outMsg, sizeof(outMsg), &outLen));
}

// System.sfx (API 32): voz de efeito misturada por cima da trilha
static void testSfxVoice() {
    using namespace MusicEngine;
    SfxVoice v;
    const SfxTone mel[] = {{880, 10}, {0, 5}, {440, 10}};
    CHECK(v.load(mel, 3, 44100) == 3);
    CHECK(v.active());
    // 25 ms a 44,1 kHz = 1102 amostras (441 + 220 + 441)
    int n = 0, nonzero = 0, pauseNonzero = 0;
    while (v.active() && n < 5000) {
        const int32_t s = v.next();
        if (s != 0) nonzero++;
        if (n >= 445 && n < 657 && s != 0) pauseNonzero++;  // miolo da pausa
        if (s > 256 || s < -256) nonzero = -100000;          // fora da faixa
        n++;
    }
    CHECK(n == 441 + 220 + 441);
    CHECK(nonzero > 800);
    CHECK(pauseNonzero == 0);
    CHECK(!v.active());
    CHECK(v.next() == 0);

    // clamps: freq fora da faixa pula, ms > 1000 corta, total 3 s
    const SfxTone ruim[] = {{5, 100}, {30000, 100}, {500, 5000}, {600, 1000},
                            {700, 1000}, {800, 1000}, {900, 50}};
    CHECK(v.load(ruim, 7, 16000) == 3);   // 500(1000) 600(1000) 700(1000) = 3 s
    CHECK(v.tones[0].ms == 1000);
    CHECK(v.load(nullptr, 3, 44100) == 0);
    CHECK(v.load(mel, 3, 1000) == 0);     // taxa absurda

    // mix: trilha abaixa (sidechain) e o efeito soma; nunca estoura
    int16_t buf[64];
    for (int i = 0; i < 64; i++) buf[i] = 20000;
    const SfxTone alto[] = {{1000, 100}};
    v.load(alto, 1, 44100);
    v.mix(buf, 64, 100 * 200);
    bool okRange = true, ducked = false;
    for (int i = 0; i < 64; i++) {
        if (buf[i] > 24000 || buf[i] < -24000) okRange = false;
        if (buf[i] < 20000) ducked = true;
    }
    CHECK(okRange);
    CHECK(ducked);
    // sem efeito ativo o mix nao toca no bloco
    v.stop();
    for (int i = 0; i < 64; i++) buf[i] = 1234;
    v.mix(buf, 64, 20000);
    CHECK(buf[0] == 1234 && buf[63] == 1234);
}

// K do quadro (FrameSprite::kMaxDirty = 32): estrelas/poeira espalhadas
// (30 pixels pela tela) continuam caixas PEQUENAS — com 8 vagas elas viravam
// uniões de quase a tela inteira e o present empurrava ~200 mil px por
// quadro (Supernova, bancada 2026-10-18)
static void testDirtyRectsScattered() {
    celer::DirtyRects<32> d;
    celer::DirtyRect out[32];
    for (int i = 0; i < 30; i++) {
        const int x = (i * 97) % 470, y = (i * 61) % 470;
        d.add(x, y, x, y);
    }
    const int n = d.take(out, 480, 480);
    long area = 0;
    for (int k = 0; k < n; k++) area += (long)(out[k].r - out[k].l + 1) * (out[k].b - out[k].t + 1);
    CHECK(n > 1);
    CHECK(area < 480L * 480L / 10);   // < 10% da tela (com K=8 dava 44%)
}

// FrameSprite: varias caixas sujas no lugar da uniao (tremor da 4848)
static void testDirtyRects() {
    celer::DirtyRects<8> d;
    celer::DirtyRect out[8];
    CHECK(d.take(out, 480, 480) == 0);

    // dois sprites em cantos opostos: 2 caixas, nao o vidro inteiro
    d.add(0, 0, 31, 31);
    d.add(440, 440, 479, 479);
    CHECK(d.count() == 2);
    CHECK(d.touchesAbove(10));
    int n = d.take(out, 480, 480);
    CHECK(n == 2);
    CHECK(!d.any());

    // vizinhas (gap < 8) e sobrepostas fundem; contida nao cria caixa
    d.add(100, 100, 120, 120);
    d.add(125, 100, 140, 120);   // 4 px de folga: funde
    d.add(105, 105, 110, 110);   // contida
    CHECK(d.count() == 1);
    n = d.take(out, 480, 480);
    CHECK(n == 1 && out[0].l == 100 && out[0].r == 140);

    // cascata: uma caixa que cresce engole as que passou a tocar
    d.add(0, 0, 10, 10);
    d.add(40, 0, 50, 10);
    d.add(80, 0, 90, 10);
    CHECK(d.count() == 3);
    d.add(5, 0, 85, 10);         // ponte entre as tres
    CHECK(d.count() == 1);
    d.clear();

    // estouro de K: funde na que menos cresce, nunca perde area
    for (int i = 0; i < 12; i++) d.add(i * 40, i * 40, i * 40 + 4, i * 40 + 4);
    CHECK(d.count() <= 8);
    n = d.take(out, 480, 480);
    bool covered = true;
    for (int i = 0; i < 12; i++) {
        const int x = i * 40 + 2, y = i * 40 + 2;
        bool in = false;
        for (int k = 0; k < n; k++)
            if (x >= out[k].l && x <= out[k].r && y >= out[k].t && y <= out[k].b) in = true;
        if (!in) covered = false;
    }
    CHECK(covered);

    // recorte ao painel + caixas que ja cobrem a uniao saem como 1 push
    d.add(-20, -20, 300, 479);
    d.add(310, 0, 600, 479);
    n = d.take(out, 480, 480);
    CHECK(n == 1 && out[0].l == 0 && out[0].t == 0 && out[0].r == 479 && out[0].b == 479);

    d.markAll(480, 480);
    CHECK(d.count() == 1);
    d.add(10, 10, 20, 20);       // caminho quente: contida na ultima
    CHECK(d.count() == 1);
}

// deps.json (API 30): o parser antigo devolvia 0 pares para qualquer objeto
static void testJsonMap() {
    JsonStringPair p[8];
    int n = celer::parseJsonStringMap("{\"celeros.engine\": \"1.2.0\", \"celeros.physics\": \"1.3.0\"}", p, 8);
    CHECK(n == 2);
    CHECK(p[0].key == "celeros.engine" && p[0].value == "1.2.0");
    CHECK(p[1].key == "celeros.physics" && p[1].value == "1.3.0");
    n = celer::parseJsonStringMap("{\"a\":\"1\",\"b\":\"2\"}", p, 8);   // compacto
    CHECK(n == 2 && p[1].key == "b" && p[1].value == "2");
    n = celer::parseJsonStringMap("{\n  \"a\": 3,\n  \"b\": {\"x\": 1},\n  \"c\": \"ok\"\n}", p, 8);
    CHECK(n == 1 && p[0].key == "c" && p[0].value == "ok");   // nao-strings pulados
    CHECK(celer::parseJsonStringMap("{}", p, 8) == 0);
    CHECK(celer::parseJsonStringMap("", p, 8) == 0);
    CHECK(celer::parseJsonStringMap("{\"a\":\"1\",\"b\":\"2\",\"c\":\"3\"}", p, 2) == 2);   // teto
    n = celer::parseJsonStringMap("{\"k\\\"q\": \"v\"}", p, 8);   // aspa escapada na chave
    CHECK(n == 1 && p[0].value == "v");
    CHECK(celer::parseJsonStringMap("{\"a\":\"1\"", p, 8) == 1);   // truncado: o que deu
}

// Corpo rigido (API 33): o mesmo header do System.rigid* — pilha estavel
// que dorme, tiro que derruba sem atravessar, anti-tunel e indice estavel
static void testRigid2D() {
    using namespace celer::rigid;
    static World W;
    worldInit(&W, 10);
    int chao = addBody(&W, BOX, 160, 270, 200, 10, 0, 0, 0.7f, 0);
    CHECK(chao == 0);
    float y = 260;
    int ids[9];
    for (int f = 0; f < 3; f++) {
        ids[f * 3] = addBody(&W, BOX, 200, y - 15, 3, 15, 0, 1, 0.7f, 0.1f);
        ids[f * 3 + 1] = addBody(&W, BOX, 236, y - 15, 3, 15, 0, 1, 0.7f, 0.1f);
        ids[f * 3 + 2] = addBody(&W, BOX, 218, y - 33, 24, 3, 0, 1, 0.7f, 0.1f);
        y -= 36;
    }
    int bola = addBody(&W, CIRCLE, 218, y - 7, 7, 7, 0, 0.6f, 0.6f, 0.2f);
    CHECK(bola == 10);
    for (int t = 0; t < 120; t++) step(&W, 1 / 30.f, 0, 400, 12);
    float maxDy = 0;
    int acordados = 0;
    y = 260;
    for (int f = 0; f < 3; f++) {
        float d1 = fabsf(W.bodies[ids[f * 3]].y - (y - 15));
        float d2 = fabsf(W.bodies[ids[f * 3 + 2]].y - (y - 33));
        if (d1 > maxDy) maxDy = d1;
        if (d2 > maxDy) maxDy = d2;
        y -= 36;
    }
    for (int i = 1; i <= 10; i++) acordados += W.bodies[i].awake;
    CHECK(maxDy < 1.0f);          // torre de pe (compressao ~ slop)
    CHECK(acordados == 0);        // e dormindo
    CHECK(fabsf(W.bodies[bola].y - (y - 7)) < 1.0f);

    int pedra = addBody(&W, CIRCLE, 40, 200, 6, 6, 0, 3, 0.6f, 0.3f);
    setBody(&W, pedra, 40, 200, 0, 420, -40, 0);
    float hitMax = 0;
    for (int t = 0; t < 30; t++) {
        step(&W, 1 / 30.f, 0, 400, 12);
        for (int i = 1; i <= 10; i++) if (W.bodies[i].hit > hitMax) hitMax = W.bodies[i].hit;
    }
    CHECK(hitMax > 1000);         // impacto vira impulso p/ o dano
    CHECK(W.bodies[pedra].x < 330);
    int caidos = 0;
    for (int i = 1; i <= 9; i++) if (fabsf(W.bodies[i].a) > 0.5f) caidos++;
    CHECK(caidos >= 3);           // o tiro derrubou de verdade
    for (int t = 0; t < 300; t++) step(&W, 1 / 30.f, 0, 400, 12);
    acordados = 0;
    for (int i = 1; i < W.nBodies; i++) acordados += W.bodies[i].awake;
    CHECK(acordados == 0);        // escombro assenta e dorme (sem tremor eterno)

    // anti-tunel: tabua estatica de 5 x pedra a 900 u/s
    static World T;
    worldInit(&T, 10);
    addBody(&T, BOX, 160, 270, 200, 10, 0, 0, 0.7f, 0);
    addBody(&T, BOX, 150, 230, 2.5f, 30, 0, 0, 0.5f, 0);
    int q = addBody(&T, CIRCLE, 40, 230, 5, 5, 0, 3, 0.5f, 0.2f);
    setBody(&T, q, 40, 230, 0, 900, 0, 0);
    int subMax = 0;
    for (int t = 0; t < 30; t++) {
        int sub = step(&T, 1 / 30.f, 0, 400, 12);
        if (sub > subMax) subMax = sub;
    }
    CHECK(T.bodies[q].x < 150);
    CHECK(subMax > 4);            // sub-passos subiram com a pedra rapida

    // indice estavel: remover libera o slot, o add reaproveita; remover
    // acorda o mundo (o que estava em cima cai)
    CHECK(removeBody(&W, ids[4]));
    CHECK(!removeBody(&W, ids[4]));
    CHECK(addBody(&W, BOX, 10, 10, 2, 2, 0, 1, 0.5f, 0) == ids[4]);
    CHECK(addBody(&W, BOX, 0, 0, 0, 2, 0, 1, 0.5f, 0) == -1);   // medida invalida

    // setBody (teleporte) acorda quem estava em cima do ANTIGO lugar: pilha
    // dormida nao tem arbitro nenhum (a fase larga pula par todo dormindo e
    // o contato morre na compactacao), entao acordar so os parceiros de
    // arbitro nao pegaria o carona — o vizinho e achado por proximidade
    static World S;
    worldInit(&S, 10);
    int suporte = addBody(&S, BOX, 160, 200, 40, 10, 0, 0, 0.7f, 0);
    int carona = addBody(&S, BOX, 160, 180, 10, 10, 0, 1, 0.7f, 0);
    for (int t = 0; t < 120; t++) step(&S, 1 / 30.f, 0, 400, 12);
    CHECK(!S.bodies[carona].awake);      // assentou em cima do suporte e dormiu
    CHECK(S.nArb == 0);                  // sem arbitro: o par e todo dormente
    float ySono = S.bodies[carona].y;
    CHECK(setBody(&S, suporte, 400, 300, 0, 0, 0, 0));  // suporte sai de baixo
    CHECK(S.bodies[carona].awake);       // acordou na hora do teleporte
    for (int t = 0; t < 120; t++) step(&S, 1 / 30.f, 0, 400, 12);
    CHECK(S.bodies[carona].y > ySono + 40);   // e caiu de verdade (sem flutuar)

    // cache de cos/sin (so quem girou recalcula) e do raio envolvente: o
    // cache sempre vale para o angulo ca, parado/estatico fica no angulo
    // atual, e o teleporte com giro novo e' visto no proximo sub-passo
    bool cacheOk = true;
    for (int i = 0; i < S.nBodies; i++) {
        const Body& b = S.bodies[i];
        if (!b.alive) continue;
        if (b.c != cosf(b.ca) || b.s != sinf(b.ca)) cacheOk = false;
        if (b.shape == BOX && b.br != sqrtf(b.hw * b.hw + b.hh * b.hh)) cacheOk = false;
        if ((!b.awake || b.invM == 0) && b.ca != b.a) cacheOk = false;
    }
    CHECK(cacheOk);
    CHECK(setBody(&S, suporte, 400, 300, 0.7f, 0, 0, 0));
    step(&S, 1 / 30.f, 0, 400, 12);
    CHECK(fabsf(S.bodies[suporte].c - cosf(S.bodies[suporte].ca)) < 1e-7f &&
          fabsf(S.bodies[suporte].ca - 0.7f) < 0.05f);
}

// Martelo do Rigid2D: sequencias adversarias (remove/setBody teleporte/
// steps criando e destruindo contatos) num mundo denso, milhares de
// ciclos com PRNG semeado (deterministico). Confere APOS CADA mutacao e
// CADA step: arbitros estritamente ordenados por (a,b) sem duplicata,
// apontando so pra corpo vivo, dentro do teto — e nenhum corpo vivo com
// posicao/velocidade nao-finitas (o veneno que acordaria o mundo para
// sempre). Acha quebra do findArb binario (busca em array nao ordenado
// criava arbitro duplicado do mesmo par)
static void testRigid2DHammer() {
    using namespace celer::rigid;
    static World W;
    worldInit(&W, 10);
    // cenario: arena fechada densa — chao, teto e paredes estaticas
    addBody(&W, BOX, 120, 310, 240, 10, 0, 0, 0.7f, 0);
    addBody(&W, BOX, 120, -10, 240, 10, 0, 0, 0.7f, 0);
    addBody(&W, BOX, -10, 150, 10, 320, 0, 0, 0.7f, 0);
    addBody(&W, BOX, 250, 150, 10, 320, 0, 0, 0.7f, 0);
    auto addRandom = [&]() {
        uint32_t r = g_rng;
        g_rng = g_rng * 1664525u + 1013904223u;
        uint32_t r2 = g_rng;
        g_rng = g_rng * 1664525u + 1013904223u;
        uint32_t r3 = g_rng;
        g_rng = g_rng * 1664525u + 1013904223u;
        bool circ = (r & 1) != 0;
        float hw = 2.0f + (r % 900) / 100.0f;         // 2..11
        float hh = circ ? hw : 2.0f + ((r >> 8) % 900) / 100.0f;
        float x = 4.0f + (r2 % 22000) / 100.0f;       // 4..224
        float y = 4.0f + ((r2 >> 8) % 28000) / 100.0f;  // 4..284
        float dens = (r3 % 7) == 0 ? 0.0f : 0.2f + (r3 % 500) / 100.0f;
        float mu = (r3 % 11) / 10.0f;
        float e = (r3 % 6) / 10.0f;
        return addBody(&W, circ ? CIRCLE : BOX, x, y, hw, hh,
                       ((r >> 12) % 628) / 100.0f, dens, mu, e);
    };
    int vivos = 0;
    for (int i = 0; i < 56; i++) if (addRandom() >= 0) vivos++;
    CHECK(vivos > 50);                 // mundo denso de verdade
    CHECK(arbOk(&W));
    // 9000 ciclos (0,2 s no host): remove aleatoria, teleporte pelo mapa
    // (as vezes EM CIMA de outro corpo — sobreposicao funda), impulso,
    // repondo corpo, step com dt/gravidade variando
    int telep = 0, remov = 0, addcnt = 0;
    for (int it = 0; it < 9000; it++) {
        uint32_t op = g_rng;
        g_rng = g_rng * 1664525u + 1013904223u;
        if ((op % 100) < 10 && W.nBodies > 6) {      // removeBody aleatorio
            int i = (int)((op >> 8) % (uint32_t)W.nBodies);
            if (removeBody(&W, i)) remov++;
            CHECK(arbOk(&W));
        }
        op = g_rng;
        g_rng = g_rng * 1664525u + 1013904223u;
        if ((op % 100) < 14) {                       // teleporte cross-map
            int i = (int)((op >> 8) % (uint32_t)W.nBodies);
            float x = 4.0f + (op % 21000) / 100.0f;
            float y = 4.0f + ((op >> 12) % 27000) / 100.0f;
            float a = ((op >> 4) % 628) / 100.0f;
            float vx = ((int)(op % 4000) - 2000) / 10.0f;
            float vy = ((int)((op >> 6) % 4000) - 2000) / 10.0f;
            if (setBody(&W, i, x, y, a, vx, vy, 0)) telep++;
            CHECK(arbOk(&W));
        }
        op = g_rng;
        g_rng = g_rng * 1664525u + 1013904223u;
        if ((op % 100) < 8 && W.nBodies < kMaxBodies - 1) {
            if (addRandom() >= 0) addcnt++;
            CHECK(arbOk(&W));
        }
        op = g_rng;
        g_rng = g_rng * 1664525u + 1013904223u;
        if ((op % 100) < 10) {                       // impulso (acorda)
            int i = (int)((op >> 8) % (uint32_t)W.nBodies);
            impulse(&W, i, ((int)(op % 2000) - 1000) / 2.0f, ((int)((op >> 5) % 2000) - 1000) / 2.0f);
        }
        float dt = 1.0f / (25.0f + (op % 75));       // 1/100..1/25 s
        float gy = (op & 0x100) ? 400.0f : 0.0f;     // as vezes sem gravidade
        float gx = (op & 0x200) ? 60.0f : 0.0f;
        step(&W, dt, gx, gy, 8);
        CHECK(arbOk(&W));
        bool finite = true;
        for (int i = 0; i < W.nBodies; i++) {
            const Body& b = W.bodies[i];
            if (!b.alive) continue;
            if (!finf(b.x) || !finf(b.y) || !finf(b.a) || !finf(b.vx) || !finf(b.vy)) finite = false;
        }
        CHECK(finite);
    }
    CHECK(telep > 100 && remov > 100 && addcnt > 50);  // a sequencia exercitou
}

// Sondas de matematica do solver (round 3b): (a) hit fantasma em repouso,
// (b) restituicao em razao de massa extrema, (c) correcao de posicao sob
// compressao, (d) rolamento consistente entre contagens de sub-passo,
// (e) varredura de divisao por zero, (f) bordas do anti-tunel
static void testRigid2DMath() {
    using namespace celer::rigid;

    // (a) contato em repouso NAO e' impacto: o corpo chega ao pre-step com
    // g*dt do sub-passo e o hit gravava o "peso" TODO step (792 u/s*peso na
    // pilha do probe). Acordar do sono idem — o hit so abre com aproximacao
    // de verdade (kBounceMin)
    {
        static World W;
        worldInit(&W, 10);
        addBody(&W, BOX, 160, 270, 200, 10, 0, 0, 0.7f, 0);
        int pilha[4];
        for (int i = 0; i < 4; i++)
            pilha[i] = addBody(&W, BOX, 160, 249 - i * 10, 12, 5, 0, 1, 0.7f, 0.1f);
        for (int t = 0; t < 120; t++) step(&W, 1 / 30.f, 0, 400, 12);
        int acordados = 0;
        for (int i = 0; i < 4; i++) acordados += W.bodies[pilha[i]].awake;
        CHECK(acordados == 0);                     // assentou e dormiu
        float hitMax = 0;
        for (int t = 0; t < 30; t++) {             // removeBody distante = wakeAll
            step(&W, 1 / 30.f, 0, 400, 12);
            for (int i = 0; i < 4; i++)
                if (W.bodies[pilha[i]].hit > hitMax) hitMax = W.bodies[pilha[i]].hit;
        }
        CHECK(hitMax == 0);                        // repouso acordado: sem hit
    }

    // (b) corpo LEVE preso entre pesado e chao (razao 75x..37500x): sem as
    // valvulas, o alvo de restituicao repetido por sub-passo crescia (1+e)
    // por ciclo — probe antigo: saida a 6369 u/s e tunel pelo chao
    for (float dens : {1.0f, 60.0f, 500.0f}) {
        static World W;
        worldInit(&W, 10);
        addBody(&W, BOX, 160, 270, 200, 10, 0, 0, 0.7f, 0);
        addBody(&W, BOX, 160, 200, 20, 8, 0, 0.05f, 0.6f, 0.5f);
        addBody(&W, BOX, 160, 100, 30, 30, 0, dens, 0.6f, 0.5f);
        for (int t = 0; t < 300; t++) step(&W, 1 / 30.f, 0, 400, 12);
        // o leve fica EM CIMA do chao (nao atravessa, nao ejetado ao espaco)
        CHECK(W.bodies[1].y > 240 && W.bodies[1].y < 266);
        CHECK(finf(W.bodies[1].y) && finf(W.bodies[2].y));
    }
    // ...e o quique LEGITIMO segue fisico: bola e=0.75 cai 132, sai a ~0.75v
    {
        static World W;
        worldInit(&W, 10);
        addBody(&W, BOX, 160, 270, 200, 10, 0, 0, 0.7f, 0);
        int b = addBody(&W, CIRCLE, 160, 120, 8, 8, 0, 1, 0.6f, 0.75f);
        float vySaida = 0;
        float vyPrev = 0;
        for (int t = 0; t < 40 && vySaida == 0; t++) {
            step(&W, 1 / 30.f, 0, 400, 12);
            if (vyPrev > 200 && W.bodies[b].vy < 0) vySaida = -W.bodies[b].vy;
            vyPrev = W.bodies[b].vy;
        }
        CHECK(vySaida > 200 && vySaida < 280);     // teorico 244 (0.75 de 325)
    }

    // (c) compressao 1000x (pesado em cima do leve no chao): a correcao em
    // pseudo-velocidade e' limitada a kBiasFactor da penetracao POR
    // sub-passo — equilibrio born, nao cresce sem limite
    {
        static World W;
        worldInit(&W, 10);
        addBody(&W, BOX, 160, 270, 200, 10, 0, 0, 0.7f, 0);
        addBody(&W, BOX, 160, 254, 30, 6, 0, 0.05f, 0.6f, 0);
        addBody(&W, BOX, 160, 236, 40, 18, 0, 50, 0.6f, 0);
        float penMax = 0;
        for (int t = 0; t < 600; t++) {
            step(&W, 1 / 30.f, 0, 400, 12);
            float pen = 250 - (W.bodies[1].y - 6);   // base do leve vs topo do chao
            if (pen > penMax) penMax = pen;
        }
        CHECK(penMax < 8);                          // born (probe: ~5), sem fuga
        CHECK(fabsf(W.bodies[1].y - 263) < 8);      // e o leve segue em pe
    }

    // (d) rolamento: atrito do contato gira a bola, e o resultado nao
    // depende de quantos sub-passos o mesmo tempo leva (kRollDamp e'
    // geometrico por sub-passo -> exponencial por segundo)
    {
        float dx[2] = {0, 0}, w[2] = {0, 0};
        for (int mode = 0; mode < 2; mode++) {
            static World W;
            worldInit(&W, 10);
            addBody(&W, BOX, 160, 270, 200, 10, 0, 0, 0.9f, 0);
            int bola = addBody(&W, CIRCLE, 60, 258, 7, 7, 0, 1, 0.9f, 0);
            setBody(&W, bola, 60, 258, 0, 120, 0, 0);
            float x0 = W.bodies[bola].x;
            if (mode == 0) { for (int t = 0; t < 60; t++) subStep(&W, 1 / 60.f, 0, 400); }
            else { for (int t = 0; t < 120; t++) subStep(&W, 1 / 120.f, 0, 400); }
            dx[mode] = W.bodies[bola].x - x0;
            w[mode] = W.bodies[bola].w;
        }
        CHECK(fabsf(w[0]) > 0.5f);                  // atrito gira (rola, nao desliza)
        CHECK(fabsf(dx[0] - dx[1]) < 6.0f);         // 1s nos dois modos: mesmo lugar
        CHECK(fabsf(w[0] - w[1]) < 0.35f);          // ...e mesma rotacao
    }

    // (e) varredura de divisao por zero
    {
        static World W;
        worldInit(&W, 10);
        CHECK(step(&W, 0, 0, 400, 12) == 0);        // dt 0
        CHECK(step(&W, -1, 0, 400, 12) == 0);       // negativo
        CHECK(step(&W, NAN, 0, 400, 12) == 0);      // NaN
        CHECK(step(&W, 1e-45f, 0, 400, 12) == 0);   // denormal: invDt seria inf
        int a = addBody(&W, BOX, 160, 200, 20, 10, 0, 1, 0.6f, 0);
        addBody(&W, BOX, 160, 240, 20, 10, 0, 0, 0.6f, 0);
        step(&W, 1e-45f, 0, 400, 12);               // com contato: mundo intacto
        CHECK(finf(W.bodies[a].y) && W.bodies[a].y == 200);
        // densidade denormal: invM seria inf e o warm start NaN — vira estatico
        CHECK(addBody(&W, BOX, 100, 10, 4, 4, 0, 1e-45f, 0.6f, 0) >= 0);
        CHECK(W.bodies[W.nBodies - 1].invM == 0);
        // medida zero / NaN nem entra
        CHECK(addBody(&W, BOX, 10, 10, 0, 0, 0, 1, 0.6f, 0) == -1);
        CHECK(addBody(&W, BOX, 10, 10, 10, 0, 0, 1, 0.6f, 0) == -1);
        CHECK(addBody(&W, CIRCLE, 10, 10, 0, 0, 0, 1, 0.6f, 0) == -1);
        CHECK(addBody(&W, BOX, NAN, 10, 4, 4, 0, 1, 0.6f, 0) == -1);
        // gravidade NaN nao envenena velocidade
        step(&W, 1 / 30.f, NAN, 400, 12);
        CHECK(finf(W.bodies[a].vx));
        // maxSub NaN (comparacoes falsas): cai no piso 1, nao estoura kMaxSub
        CHECK(step(&W, 1 / 30.f, 0, 400, (int)NAN) >= 1);
        // impulso em corpo dormindo ACORDA (rigidImpulse do jogo de arrasto)
        static World S;
        worldInit(&S, 10);
        addBody(&S, BOX, 160, 270, 200, 10, 0, 0, 0.7f, 0);
        int c = addBody(&S, BOX, 160, 249, 12, 5, 0, 1, 0.7f, 0);
        for (int t = 0; t < 120; t++) step(&S, 1 / 30.f, 0, 400, 12);
        CHECK(!S.bodies[c].awake);
        CHECK(impulse(&S, c, 30, 0));
        CHECK(S.bodies[c].awake && S.bodies[c].vx > 0);
    }

    // (f) bordas do anti-tunel: dt EXATAMENTE kMaxSubDt (base = 1.0 ->
    // ceilf(1 - eps) = 1 sub-passo), o dobro (2), e o teto do maxSub
    {
        static World W;
        worldInit(&W, 10);
        addBody(&W, BOX, 160, 270, 200, 10, 0, 0, 0.7f, 0);
        addBody(&W, CIRCLE, 160, 200, 5, 5, 0, 1, 0.6f, 0.2f);
        CHECK(step(&W, kMaxSubDt, 0, 400, 12) == 1);
        CHECK(step(&W, 2 * kMaxSubDt + 1e-6f, 0, 400, 12) == 2);
        CHECK(step(&W, 0.1f, 0, 400, 12) == 12);    // 0.1/(1/120) = 12
        // velocidade absurda + maxSub generoso: pede mais que 16, o teto
        // segura (o clamp dos 64 antes do cast tambem passa por aqui)
        setBody(&W, 1, 160, 200, 0, 0, 3000, 0);
        int s = step(&W, 0.1f, 0, 400, 100);
        CHECK(s == kMaxSub);
    }
}

// Verlet nativo (API 31): Utils/Verlet2D.h — o mesmo codigo do
// System.verlet* (JsPhysics.cpp). O corte do vinculo (delStick) devolve a
// colisao ao par: a bitmask de vinculados e' recompute (relinkAll); o
// swap-remove antigo nao limpava a marca e o pedaco cortado parava de
// colidir para sempre
static void testVerlet2D() {
    using namespace celer::verlet;
    // layout do malloc do binding: VWorld + bitmask linked no mesmo buffer
    static uint8_t mem[sizeof(VWorld) + kLinkBytes];
    memset(mem, 0, sizeof(mem));
    VWorld* w = (VWorld*)mem;
    w->iterations = 4;
    w->radius = 5;
    w->linked = mem + sizeof(VWorld);
    auto addPt = [&](float x, float y) {
        VerletPoint& p = w->pts[w->nPts];
        p.x = p.px = x; p.y = p.py = y; p.pin = false;
        return w->nPts++;
    };
    int p0 = addPt(100, 100), p1 = addPt(103, 100);   // dist 3 < 2r = 10
    int p2 = addPt(200, 100), p3 = addPt(203, 100);   // par de controle

    // sem vinculo: o par se separa ate 2r (gravidade 0, pontos em repouso)
    stepWorld(w, 1 / 30.f, 0, 0, 1, 0, 0, 0, 0, 0.5f);
    float d01 = fabsf(w->pts[p1].x - w->pts[p0].x);
    CHECK(d01 > 9 && d01 < 11);

    // volta a sobrepor e liga os DOIS pares: vinculo suprime a colisao
    w->pts[p0].x = w->pts[p0].px = 100; w->pts[p1].x = w->pts[p1].px = 103;
    w->pts[p2].x = w->pts[p2].px = 200; w->pts[p3].x = w->pts[p3].px = 203;
    w->sticks[w->nSticks++] = VerletStick{(int16_t)p0, (int16_t)p1, 3.0f};
    w->sticks[w->nSticks++] = VerletStick{(int16_t)p2, (int16_t)p3, 3.0f};
    linkSet(w, p0, p1); linkSet(w, p1, p0);
    linkSet(w, p2, p3); linkSet(w, p3, p2);
    stepWorld(w, 1 / 30.f, 0, 0, 1, 0, 0, 0, 0, 0.5f);
    CHECK(fabsf(w->pts[p1].x - w->pts[p0].x) < 3.5f);   // colisao suprimida
    CHECK(fabsf(w->pts[p3].x - w->pts[p2].x) < 3.5f);
    CHECK(linked(w, p0, p1) && linked(w, p1, p0));

    // corta o vinculo 0 (o swap-remove traz o ultimo p/ o lugar): o par
    // volta a colidir, o vinculo que sobrou segue segurando o seu par
    CHECK(delStick(w, 0));
    CHECK(!linked(w, p0, p1) && !linked(w, p1, p0));    // bitmask limpa
    CHECK(linked(w, p2, p3) && linked(w, p3, p2));      // a outra marca fica
    stepWorld(w, 1 / 30.f, 0, 0, 1, 0, 0, 0, 0, 0.5f);
    d01 = fabsf(w->pts[p1].x - w->pts[p0].x);
    CHECK(d01 > 9 && d01 < 11);                         // colisao voltou
    CHECK(fabsf(w->pts[p3].x - w->pts[p2].x) < 3.5f);   // o par ligado nao
    CHECK(!delStick(w, -1) && !delStick(w, 1));         // indice invalido

    // guardas de parametro (round 3b): dt NaN/infinito/<= 0 nao roda o
    // passo (o mundo fica intocado em vez de px/py virarem NaN); gravidade
    // e damp estranhos caem no default; bounds com NaN desligam sozinhos
    float sx = w->pts[p0].x, sy = w->pts[p0].y;
    CHECK(!stepWorld(w, NAN, 0, 900, 1, 0, 0, 0, 0, 0.5f));
    CHECK(!stepWorld(w, 0.0f, 0, 900, 1, 0, 0, 0, 0, 0.5f));
    CHECK(!stepWorld(w, -1.0f / 30.0f, 0, 900, 1, 0, 0, 0, 0, 0.5f));
    CHECK(w->pts[p0].x == sx && w->pts[p0].y == sy);    // nada mexeu
    CHECK(stepWorld(w, 1.0f / 30.0f, NAN, 900, -5.0f, 0, 0, 240, 320, NAN));
    CHECK(w->pts[p1].y > sy + 0.1f);                    // caiu (gravidade e
                                                        // damp consertados)
}

// Recursos da matilha (API 36): codec do controle e leases do servidor.
static void testResProto() {
    using namespace resproto;
    uint8_t b[ENV_PAYLOAD];
    // LIST round-trip
    Entry e[2];
    e[0].type = TYPE_MIC;
    e[0].flags = FLAG_BUSY;
    snprintf(e[0].name, sizeof(e[0].name), "mic");
    e[1].type = TYPE_DATA;
    e[1].flags = FLAG_SHARED | FLAG_READY;
    snprintf(e[1].name, sizeof(e[1].name), "temperatura");
    size_t n = encodeList(e, 2, b, sizeof(b));
    CHECK(n == 2 + (3 + 3) + (3 + 11));
    CHECK(b[0] == OP_LIST);
    Entry got[4];
    CHECK(decodeList(b + 1, n - 1, got, 4) == 2);
    CHECK(got[0].type == TYPE_MIC && got[0].flags == FLAG_BUSY && strcmp(got[0].name, "mic") == 0);
    CHECK(strcmp(got[1].name, "temperatura") == 0 && got[1].flags == (FLAG_SHARED | FLAG_READY));
    CHECK(decodeList(b + 1, n - 2, got, 4) == -1);  // truncado
    CHECK(decodeList(b + 1, n - 1, got, 1) == 1);   // max respeitado
    // nome longo demais nao entra
    Entry big[LIST_MAX + 1];
    CHECK(encodeList(big, LIST_MAX + 1, b, sizeof(b)) == 0);
    // OPEN por nome
    const uint8_t params[] = {'{', '}'};
    Link lk;
    lk.flags = LINK_UP | LINK_LOCKED;
    lk.chan = 6;
    for (int i = 0; i < 6; i++) lk.mac[i] = (uint8_t)(0xA0 + i);
    n = encodeOpen(0x2B, "camera", params, 2, lk, b, sizeof(b));
    CHECK(n == 1 + 1 + 1 + 6 + 1 + 2 + LINK_LEN);
    OpenReq rq;
    CHECK(decodeOpen(b + 1, n - 1, &rq));
    CHECK(rq.req == 0x2B && strcmp(rq.name, "camera") == 0 && rq.plen == 2 && rq.params[0] == '{');
    CHECK(rq.link.flags == (LINK_UP | LINK_LOCKED) && rq.link.chan == 6 && rq.link.mac[5] == 0xA5);
    CHECK(!decodeOpen(b + 1, n - 2, &rq));  // truncado
    CHECK(encodeOpen(1, "", nullptr, 0, lk, b, sizeof(b)) == 0);
    CHECK(encodeOpen(1, "nome-com-mais-de-15", nullptr, 0, lk, b, sizeof(b)) == 0);
    uint8_t bigp[PARAMS_MAX + 1] = {0};
    CHECK(encodeOpen(1, "mic", bigp, sizeof(bigp), lk, b, sizeof(b)) == 0);
    // ACCEPT / DATA
    Accept ac;
    ac.req = 7;
    ac.sid = 0xBEEF;
    ac.leaseDs = LEASE_DS_DEFAULT;
    ac.transport = TRANSPORT_ESPNOW;
    ac.chan = 11;
    ac.mac[0] = 0x24;
    ac.token = 0xDEADBEEF;
    n = encodeAccept(ac, b, sizeof(b));
    CHECK(n == 18 && b[0] == OP_ACCEPT && b[2] == 0xBE && b[3] == 0xEF);
    Accept ad;
    CHECK(decodeAccept(b + 1, n - 1, &ad));
    CHECK(ad.sid == 0xBEEF && ad.transport == TRANSPORT_ESPNOW && ad.chan == 11 && ad.mac[0] == 0x24 &&
          ad.token == 0xDEADBEEF);
    CHECK(!decodeAccept(b + 1, n - 2, &ad));
    // escolha do transporte
    Link sv, cl;
    uint8_t ch = 99;
    CHECK(chooseTransport(sv, cl, &ch) == TRANSPORT_MESH && ch == 0);  // ninguem tem ESP-NOW
    sv.flags = LINK_UP; sv.chan = 1;
    cl.flags = LINK_UP; cl.chan = 6;
    CHECK(chooseTransport(sv, cl, &ch) == TRANSPORT_ESPNOW && ch == 1);   // livres: canal do servidor
    cl.flags |= LINK_LOCKED;
    CHECK(chooseTransport(sv, cl, &ch) == TRANSPORT_ESPNOW && ch == 6);   // cliente no AP manda
    sv.flags |= LINK_LOCKED;
    CHECK(chooseTransport(sv, cl, &ch) == TRANSPORT_MESH);                // os dois presos, canais != 
    cl.chan = 1;
    CHECK(chooseTransport(sv, cl, &ch) == TRANSPORT_ESPNOW && ch == 1);   // mesmo AP
    cl.flags = 0;
    CHECK(chooseTransport(sv, cl, &ch) == TRANSPORT_MESH);                // cliente sem ESP-NOW
    n = encodeData(0x0102, 9, "oi", 2, b, sizeof(b));
    CHECK(n == 7 && b[0] == OP_DATA && b[5] == 'o');
    uint8_t huge[MAX_DATA + 1] = {0};
    CHECK(encodeData(1, 1, huge, MAX_DATA, b, sizeof(b)) == ENV_PAYLOAD);
    CHECK(encodeData(1, 1, huge, MAX_DATA + 1, b, sizeof(b)) == 0);
    CHECK(encodeData(1, 1, "x", 1, b, 4) == 0);  // buffer pequeno
    // leases
    LeaseTable<2> lt;
    lt.seed(100);
    auto* a = lt.open(0xA1, 0, 1000, 10000);
    CHECK(a != nullptr && a->sid == 101);
    auto* a2 = lt.open(0xA1, 0, 2000, 10000);  // OPEN repetido: mesmo slot
    CHECK(a2 == a && a2->sid == 101 && lt.countRid(0) == 1);
    auto* c = lt.open(0xC3, 0, 2000, 10000);
    CHECK(c != nullptr && c->sid == 102 && lt.countRid(0) == 2);
    CHECK(lt.open(0xD4, 1, 2000, 10000) == nullptr);  // cheia
    CHECK(!lt.keep(0xC3, 101, 3000));  // sid de outro cliente nao renova
    CHECK(lt.keep(0xA1, 101, 9000));   // vence em 19000
    LeaseTable<2>::Lease dead;
    CHECK(lt.expireOne(12001, &dead) && dead.sid == 102);  // c vencia em 12000
    CHECK(!lt.expireOne(12001, &dead));
    CHECK(lt.expireOne(19001, &dead) && dead.sid == 101);
    CHECK(lt.countRid(0) == 0);
    a = lt.open(0xA1, 2, 19500, 10000);
    a->transport = TRANSPORT_ESPNOW;
    a->token = 77;
    lt.close(0xA1, a->sid);
    auto* d = lt.open(0xD4, 1, 20000, 10000);
    CHECK(d->transport == TRANSPORT_MESH && d->token == 0);  // slot reaproveitado limpo
    CHECK(d != nullptr && !lt.close(0xA1, d->sid) && lt.close(0xD4, d->sid) && lt.find(d->sid) == nullptr);
    CHECK(strcmp(typeName(TYPE_CAMERA), "camera") == 0 && strcmp(reasonName(REASON_POLICY), "denied") == 0);
    CHECK(strcmp(reasonName(REASON_EXPIRED), "expired") == 0);
    CHECK(strcmp(reasonName(REASON_NO_LINK), "noLink") == 0);
    // HELLO (presenca pelo ESP-NOW)
    n = encodeHello(0x70, "qrnode", b, sizeof(b));
    CHECK(n == 3 + 6 && b[0] == OP_HELLO);
    uint8_t hc = 0;
    char hn[RES_NAME_MAX + 1];
    CHECK(decodeHello(b + 1, n - 1, &hc, hn) && hc == 0x70 && strcmp(hn, "qrnode") == 0);
    CHECK(!decodeHello(b + 1, n - 2, &hc, hn));
}

// API 38 (recursos genericos): metadados no catalogo (LIST_META/TLV) e os
// tipos novos gpio/sensor
static void testResMeta() {
    using namespace resproto;
    uint8_t b[ENV_PAYLOAD];
    // round-trip cheio: sensor com unidade+faixa, gpio com esquema
    Entry e[2];
    Meta m[2];
    e[0].type = TYPE_SENSOR;
    e[0].flags = FLAG_SHARED | FLAG_READY;
    snprintf(e[0].name, sizeof(e[0].name), "lum");
    snprintf(m[0].unit, sizeof(m[0].unit), "%%");
    m[0].rangeMin = 0.0f;
    m[0].rangeMax = 100.0f;
    m[0].hasRange = true;
    m[0].ver = 1;
    e[1].type = TYPE_GPIO;
    snprintf(e[1].name, sizeof(e[1].name), "rele1");
    snprintf(m[1].schema, sizeof(m[1].schema), "{\"off\":0|1}");
    m[1].ver = 1;
    const size_t n = encodeListMeta(e, m, 2, b, sizeof(b));
    CHECK(n == 2 + (3 + 3 + 1 + (2 + 1) + (2 + 8) + (2 + 1)) + (3 + 5 + 1 + (2 + 11) + (2 + 1)));
    CHECK(b[0] == OP_LIST_META);
    Entry got[4];
    Meta gm[4];
    CHECK(decodeListMeta(b + 1, n - 1, got, gm, 4) == 2);
    CHECK(got[0].type == TYPE_SENSOR && strcmp(got[0].name, "lum") == 0);
    CHECK(strcmp(gm[0].unit, "%") == 0 && gm[0].hasRange && gm[0].rangeMin == 0.0f &&
          gm[0].rangeMax == 100.0f && gm[0].ver == 1);
    CHECK(got[1].type == TYPE_GPIO && strcmp(got[1].name, "rele1") == 0);
    CHECK(gm[1].unit[0] == '\0' && !gm[1].hasRange && strcmp(gm[1].schema, "{\"off\":0|1}") == 0 &&
          gm[1].ver == 1);
    CHECK(decodeListMeta(b + 1, n - 2, got, gm, 4) == -1);   // truncado
    CHECK(decodeListMeta(b + 1, n - 1, got, gm, 1) == 1);    // max respeitado
    CHECK(decodeListMeta(b + 1, n - 1, got, nullptr, 4) == 2);  // sem Meta (so Entries)
    // servidor sem metas: encodeListMeta(nullptr) e o mesmo fio, meta vazio
    const size_t n0 = encodeListMeta(e, nullptr, 2, b, sizeof(b));
    CHECK(n0 > 0 && decodeListMeta(b + 1, n0 - 1, got, gm, 4) == 2 && !gm[0].hasRange);
    // TLV de tag desconhecido e pulado (o futuro nao quebra o presente):
    // 1 entrada "x" com TAG_UNIT e um 0x7F de 2 bytes desconhecido
    const uint8_t hand[] = {1,  TYPE_SENSOR, 0, 1, 'x',
                            7,  TAG_UNIT,   1, 'C', 0x7F, 2, 0xAB, 0xCD};
    CHECK(decodeListMeta(hand, sizeof(hand), got, gm, 4) == 1);
    CHECK(strcmp(got[0].name, "x") == 0 && strcmp(gm[0].unit, "C") == 0 && !gm[0].hasRange);
    // TLV com len maior que o resto da entrada: malformado
    const uint8_t bad[] = {1, (uint8_t)TYPE_GPIO, 0, 1, 'g', 1, TAG_VER, 4};
    CHECK(decodeListMeta(bad, sizeof(bad), got, gm, 4) == -1);
    // DESCRIBE_META e os nomes dos tipos novos
    CHECK(encodeDescribeMeta(b, sizeof(b)) == 1 && b[0] == OP_DESCRIBE_META);
    CHECK(strcmp(typeName(TYPE_GPIO), "gpio") == 0 && strcmp(typeName(TYPE_SENSOR), "sensor") == 0);
    // catalogo inteiro com esquema nao cabe no envelope: 0 = cai para o LIST
    Entry many[LIST_MAX];
    Meta mm[LIST_MAX];
    for (int i = 0; i < LIST_MAX; i++) mm[i] = Meta{};
    for (int i = 0; i < LIST_MAX; i++) {
        many[i].type = TYPE_DATA;
        many[i].flags = FLAG_READY;
        snprintf(many[i].name, sizeof(many[i].name), "canal%02dxxxxx", i);
        snprintf(mm[i].schema, sizeof(mm[i].schema), "{\"a\":1,\"b\":\"padding\"}");
    }
    CHECK(encodeListMeta(many, mm, LIST_MAX, b, sizeof(b)) == 0);
    uint8_t small[8];
    CHECK(encodeListMeta(e, m, 2, small, sizeof(small)) == 0);
    // paramInt (copia unica no ResProto.h): valor colado no fim do params,
    // valor ausente, params que acaba na chave e lixo depois do numero
    const uint8_t p1[] = "{\"pin\":21}";
    CHECK(paramInt(p1, sizeof(p1) - 1, "pin", -1) == 21);   // fim exato: sem NUL
    const uint8_t p2[] = "{\"q\":12,\"x\":1}";
    CHECK(paramInt(p2, sizeof(p2) - 1, "q", 0) == 12 && paramInt(p2, sizeof(p2) - 1, "pin", -5) == -5);
    const uint8_t p3[] = "a\"rate\":";
    CHECK(paramInt(p3, sizeof(p3) - 1, "rate", 7) == 7);    // chave sem valor
    const uint8_t p4[] = "{\"off\":1xxx";
    CHECK(paramInt(p4, sizeof(p4) - 1, "off", 0) == 1);     // atoi para no lixo
}

// API 47: comandos do DATA de um atuador (write/read/pulso/pwm) — o codec
// compartilhado entre o firmware (Resources/GpioRes), o celerctl e o meshsim
static void testResGpioOps() {
    using namespace resproto;
    uint8_t d[4];
    CHECK(encodeGpioWrite(true, d) == 2 && d[0] == GPIO_WRITE && d[1] == 1);
    CHECK(encodeGpioWrite(false, d) == 2 && d[1] == 0);
    CHECK(encodeGpioRead(d) == 1 && d[0] == GPIO_READ);
    // PULSO: ms u16 LE (GpioRes le com decodeGpioPulse; 0 = valor invalido)
    CHECK(encodeGpioPulse(0x1234, d) == 3 && d[0] == GPIO_PULSE && d[1] == 0x34 && d[2] == 0x12);
    uint16_t ms = 0;
    CHECK(decodeGpioPulse(d, 3, &ms) && ms == 0x1234);
    CHECK(!decodeGpioPulse(d, 2, &ms));                 // curto
    d[0] = GPIO_WRITE;
    CHECK(!decodeGpioPulse(d, 3, &ms));                 // outro op
    CHECK(encodeGpioPulse(1, d) == 3 && decodeGpioPulse(d, 3, &ms) && ms == 1);
    CHECK(encodeGpioPulse(0xFFFF, d) == 3 && decodeGpioPulse(d, 3, &ms) && ms == 0xFFFF);
    // PWM: duty limitado a 100 no encoder (o servidor recusa > 100 com RES_ERR)
    CHECK(encodeGpioPwm(50, d) == 2 && d[0] == GPIO_PWM && d[1] == 50);
    CHECK(encodeGpioPwm(100, d) == 2 && d[1] == 100);
    CHECK(encodeGpioPwm(200, d) == 2 && d[1] == 100);
    CHECK(RES_ERR == 0xFF);
}

// Reflexos (API 47): transicao com histerese + cooldown e o blob do NVS
static void testReflex() {
    using namespace reflex;
    Rule r{};
    r.used = true;
    r.op = OP_GT;
    r.value = 30.0f;
    r.hyst = 2.0f;
    r.armed = true;
    CHECK(evaluate(&r, 25.0f, 1000) == EV_NONE);  // abaixo do limiar
    CHECK(evaluate(&r, 30.0f, 2000) == EV_ON);    // cruzou
    CHECK(evaluate(&r, 31.0f, 3000) == EV_NONE);  // ja desarmado
    CHECK(evaluate(&r, 29.0f, 4000) == EV_NONE);  // 29 > 28: nao re-arma
    CHECK(evaluate(&r, 28.0f, 5000) == EV_OFF);   // histerese vencida: desfaz
    CHECK(evaluate(&r, 30.0f, 6000) == EV_ON);    // cruza de novo
    // cooldown de 1 s entre transicoes
    r.armed = true;
    r.lastMs = 0;
    CHECK(evaluate(&r, 40.0f, 10000) == EV_ON);
    CHECK(evaluate(&r, 10.0f, 10500) == EV_NONE);  // < 1 s: bloqueado
    CHECK(evaluate(&r, 10.0f, 11000) == EV_OFF);
    // OP_LT espelhado
    Rule l{};
    l.op = OP_LT;
    l.value = 20.0f;
    l.armed = true;
    CHECK(evaluate(&l, 25.0f, 1000) == EV_NONE);
    CHECK(evaluate(&l, 20.0f, 2000) == EV_ON);
    CHECK(evaluate(&l, 21.0f, 3000) == EV_OFF);
    // blob persistido: round-trip completo (write remoto)
    Rule a{};
    a.used = true;
    a.id = 3;
    a.enabled = true;
    a.op = OP_LT;
    a.value = 15.5f;
    a.hyst = 1.0f;
    a.action = ACT_WRITE;
    a.targetNode = 0xA1B2;
    a.on = true;
    snprintf(a.sensor, sizeof(a.sensor), "lum");
    snprintf(a.target, sizeof(a.target), "rele2");
    Wire w;
    ruleToWire(a, &w);
    Rule b{};
    wireToRule(w, &b);
    CHECK(b.used && b.id == 3 && b.enabled && b.op == OP_LT && b.value == 15.5f &&
          b.hyst == 1.0f && b.action == ACT_WRITE && b.targetNode == 0xA1B2 && b.on);
    CHECK(strcmp(b.sensor, "lum") == 0 && strcmp(b.target, "rele2") == 0);
    CHECK(b.armed && b.handle == -1);  // estado de runtime nasce limpo
    // notify: texto viaja, alvo fica vazio
    Rule n{};
    n.used = true;
    n.id = 9;
    n.action = ACT_NOTIFY;
    n.op = OP_GT;
    n.value = 35.0f;
    snprintf(n.text, sizeof(n.text), "escuro na sala");
    ruleToWire(n, &w);
    wireToRule(w, &b);
    CHECK(b.action == ACT_NOTIFY && strcmp(b.text, "escuro na sala") == 0 && b.target[0] == '\0');
}

// Onda B: o tunel ResProto pelo cabo (USBDevice/UsbRes.h)
static void testUsbRes() {
    using namespace usbres;
    using namespace resproto;
    uint8_t b[512];
    // envelope do CTL: req e resp
    const size_t n = encodeReq(SUB_OPEN, 0x2A, "xyz", 3, b, sizeof(b));
    CHECK(n == 7 && b[0] == SUB_OPEN && b[1] == 0x2A && b[2] == 0 && b[3] == 3 && b[4] == 'x');
    Req rq;
    CHECK(decodeReq(b, n, &rq) && rq.subop == SUB_OPEN && rq.reqId == 0x2A && rq.len == 3 &&
          rq.body[0] == 'x');
    CHECK(!decodeReq(b, 3, &rq));  // curto
    CHECK(!decodeReq(b, 6, &rq));  // len maior que o resto
    CHECK(encodeReq(SUB_KEEP, 1, "aaaa", 5, b, 8) == 0);  // nao coube
    const size_t m = encodeResp(0, 0x2A, "ok", 2, b, sizeof(b));
    CHECK(m == 6 && b[0] == 0 && b[1] == 0x2A && b[2] == 0 && b[3] == 2 && b[4] == 'o');
    // DATA: [sid u16][seq u16][bytes] (o mesmo do KL_RES_DATA)
    const size_t d = encodeDataFrame(0x1234, 7, "oi", 2, b, sizeof(b));
    CHECK(d == 6 && b[0] == 0x12 && b[1] == 0x34 && b[2] == 0 && b[3] == 7);
    DataHdr dh;
    CHECK(decodeDataFrame(b, d, &dh) && dh.sid == 0x1234 && dh.seq == 7 && dh.len == 2 &&
          dh.data[0] == 'o');
    CHECK(!decodeDataFrame(b, 3, &dh));
    // catalogo da malha: no + entrada + meta (schema e unit/range)
    MeshEntry me[2];
    me[0].node = 0x1CAE;
    snprintf(me[0].nodeName, sizeof(me[0].nodeName), "Celer-1CAE");
    me[0].e.type = TYPE_GPIO;
    snprintf(me[0].e.name, sizeof(me[0].e.name), "rele1");
    snprintf(me[0].m.schema, sizeof(me[0].m.schema), "{\"off\":0|1}");
    me[0].m.ver = 1;
    me[1].node = 0xAB3E;
    snprintf(me[1].nodeName, sizeof(me[1].nodeName), "Sensor");
    me[1].e.type = TYPE_SENSOR;
    me[1].e.flags = FLAG_SHARED | FLAG_READY;
    snprintf(me[1].e.name, sizeof(me[1].e.name), "lum");
    snprintf(me[1].m.unit, sizeof(me[1].m.unit), "%%");
    me[1].m.rangeMin = 0.0f;
    me[1].m.rangeMax = 100.0f;
    me[1].m.hasRange = true;
    const size_t g = encodeMeshList(me, 2, b, sizeof(b));
    CHECK(g > 0 && b[0] == 2);
    MeshEntry gm[4];
    CHECK(decodeMeshList(b, g, gm, 4) == 2);
    CHECK(gm[0].node == 0x1CAE && strcmp(gm[0].nodeName, "Celer-1CAE") == 0 &&
          gm[0].e.type == TYPE_GPIO && strcmp(gm[0].e.name, "rele1") == 0 &&
          strcmp(gm[0].m.schema, "{\"off\":0|1}") == 0 && gm[0].m.ver == 1);
    CHECK(gm[1].node == 0xAB3E && strcmp(gm[1].e.name, "lum") == 0 &&
          gm[1].e.flags == (FLAG_SHARED | FLAG_READY) && gm[1].m.hasRange &&
          gm[1].m.rangeMax == 100.0f && strcmp(gm[1].m.unit, "%") == 0);
    CHECK(decodeMeshList(b, g - 1, gm, 4) == -1);  // truncado
    CHECK(decodeMeshList(b, g, gm, 1) == 1);       // max respeitado
}

// ------------------------------------------------------------- shell (shl)

#include <cstdarg>

// Cenario do sh: variaveis + linhas executadas + saida do interpretador.
struct ShTVar {
    std::string name, val;
};
static std::vector<ShTVar> g_shVars;
static std::vector<std::string> g_shRan;
static std::string g_shPrinted;

static const char* shTGet(const char* n) {
    for (auto& v : g_shVars) {
        if (v.name == n) return v.val.c_str();
    }
    return nullptr;
}
static void shTSet(const std::string& n, const std::string& v) {
    for (auto& v2 : g_shVars) {
        if (v2.name == n) {
            v2.val = v;
            return;
        }
    }
    g_shVars.push_back({n, v});
}
static const char* shTLookup(void*, const char* n) { return shTGet(n); }

static void shTestPrint(void*, const char* fmt, ...) {
    char b[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(b, sizeof(b), fmt, ap);
    va_end(ap);
    g_shPrinted += b;
}

// Executor falso: expande $, trata set (com aritmetica), [ test ],
// true/false — o mesmo contrato do CelerShell::execute do device. A
// CONDICAO de if/while passa por aqui tambem (sem gravar em g_shRan).
static int shExecRaw(void*, const char* raw) {
    char exp[512];
    shl::expandVars(raw, exp, sizeof(exp), shTLookup, nullptr, 0);
    std::vector<char*> tok;
    char buf[512];
    strcpy(buf, exp);
    for (char* t = strtok(buf, " \t"); t != nullptr; t = strtok(nullptr, " \t")) tok.push_back(t);
    if (tok.empty()) return 0;
    if (strcmp(tok[0], "set") == 0 && tok.size() >= 2) {
        std::string a = tok[1];
        for (size_t i = 2; i < tok.size(); i++) a += std::string(" ") + tok[i];
        size_t eq = a.find('=');
        if (eq == std::string::npos) return 1;
        std::string val = a.substr(eq + 1);
        long r = 0;
        if (shl::arithEval(val.c_str(), &r) == shl::Arith::Ok) {
            char nb[24];
            snprintf(nb, sizeof(nb), "%ld", r);
            val = nb;
        }
        shTSet(a.substr(0, eq), val);
        return 0;
    }
    if ((strcmp(tok[0], "[") == 0 || strcmp(tok[0], "test") == 0) && tok.size() == 5) {
        const std::string a = tok[1], op = tok[2], b = tok[3];
        if (op == "=") return (a == b) ? 0 : 1;
        if (op == "!=") return (a != b) ? 0 : 1;
        const long x = atol(a.c_str()), y = atol(b.c_str());
        if (op == "-lt") return (x < y) ? 0 : 1;
        if (op == "-ge") return (x >= y) ? 0 : 1;
        return 2;
    }
    if (strcmp(tok[0], "true") == 0) return 0;
    if (strcmp(tok[0], "false") == 0) return 1;
    return 0;
}

// Linha de corpo: grava a linha crua antes de rodar
static int shTestExec(void* ctx, const char* raw) {
    g_shRan.push_back(raw);
    return shExecRaw(ctx, raw);
}

static FILE* shScriptFile(const std::string& text) {
    FILE* f = tmpfile();
    if (f == nullptr) return nullptr;
    fwrite(text.data(), 1, text.size(), f);
    rewind(f);
    return f;
}

static int shRun(const std::string& text, const shl::ScriptOpts& o = shl::ScriptOpts()) {
    FILE* f = shScriptFile(text);
    if (f == nullptr) return -99;
    const int rc = shl::runScript(f, o, shTestExec, shExecRaw, nullptr, shTestPrint, nullptr);
    fclose(f);
    return rc;
}

static void testShellResolveWild() {
    using S = std::string;
    CHECK(shl::resolvePath("/local/apps", "/sd/x.js") == S("/sd/x.js"));
    CHECK(shl::resolvePath("/local/apps", "Meu/main.js") == S("/local/apps/Meu/main.js"));
    CHECK(shl::resolvePath("/local/apps/A", "../B/x") == S("/local/apps/B/x"));
    // ".." ate sair da jail vira caminho absoluto normal: o pathAllowed do
    // CelerShell barre na sequencia — aqui e so texto
    CHECK(shl::resolvePath("/local", "../../etc/passwd") == S("/etc/passwd"));
    CHECK(shl::resolvePath("/local", "./x") == S("/local/x"));
    CHECK(shl::resolvePath("/", "//local//x") == S("/local/x"));
    CHECK(shl::resolvePath("/", "local/x") == S("/local/x"));
    CHECK(shl::resolvePath("/local/apps", "..") == S("/local"));
    CHECK(shl::resolvePath("/local/apps", ".") == S("/local/apps"));
    CHECK(shl::resolvePath("/sd", "a/b/../../c") == S("/sd/c"));

    CHECK(shl::wildMatch("main.js", "main.js"));
    CHECK(shl::wildMatch("*.js", "main.js"));
    CHECK(!shl::wildMatch("*.js", "main.json"));
    CHECK(shl::wildMatch("ma?n.js", "main.js"));
    CHECK(!shl::wildMatch("ma?n.js", "man.js"));
    CHECK(shl::wildMatch("*", "qualquer.coisa"));
    CHECK(shl::wildMatch("*", ""));
    CHECK(shl::wildMatch("a*c", "aXYZc"));
    CHECK(!shl::wildMatch("a*c", "aXY"));
    CHECK(shl::wildMatch("app*", "app.json"));
    CHECK(shl::wildMatch("", ""));
    CHECK(shl::containsCI("Erro GRAVE no boot", "grave"));
    CHECK(shl::containsCI("boot", "GRAVE") == false);
}

static void testShellTail() {
    // comeco das ultimas n linhas via FILE* real (tmpfile: sem arquivo no
    // disco do CI)
    auto ts = [](const std::string& data, long n) -> long {
        FILE* f = shScriptFile(data);
        if (f == nullptr) return -99;
        long r = shl::tailStart(f, n);
        char buf[512] = {0};
        if (r >= 0) fread(buf, 1, sizeof(buf) - 1, f);
        fclose(f);
        // devolve o offset so se o resto bater (offset + conteudo)
        std::string got = (r >= 0) ? std::string(buf) : std::string("ERR");
        return (got == data.substr((size_t)(r < 0 ? 0 : r))) ? r : -1000;
    };
    CHECK(ts("a\nb\nc\n", 2) == 2);        // "b\nc\n"
    CHECK(ts("a\nb\nc", 2) == 2);          // sem \n final
    CHECK(ts("a\nb\nc\n", 5) == 0);        // pede mais do que ha
    CHECK(ts("a\nb\nc\n", 1) == 4);        // so "c\n"
    CHECK(ts("a\nb\nc", 1) == 4);          // so "c"
    CHECK(ts("", 3) == 0);
    CHECK(ts("solinha\n", 1) == 0);
    CHECK(ts("solinha", 1) == 0);
    CHECK(ts("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", 3) == 14);  // "8\n9\n10\n"
}

static void testShellVarsArith() {
    g_shVars = {{"MSG", "oi"}, {"I", "5"}};
    char out[128];
    shl::expandVars("echo $MSG", out, sizeof(out), shTLookup, nullptr, 0);
    CHECK(std::string(out) == "echo oi");
    shl::expandVars("a${MSG}b", out, sizeof(out), shTLookup, nullptr, 0);
    CHECK(std::string(out) == "aoib");
    shl::expandVars("custa $5", out, sizeof(out), shTLookup, nullptr, 0);
    CHECK(std::string(out) == "custa $5");
    shl::expandVars("rc=$?", out, sizeof(out), shTLookup, nullptr, 7);
    CHECK(std::string(out) == "rc=7");
    shl::expandVars("vazia=[${NAO_EXISTE}]", out, sizeof(out), shTLookup, nullptr, 0);
    CHECK(std::string(out) == "vazia=[]");
    shl::expandVars("trio $MSG $I $MSG", out, sizeof(out), shTLookup, nullptr, 0);
    CHECK(std::string(out) == "trio oi 5 oi");
    shl::expandVars("${SEM_FECHANTE", out, sizeof(out), shTLookup, nullptr, 0);
    CHECK(std::string(out) == "${SEM_FECHANTE");
    shl::expandVars("$$ I$", out, sizeof(out), shTLookup, nullptr, 0);
    CHECK(std::string(out) == "$$ I$");

    long r = 0;
    CHECK(shl::arithEval("5 + 1", &r) == shl::Arith::Ok && r == 6);
    CHECK(shl::arithEval("4+1", &r) == shl::Arith::Ok && r == 5);
    CHECK(shl::arithEval("-5 - 3", &r) == shl::Arith::Ok && r == -8);
    CHECK(shl::arithEval("6 * 7", &r) == shl::Arith::Ok && r == 42);
    CHECK(shl::arithEval("7 % 3", &r) == shl::Arith::Ok && r == 1);
    CHECK(shl::arithEval("5 + 1 ", &r) == shl::Arith::Ok && r == 6);  // espaco final ok
    // data e texto NAO viram conta; lixo no fim tambem nao
    CHECK(shl::arithEval("2026-10-10", &r) == shl::Arith::None);
    CHECK(shl::arithEval("oi tudo", &r) == shl::Arith::None);
    CHECK(shl::arithEval("42", &r) == shl::Arith::None);
    CHECK(shl::arithEval("5 + 1 x", &r) == shl::Arith::None);
    CHECK(shl::arithEval("5 / 0", &r) == shl::Arith::DivZero);
}

static void testShScript() {
    // if/else: dois caminhos
    g_shVars.clear();
    g_shRan.clear();
    g_shPrinted.clear();
    CHECK(shRun("if [ a = a ]\necho sim\nelse\necho nao\nend\n"
                "if [ a = b ]\necho sim\nelse\necho nao\nend\n") == 0);
    CHECK(g_shRan.size() == 2 && g_shRan[0] == "echo sim" && g_shRan[1] == "echo nao");

    // bloco morto: if interno NAO avalia condicao, nada roda
    g_shRan.clear();
    g_shPrinted.clear();
    CHECK(shRun("if false\nif true\necho x\nend\necho y\nend\necho z\n") == 0);
    CHECK(g_shRan.size() == 1 && g_shRan[0] == "echo z");

    // while com contador via aritmetica do set (3 voltas, I termina em 3)
    g_shVars = {{"I", "0"}};
    g_shRan.clear();
    g_shPrinted.clear();
    CHECK(shRun("set I=0\nwhile [ $I -lt 3 ]\necho volta $I\nset I=$I + 1\nend\necho fim\n") == 0);
    CHECK(g_shRan.size() == 8 && g_shRan[7] == "echo fim");
    CHECK(shTGet("I") != nullptr && std::string(shTGet("I")) == "3");

    // break saindo do while por condicao do if interno
    g_shVars = {{"I", "0"}};
    g_shRan.clear();
    g_shPrinted.clear();
    CHECK(shRun("while true\nset I=$I + 1\nif [ $I -ge 2 ]\nbreak\nend\necho antes\nend\n"
                "echo depois $I\n") == 0);
    CHECK(g_shRan.size() == 4 && g_shRan[3] == "echo depois $I");
    CHECK(shTGet("I") != nullptr && std::string(shTGet("I")) == "2");

    // continue pula o resto do corpo enquanto I < 3
    g_shVars = {{"I", "0"}};
    g_shRan.clear();
    g_shPrinted.clear();
    CHECK(shRun("while [ $I -lt 4 ]\nset I=$I + 1\nif [ $I -lt 3 ]\ncontinue\nend\n"
                "echo grande $I\nend\n") == 0);
    int ecos = 0;
    for (auto& x : g_shRan) {
        if (x.rfind("echo grande", 0) == 0) ecos++;
    }
    CHECK(g_shRan.size() == 6 && ecos == 2);
    CHECK(shTGet("I") != nullptr && std::string(shTGet("I")) == "4");

    // erros estruturais: mensagem certa e rc 1
    g_shRan.clear();
    g_shPrinted.clear();
    CHECK(shRun("echo x\nend\n") == 1 && g_shPrinted.find("end sem bloco") != std::string::npos);
    g_shPrinted.clear();
    CHECK(shRun("if true\necho x\n") == 1 && g_shPrinted.find("bloco(s) aberto") != std::string::npos);
    g_shPrinted.clear();
    CHECK(shRun("else\necho x\n") == 1 && g_shPrinted.find("else sem if") != std::string::npos);
    g_shPrinted.clear();
    CHECK(shRun("break\n") == 1 && g_shPrinted.find("break fora de while") != std::string::npos);

    // "echo if" nao abre bloco
    g_shRan.clear();
    g_shPrinted.clear();
    CHECK(shRun("echo if\necho while de verdade\n") == 0 && g_shRan.size() == 2);

    // -e: para no primeiro erro com a linha; -x ecoa o trace
    g_shVars.clear();
    g_shRan.clear();
    g_shPrinted.clear();
    shl::ScriptOpts e;
    e.stopErr = true;
    CHECK(shRun("echo a\nfalse\necho c\n", e) == 1);
    CHECK(g_shRan.size() == 2 && g_shPrinted.find("parou na linha 2") != std::string::npos);
    g_shRan.clear();
    g_shPrinted.clear();
    shl::ScriptOpts x;
    x.trace = true;
    CHECK(shRun("echo a\n", x) == 0 && g_shPrinted.find("+ echo a") != std::string::npos);

    // comentario/comentario indentado/CRLF: so as 2 linhas de comando rodam
    g_shRan.clear();
    g_shPrinted.clear();
    CHECK(shRun("# comentario\r\n\r\necho oi\r\n   # indentado\nls /local\n") == 0);
    CHECK(g_shRan.size() == 2 && g_shRan[0] == "echo oi" && g_shRan[1] == "ls /local");
}

static void testHelloHunt() {
    using namespace resproto;
    uint8_t b[32];
    // sem flags: o fio de sempre (nos velhos leem igual)
    size_t n = encodeHello(0x24, "Celer-1CAE", b, sizeof(b));
    CHECK(n == 1 + 2 + 10 && b[0] == OP_HELLO);
    uint8_t caps = 0, fl = 9;
    char nm[RES_NAME_MAX + 1];
    CHECK(decodeHello(b + 1, n - 1, &caps, nm, &fl) && caps == 0x24 && strcmp(nm, "Celer-1CAE") == 0 && fl == 0);
    // com HELLO_HUNT: 1 byte a mais no fim; o decoder velho (sem flags) segue lendo
    n = encodeHello(0x40, "qrnode", b, sizeof(b), HELLO_HUNT);
    CHECK(n == 1 + 2 + 6 + 1 && b[n - 1] == HELLO_HUNT);
    CHECK(decodeHello(b + 1, n - 1, &caps, nm) && caps == 0x40 && strcmp(nm, "qrnode") == 0);
    CHECK(decodeHello(b + 1, n - 1, &caps, nm, &fl) && fl == HELLO_HUNT);
    LeaseTable<4> lt;
    CHECK(lt.count() == 0);
    lt.open(1, 0, 0, 1000);
    lt.open(2, 1, 0, 1000);
    CHECK(lt.count() == 2);
}

static void testUsbMedia() {
    using namespace usbres;
    uint8_t b[4];
    CHECK(encodeMediaAt(0x5C26, 12, b, sizeof(b)) == 3 && b[0] == 0x5C && b[1] == 0x26 && b[2] == 12);
    uint16_t node = 0;
    uint8_t arg = 0;
    CHECK(decodeMediaAt(b, 3, true, &node, &arg) && node == 0x5C26 && arg == 12);
    CHECK(!decodeMediaAt(b, 2, true, &node, &arg));   // faltou o argumento
    CHECK(encodeMediaAt(0xAB3E, -1, b, sizeof(b)) == 2);
    CHECK(decodeMediaAt(b, 2, false, &node, &arg) && node == 0xAB3E);
    CHECK(!decodeMediaAt(b, 3, false, &node, &arg));  // play nao leva argumento
    CHECK(encodeMediaAt(0xFFFF, -1, b, sizeof(b)) == 2 && !decodeMediaAt(b, 2, false, &node, &arg));
    CHECK(SUB_SNAP_AT == 18 && SUB_REC_AT == 19 && SUB_PLAY_AT == 20);
    CHECK(PC_PLAY_MAX == 960000u);
}

static void testUsbJoin() {
    using namespace usbres;
    uint8_t b[96];
    const size_t n = encodeJoin("bancada", "senha-forte-1", b, sizeof(b));
    CHECK(n == 2 + 7 + 13 && b[0] == 7 && b[8] == 13);
    char nm[JOIN_NAME_MAX + 1], pw[JOIN_PASS_MAX + 1];
    CHECK(decodeJoin(b, n, nm, pw) && strcmp(nm, "bancada") == 0 && strcmp(pw, "senha-forte-1") == 0);
    CHECK(!decodeJoin(b, n - 1, nm, pw));        // senha truncada
    CHECK(!decodeJoin(b, 0, nm, pw));
    CHECK(encodeJoin("", "12345678", b, sizeof(b)) == 0);
    CHECK(encodeJoin("x123456789012345", "12345678", b, sizeof(b)) == 0);  // 16 > 15
    CHECK(encodeJoin("ab", "curta", b, sizeof(b)) == 0);
    CHECK(encodeJoin("ab", "12345678", b, 5) == 0);                        // nao coube
    uint8_t bad[96];
    memcpy(bad, b, n);
    const size_t m = encodeJoin("ab", "12345678", bad, sizeof(bad));
    bad[4] = 0;                                  // NUL no meio da senha
    CHECK(!decodeJoin(bad, m, nm, pw));
    CHECK(SUB_JOIN == 8 && SUB_LEAVE == 9 && SUB_NET == 10);
}

// No virtual (API 41): eventos do KL_RES_DATA sid 0, OPEN_AT e o BEAT proxy
static void testUsbVirtualNode() {
    using namespace usbres;
    uint8_t b[600];
    size_t n = encodeEvMsg(0xBB02, "W", false, "oi pc", 5, b, sizeof(b));
    CHECK(n == 1 + 2 + 1 + 1 + 1 + 5 && b[0] == EV_MSG && b[1] == 0xBB && b[2] == 0x02 && b[3] == 1 &&
          b[4] == 'W' && b[5] == 0 && memcmp(b + 6, "oi pc", 5) == 0);
    n = encodeEvMsg(0xBB02, "", true, "x", 1, b, sizeof(b));
    CHECK(n == 6 && b[3] == 0 && b[4] == 1 && b[5] == 'x');
    CHECK(encodeEvMsg(1, "W", false, "abc", 3, b, 5) == 0);
    n = encodeEvState(3, 2, 0, 0x1CAE, b, sizeof(b));
    CHECK(n == 6 && b[0] == EV_STATE && b[1] == 3 && b[2] == 2 && b[4] == 0x1C && b[5] == 0xAE);
    CHECK(encodeEvState(3, 2, 0, 1, b, 5) == 0);
    n = encodeEvData(1, "\x02\x01", 2, b, sizeof(b));
    CHECK(n == 4 && b[0] == EV_DATA && b[1] == 1 && b[2] == 2 && b[3] == 1);
    // o evento viaja como DATA de sid 0 (nunca e uma sessao)
    uint8_t f[64];
    const size_t fl = encodeDataFrame(EVENT_SID, 9, b, n, f, sizeof(f));
    DataHdr dh;
    CHECK(decodeDataFrame(f, fl, &dh) && dh.sid == 0 && dh.seq == 9 && dh.data[0] == EV_DATA);
    // OPEN_AT
    n = encodeOpenAt(0x1CAE, "rele1", "{\"off\":1}", 9, b, sizeof(b));
    CHECK(n == 4 + 5 + 9 && b[0] == 0x1C && b[1] == 0xAE && b[2] == 5 && b[8] == 9);
    OpenAt oa;
    CHECK(decodeOpenAt(b, n, &oa) && oa.node == 0x1CAE && strcmp(oa.name, "rele1") == 0 &&
          oa.plen == 9 && oa.params[0] == '{');
    CHECK(!decodeOpenAt(b, n - 1, &oa));
    CHECK(encodeOpenAt(0x1CAE, "", nullptr, 0, b, sizeof(b)) == 0);
    CHECK(encodeOpenAt(0x1CAE, "x", "0123456789012345678901234567890123456789012345678", 49, b,
                       sizeof(b)) == 0);  // params > 48
    n = encodeOpenAt(0xFFFF, "rele1", nullptr, 0, b, sizeof(b));
    CHECK(n > 0 && !decodeOpenAt(b, n, &oa));  // broadcast nao e dono
    CHECK(SUB_SEND == 11 && SUB_OPEN_AT == 12 && SUB_HWRITE == 13 && SUB_HCLOSE == 14);
    // BEAT proxy: src = id do PC, flag BFLAG_PROXY, decifra como qualquer BEAT
    using namespace netframe;
    fakenet::Key k{0x5A};
    Cipher c = fakenet::cipher(&k, 0x11);
    const uint16_t pc = packid::pcNodeOf(0x1CAE);
    uint8_t beat[DATA_MAX] = {CAPS_HUB, BFLAG_PROXY, 'p', 'c', '-', '1', 'C', 'A', 'E'};
    Frame fr;
    fr.type = TYPE_BEAT;
    fr.src = pc;
    fr.dst = DST_BROADCAST;
    fr.seq = 77;
    fr.ttl = 4;
    fr.hops = 0;
    fr.dlen = 9;
    fr.data = beat;
    uint8_t air[ADV_MAX];
    const size_t al = encode(fr, c, air, sizeof(air));
    Frame g;
    uint8_t plain[DATA_MAX];
    int net = -1;
    CHECK(al > 0 && decode(air, al, &c, 1, &g, plain, &net) && g.src == 0xFFAE && g.type == TYPE_BEAT &&
          g.data[1] == BFLAG_PROXY && g.data[0] == CAPS_HUB && memcmp(g.data + 2, "pc-1CAE", 7) == 0);
    CHECK((BFLAG_PROXY & (BFLAG_UNPROV | BFLAG_ADMIN)) == 0);
}

static void testPackId() {
    using namespace packid;
    const uint8_t mac[6] = {0x24, 0x0A, 0xC4, 0x12, 0x1C, 0xAE};
    CHECK(nodeFromMac(mac) == 0x1CAE);
    // elo bond do CelerLink -> no da malha (MAC publica, MSB primeiro)
    CHECK(nodeFromLinkId("24:0A:C4:12:1C:AE") == 0x1CAE);
    CHECK(nodeFromLinkId("24:0a:c4:12:1c:ae") == 0x1CAE);
    CHECK(nodeFromLinkId("") == 0);
    CHECK(nodeFromLinkId(nullptr) == 0);
    CHECK(nodeFromLinkId("24:0A:C4:12:1C") == 0);
    CHECK(nodeFromLinkId("24:0A:C4:12:1C:AE:") == 0);
    CHECK(nodeFromLinkId("24:0A:C4:12:1C:AG") == 0);
    // PC no gateway: faixa virtual, nunca o broadcast
    CHECK(pcNodeOf(0x1CAE) == 0xFFAE);
    CHECK(pcNodeOf(0x12FF) == 0xFFFE);
    CHECK(pcNodeOf(0x0000) == 0xFF00);
    CHECK(isVirtual(0xFFAE) && isVirtual(0xFF00) && !isVirtual(0xFFFF) && !isVirtual(0x1CAE));
    char b[16];
    defaultName(0x1CAE, b, sizeof(b));
    CHECK(strcmp(b, "Celer-1CAE") == 0 && strlen(b) <= NAME_LEN);
    pcName(0x1CAE, b, sizeof(b));
    CHECK(strcmp(b, "pc-1CAE") == 0);
}

static void testProvProto() {
    using namespace provproto;
    Invite iv;
    memset(&iv, 0, sizeof(iv));
    snprintf(iv.name, sizeof(iv.name), "bancada");
    for (int i = 0; i < 16; i++) {
        iv.netKey[i] = (uint8_t)i;
        iv.adminKey[i] = (uint8_t)(0xA0 + i);
    }
    uint8_t b[INVITE_MAX + 4];
    const size_t n = encodeInvite(iv, b, sizeof(b));
    CHECK(n == HDR + 1 + 7 + 32 && b[0] == 'C' && b[1] == 'N' && b[2] == 'J' && b[3] == VERSION &&
          b[4] == OP_INVITE && b[5] == 7);
    CHECK(n <= 209);  // cabe no selo do CelerLink (MAX_SEALED)
    CHECK(isProv(b, n));
    Invite out;
    CHECK(decodeInvite(b, n, &out) && strcmp(out.name, "bancada") == 0 &&
          memcmp(out.netKey, iv.netKey, 16) == 0 && memcmp(out.adminKey, iv.adminKey, 16) == 0);
    CHECK(!decodeInvite(b, n - 1, &out));  // truncado
    uint8_t bad[sizeof(b)];
    memcpy(bad, b, n);
    bad[3] = 2;
    CHECK(!isProv(bad, n) && !decodeInvite(bad, n, &out));  // versao errada
    memcpy(bad, b, n);
    bad[5] = 0;
    CHECK(!decodeInvite(bad, n, &out));  // nome vazio
    memcpy(bad, b, n);
    bad[7] = 0;
    CHECK(!decodeInvite(bad, n, &out));  // NUL no meio do nome
    CHECK(encodeInvite(iv, b, n - 1) == 0);  // nao coube
    Invite longo;
    memset(&longo, 0, sizeof(longo));
    memset(longo.name, 'x', sizeof(longo.name));  // 16 sem NUL: > 15
    CHECK(encodeInvite(longo, b, sizeof(b)) == 0);
    // ACK
    uint8_t a[ACK_LEN];
    CHECK(encodeAck(ACK_OK, a, sizeof(a)) == ACK_LEN);
    uint8_t st = 9;
    CHECK(decodeAck(a, ACK_LEN, &st) && st == ACK_OK);
    CHECK(!decodeInvite(a, ACK_LEN, &out));
    CHECK(!decodeAck(b, n, &st));
    CHECK(!isProv((const uint8_t*)"hello", 5));  // selado comum do app passa direto
}

// ------------------------------------------------------------------- AppZip
// Leitor de zip do pacote de app: Utils/AppZip.cpp (POSIX + tinfl do miniz
// vendored; as implementacoes entram na TU do AppZip via CELER_HOST_TEST).
#include "../../main/Utils/AppZip.h"
#include "../../components/LovyanGFX/src/lgfx/utility/lgfx_miniz.h"  // tdefl p/ gerar entrada deflada
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

static void zPush16(std::vector<uint8_t>& v, uint16_t x) {
    v.push_back((uint8_t)(x & 0xFF));
    v.push_back((uint8_t)(x >> 8));
}
static void zPush32(std::vector<uint8_t>& v, uint32_t x) {
    for (int i = 0; i < 4; i++) v.push_back((uint8_t)((x >> (8 * i)) & 0xFF));
}

struct ZipTEntry {
    const char* name;
    const uint8_t* data;
    uint32_t len;
    bool deflate;
    bool isDir;
};

// Escritor minimalista de zip (só para o teste; o device nunca escreve zip):
// cabecalhos locais com tamanhos no proprio header (sem data descriptor) +
// central directory + EOCD sem comentario.
static bool buildZip(const char* path, const ZipTEntry* es, int n) {
    std::vector<uint8_t> z, cd;
    for (int i = 0; i < n; i++) {
        const ZipTEntry& e = es[i];
        uint32_t off = (uint32_t)z.size();
        std::vector<uint8_t> payload;
        uint16_t method = 0;
        if (e.deflate) {
            method = 8;
            payload.resize(e.len + 64);
            size_t got = tdefl_compress_mem_to_mem(payload.data(), payload.size(), e.data, e.len, 128);
            if (got == 0) return false;
            payload.resize(got);
        } else {
            payload.assign(e.data, e.data + e.len);
        }
        uint32_t crc = e.isDir ? 0 : hostframe::crc32(e.data, e.len);  // CRC do NAO comprimido
        uint16_t nameLen = (uint16_t)strlen(e.name);
        zPush32(z, 0x04034b50);
        zPush16(z, 20); zPush16(z, 0); zPush16(z, method);
        zPush16(z, 0); zPush16(z, 0x21);
        zPush32(z, crc);
        zPush32(z, (uint32_t)payload.size());
        zPush32(z, e.isDir ? 0 : e.len);
        zPush16(z, nameLen); zPush16(z, 0);
        z.insert(z.end(), e.name, e.name + nameLen);
        z.insert(z.end(), payload.begin(), payload.end());

        zPush32(cd, 0x02014b50);
        zPush16(cd, 20); zPush16(cd, 20); zPush16(cd, 0); zPush16(cd, method);
        zPush16(cd, 0); zPush16(cd, 0x21);
        zPush32(cd, crc);
        zPush32(cd, (uint32_t)payload.size());
        zPush32(cd, e.isDir ? 0 : e.len);
        zPush16(cd, nameLen);
        zPush16(cd, 0); zPush16(cd, 0); zPush16(cd, 0); zPush16(cd, 0);
        zPush32(cd, e.isDir ? 0x10 : 0);
        zPush32(cd, off);
        cd.insert(cd.end(), e.name, e.name + nameLen);
    }
    uint32_t cdOff = (uint32_t)z.size();
    z.insert(z.end(), cd.begin(), cd.end());
    zPush32(z, 0x06054b50);
    zPush16(z, 0); zPush16(z, 0);
    zPush16(z, (uint16_t)n); zPush16(z, (uint16_t)n);
    zPush32(z, (uint32_t)cd.size());
    zPush32(z, cdOff);
    zPush16(z, 0);
    FILE* f = fopen(path, "wb");
    if (f == nullptr) return false;
    fwrite(z.data(), 1, z.size(), f);
    fclose(f);
    return true;
}

static void testAppZip() {
    using namespace celer::appzip;
    bool isDir = false;
    CHECK(nameSafe("Pkg/main.js", &isDir) && !isDir);
    CHECK(nameSafe("Pkg/data/", &isDir) && isDir);
    CHECK(nameSafe("main.js", nullptr));
    CHECK(!nameSafe("", nullptr));
    CHECK(!nameSafe("/abs.js", nullptr));
    CHECK(!nameSafe("../x", nullptr));
    CHECK(!nameSafe("a/../b.js", nullptr));
    CHECK(!nameSafe("a/b/../../c", nullptr));
    CHECK(nameSafe("a..b.js", nullptr));  // ".." so e traversal como segmento
    CHECK(!nameSafe("a\\b.js", nullptr));
    CHECK(!nameSafe("a//b.js", nullptr));
    std::string longo(kMaxName, 'x');
    CHECK(!nameSafe(longo.c_str(), nullptr));
    CHECK(!nameSafe("acento\xe7.txt", nullptr));  // fora do ASCII imprimivel

    mkdir("/tmp/celeros_zt", 0755);
    mkdir("/tmp/celeros_zt/out", 0755);
    static const uint8_t JS[] = "System.println('oi do pacote');\n";
    uint8_t pad[400];
    for (int i = 0; i < 400; i++) pad[i] = (uint8_t)('A' + (i % 26));  // repetitivo: LZ abrevia

    ZipTEntry es[] = {
        {"Pkg/", nullptr, 0, false, true},
        {"Pkg/main.js", JS, (uint32_t)(sizeof(JS) - 1), false, false},
        {"Pkg/padrao.bin", pad, sizeof(pad), true, false},
        {"Pkg/vazio.bin", (const uint8_t*)"", 0, false, false},
    };
    const char* zpath = "/tmp/celeros_zt/app.zip";
    CHECK(buildZip(zpath, es, 4));

    Reader z;
    CHECK(z.open(zpath));
    CHECK(z.count() == 4);
    Entry e;
    CHECK(z.stat(0, &e) && e.isDir && strcmp(e.name, "Pkg/") == 0);
    CHECK(z.stat(1, &e) && !e.isDir && e.method == 0 && e.uncompSize == sizeof(JS) - 1);
    CHECK(z.stat(2, &e) && e.method == 8 && e.uncompSize == sizeof(pad));
    CHECK(z.stat(3, &e) && e.uncompSize == 0 && !e.isDir);

    CHECK(z.extractTo(1, "/tmp/celeros_zt/out/main.js"));
    CHECK(z.extractTo(2, "/tmp/celeros_zt/out/padrao.bin"));
    CHECK(z.extractTo(3, "/tmp/celeros_zt/out/vazio.bin"));
    uint8_t back[512];
    FILE* f = fopen("/tmp/celeros_zt/out/main.js", "rb");
    size_t got = f ? fread(back, 1, sizeof(back), f) : 0;
    if (f) fclose(f);
    CHECK(got == sizeof(JS) - 1 && memcmp(back, JS, got) == 0);
    f = fopen("/tmp/celeros_zt/out/padrao.bin", "rb");
    got = f ? fread(back, 1, sizeof(back), f) : 0;
    if (f) fclose(f);
    CHECK(got == sizeof(pad) && memcmp(back, pad, got) == 0);  // deflate ida e volta
    f = fopen("/tmp/celeros_zt/out/vazio.bin", "rb");
    got = f ? fread(back, 1, sizeof(back), f) : 0;
    if (f) fclose(f);
    CHECK(got == 0);
    z.close();

    // CRC quebrado: extrai falha e NAO deixa o arquivo truncado para tras
    CHECK(buildZip(zpath, es, 4));
    {
        FILE* g = fopen(zpath, "r+b");
        fseek(g, 60, SEEK_SET);  // dentro do dado de main.js (local comeca em 41)
        int c = fgetc(g);
        fseek(g, 60, SEEK_SET);
        fputc(c ^ 0xFF, g);
        fclose(g);
    }
    CHECK(z.open(zpath));
    CHECK(!z.extractTo(1, "/tmp/celeros_zt/out/main.js"));
    struct stat st;
    CHECK(stat("/tmp/celeros_zt/out/main.js", &st) != 0);
    z.close();

    // zip truncado (sem EOCD) nao abre
    CHECK(buildZip(zpath, es, 4));
    {
        struct stat sz;
        stat(zpath, &sz);
        FILE* g = fopen(zpath, "r+b");
        ftruncate(fileno(g), (off_t)sz.st_size - 10);
        fclose(g);
    }
    CHECK(!z.open(zpath));

    // traversal no nome rejeita na abertura
    ZipTEntry evil[] = {{"../evil.txt", JS, (uint32_t)(sizeof(JS) - 1), false, false}};
    CHECK(buildZip("/tmp/celeros_zt/evil.zip", evil, 1));
    CHECK(!z.open("/tmp/celeros_zt/evil.zip"));

    // metodo desconhecido (12: implosionado) rejeita na abertura
    ZipTEntry one[] = {{"Pkg/x.js", JS, (uint32_t)(sizeof(JS) - 1), false, false}};
    CHECK(buildZip("/tmp/celeros_zt/m.zip", one, 1));
    {
        FILE* g = fopen("/tmp/celeros_zt/m.zip", "r+b");
        fseek(g, 8, SEEK_SET);           // method no cabecalho local
        fputc(12, g);
        fseek(g, -22 - 46 - 8 + 10, SEEK_END);  // method no central directory
        fputc(12, g);
        fclose(g);
    }
    CHECK(!z.open("/tmp/celeros_zt/m.zip"));

    // mentira no tamanho declarado: bomba guardada pelo teto do uncomp
    ZipTEntry infl[] = {{"Pkg/p.bin", pad, sizeof(pad), true, false}};
    CHECK(buildZip("/tmp/celeros_zt/b.zip", infl, 1));
    {
        FILE* g = fopen("/tmp/celeros_zt/b.zip", "r+b");
        fseek(g, -22 - 46 - 9 + 24, SEEK_END);  // uncomp no central directory ("Pkg/p.bin" = 9)
        fputc(5, g); fputc(0, g); fputc(0, g); fputc(0, g);
        fclose(g);
    }
    CHECK(z.open("/tmp/celeros_zt/b.zip"));
    CHECK(z.count() == 1);
    CHECK(!z.extractTo(0, "/tmp/celeros_zt/out/p.bin"));
    z.close();

    // zip vazio (so EOCD) abre com 0 entradas
    {
        std::vector<uint8_t> ev;
        zPush32(ev, 0x06054b50);
        zPush16(ev, 0); zPush16(ev, 0); zPush16(ev, 0); zPush16(ev, 0);
        zPush32(ev, 0); zPush32(ev, 0); zPush16(ev, 0);
        FILE* g = fopen("/tmp/celeros_zt/vazio.zip", "wb");
        fwrite(ev.data(), 1, ev.size(), g);
        fclose(g);
    }
    CHECK(z.open("/tmp/celeros_zt/vazio.zip"));
    CHECK(z.count() == 0);
    z.close();

    // entrada demais (tetos do pacote) rejeita
    {
        ZipTEntry muitos[65];
        static uint8_t dot[1] = {'x'};
        static char nomes[65][16];
        for (int i = 0; i < 65; i++) {
            snprintf(nomes[i], sizeof(nomes[i]), "Pkg/f%d.js", i);
            muitos[i] = {nomes[i], dot, 1, false, false};
        }
        CHECK(buildZip("/tmp/celeros_zt/muitos.zip", muitos, 65));
        CHECK(!z.open("/tmp/celeros_zt/muitos.zip"));
    }
}

// ------------------------------------------------------------- AppZip adversarial
// O leitor de zip e um parser de entrada NAO CONFIavel (vem do hub, do OTA e
// do cabo): cada caso aqui mente de um jeito diferente e espera a recusa
// EXATA que o AppZip.cpp promete no header — sem estouro de alocacao, sem
// escrita fora do lugar e sem arquivo truncado deixado para tras.

// Escritor de zip de UMA entrada a partir de um payload CRU (o buildZip
// comprime sempre; aqui o teste controla o stream exato que vai no ar,
// para poder truncar o deflate no meio de um bloco)
static bool buildZipRaw(const char* path, const char* name, const uint8_t* payload,
                        uint32_t plen, uint32_t uncomp, uint32_t crc) {
    std::vector<uint8_t> z;
    uint16_t nameLen = (uint16_t)strlen(name);
    zPush32(z, 0x04034b50);
    zPush16(z, 20); zPush16(z, 0); zPush16(z, 8);   // metodo 8 (deflate)
    zPush16(z, 0); zPush16(z, 0x21);
    zPush32(z, crc);
    zPush32(z, plen);
    zPush32(z, uncomp);
    zPush16(z, nameLen); zPush16(z, 0);
    z.insert(z.end(), name, name + nameLen);
    z.insert(z.end(), payload, payload + plen);
    uint32_t cdOff = (uint32_t)z.size();
    zPush32(z, 0x02014b50);
    zPush16(z, 20); zPush16(z, 20); zPush16(z, 0); zPush16(z, 8);
    zPush16(z, 0); zPush16(z, 0x21);
    zPush32(z, crc);
    zPush32(z, plen);
    zPush32(z, uncomp);
    zPush16(z, nameLen);
    zPush16(z, 0); zPush16(z, 0); zPush16(z, 0); zPush16(z, 0);
    zPush32(z, 0);
    zPush32(z, 0);
    z.insert(z.end(), name, name + nameLen);
    uint32_t cdSize = (uint32_t)z.size() - cdOff;
    zPush32(z, 0x06054b50);
    zPush16(z, 0); zPush16(z, 0);
    zPush16(z, 1); zPush16(z, 1);
    zPush32(z, cdSize);
    zPush32(z, cdOff);
    zPush16(z, 0);
    FILE* f = fopen(path, "wb");
    if (f == nullptr) return false;
    fwrite(z.data(), 1, z.size(), f);
    fclose(f);
    return true;
}

// Patch de um uint32 LE em offset absoluto (o zip mentiroso do teste)
static void zipPatch32(const char* path, long off, uint32_t v) {
    FILE* g = fopen(path, "r+b");
    if (g == nullptr) return;
    fseek(g, off, SEEK_SET);
    for (int i = 0; i < 4; i++) fputc((int)((v >> (8 * i)) & 0xFF), g);
    fclose(g);
}

// Inicio do central directory de um zip de 1 entrada sem comentario
// (buildZip/buildZipRaw): local + CD + EOCD de 22 no fim
static long zipCdOff(const char* path, long nameLen) {
    struct stat st;
    return stat(path, &st) == 0 ? (long)st.st_size - 22 - (46 + nameLen) : -1;
}

static bool zipAbsent(const char* p) {
    struct stat st;
    return stat(p, &st) != 0;
}

static void testAppZipAdversarial() {
    using namespace celer::appzip;
    mkdir("/tmp/celeros_zt", 0755);
    mkdir("/tmp/celeros_zt/out", 0755);
    static uint8_t PAD[400];  // padrao LZ-friendly, igual ao pad do testAppZip
    for (int i = 0; i < 400; i++) PAD[i] = (uint8_t)('A' + (i % 26));
    static uint8_t big[100 * 1024];
    for (size_t i = 0; i < sizeof(big); i++) big[i] = (uint8_t)('a' + (i % 7));
    static uint8_t back[100 * 1024 + 16];
    ZipTEntry one[] = {{"Pkg/x.js", PAD, sizeof(PAD), true, false}};
    const char* zpath = "/tmp/celeros_zt/adv.zip";
    const char* out = "/tmp/celeros_zt/out/adv.bin";
    Reader z;

    // ---- metodo desconhecido (6 = implode, 7 = reservado) rejeita na
    // abertura, com a mentira gravada nos DOIS cabecalhos (local e CD)
    for (int method = 6; method <= 7; method++) {
        CHECK(buildZip(zpath, one, 1));
        long cd = zipCdOff(zpath, 8);
        CHECK(cd > 0);
        FILE* g = fopen(zpath, "r+b");
        fseek(g, 8, SEEK_SET); fputc(method, g);        // method do cabecalho local
        fseek(g, cd + 10, SEEK_SET); fputc(method, g);  // method do central directory
        fclose(g);
        CHECK(!z.open(zpath));
    }

    // ---- nomes venenosos no central directory: nameSafe recusa na abertura
    // (barra inicial, barra invertida, nao-ASCII; o ".." em segmento ja tem
    // caso proprio no testAppZip com o evil.zip)
    const char* evilNames[] = {"/absoluto.txt", "Pkg\\x.js", "acento\xe7.txt"};
    for (int i = 0; i < 3; i++) {
        ZipTEntry evil[] = {{evilNames[i], PAD, sizeof(PAD), true, false}};
        CHECK(buildZip(zpath, evil, 1));
        CHECK(!z.open(zpath));
    }

    // ---- zip truncado no meio do deflate: cabecalhos HONESTOS com um stream
    // que acaba antes da hora (falta o fim do bloco final). A abertura passa
    // (o CD nao mente) e a extracao falha sem deixar o destino para tras
    {
        uint8_t stream[1024];
        size_t clen = tdefl_compress_mem_to_mem(stream, sizeof(stream), PAD, sizeof(PAD), 128);
        CHECK(clen > 12 && clen < sizeof(stream));
        CHECK(buildZipRaw(zpath, "Pkg/t.bin", stream, (uint32_t)(clen - 6), sizeof(PAD),
                          hostframe::crc32(PAD, sizeof(PAD))));
        CHECK(z.open(zpath));
        Entry e;
        CHECK(z.stat(0, &e) && e.uncompSize == sizeof(PAD) && e.method == 8);
        CHECK(!z.extractTo(0, out));
        CHECK(zipAbsent(out));  // truncado: nada de lixo parcial
        z.close();
    }

    // ---- compSize passado do fim do arquivo (so o CD mente): abre, a
    // extracao bate no EOF do dado comprimido e falha limpa
    CHECK(buildZip(zpath, one, 1));
    zipPatch32(zpath, zipCdOff(zpath, 8) + 20, 100000);  // comp no CD
    CHECK(z.open(zpath));
    CHECK(!z.extractTo(0, out));
    CHECK(zipAbsent(out));
    z.close();

    // ---- EOCD depois de comentario de 4 KB EXATOS: a janela de busca
    // (kEocdScan = 22 + 4096) pega na borda; um byte a mais rejeita
    CHECK(buildZip(zpath, one, 1));
    {
        struct stat st;
        stat(zpath, &st);
        long base = (long)st.st_size;
        FILE* g = fopen(zpath, "ab");
        for (int i = 0; i < 4096; i++) fputc('A', g);
        fclose(g);
        zipPatch32(zpath, base - 2, 4096);  // comment length do EOCD
    }
    CHECK(z.open(zpath));
    CHECK(z.count() == 1);
    z.close();
    CHECK(buildZip(zpath, one, 1));
    {
        struct stat st;
        stat(zpath, &st);
        long base = (long)st.st_size;
        FILE* g = fopen(zpath, "ab");
        for (int i = 0; i < 4097; i++) fputc('A', g);
        fclose(g);
        zipPatch32(zpath, base - 2, 4097);  // fora da janela de 4 KB: sem EOCD
    }
    CHECK(!z.open(zpath));

    // ---- stored com compSize != uncompSize: o CRC do conteudo BATE (os
    // bytes sao os mesmos); so a conferencia dos tamanhos pega a mentira
    ZipTEntry stored[] = {{"Pkg/s.bin", PAD, sizeof(PAD), false, false}};
    CHECK(buildZip(zpath, stored, 1));
    zipPatch32(zpath, zipCdOff(zpath, 9) + 24, sizeof(PAD) + 1);  // uncomp no CD
    CHECK(z.open(zpath));
    {
        Entry e;
        CHECK(z.stat(0, &e) && e.uncompSize == sizeof(PAD) + 1);  // stat reflete a mentira do CD
        CHECK(!z.extractTo(0, out));
        CHECK(zipAbsent(out));
    }
    z.close();

    // ---- bomba pela mentira ALTA no uncomp (deflate honesto de 400 B que
    // "descomprimiria" 15 MB): o streaming nunca aloca pelo declarado; a
    // extracao falha no done != uncompSize, sem estourar nada
    CHECK(buildZip(zpath, one, 1));
    zipPatch32(zpath, zipCdOff(zpath, 8) + 24, 0x00F00000u);
    CHECK(z.open(zpath));
    CHECK(!z.extractTo(0, out));
    CHECK(zipAbsent(out));
    z.close();

    // ---- streaming acima da janela de 32 KB (entrada de 100 KB): o dicionario
    // LZ descarrega e recomeca no meio da entrada — round-trip integral
    {
        ZipTEntry Grande[] = {{"Pkg/big.bin", big, sizeof(big), true, false}};
        CHECK(buildZip(zpath, Grande, 1));
        CHECK(z.open(zpath));
        Entry e;
        CHECK(z.stat(0, &e) && e.uncompSize == sizeof(big));
        CHECK(z.extractTo(0, out));
        FILE* f = fopen(out, "rb");
        size_t got = f ? fread(back, 1, sizeof(back), f) : 0;
        if (f) fclose(f);
        CHECK(got == sizeof(big) && memcmp(back, big, sizeof(big)) == 0);
        z.close();
    }
}

// ------------------------------------------------------------- AppPackage
// Instalacao do pacote .zip (Utils/AppPackage.cpp): validacao, staging e
// troca com rollback.
#include "../../main/Utils/AppPackage.h"
#include "../../main/Utils/InstallMarker.h"

static bool existsPathSt(const char* p) {
    struct stat st;
    return stat(p, &st) == 0;
}

static std::string slurpZip(const char* path) {
    FILE* f = fopen(path, "rb");
    if (f == nullptr) return "<ausente>";
    std::string out;
    char buf[256];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
    fclose(f);
    return out;
}

static void testAppPackage() {
    using namespace celer::apppkg;
    mkdir("/tmp/celeros_zt", 0755);
    static const uint8_t JS1[] = "var v = 1;\nSystem.println('zip v1');\n";
    static const uint8_t JS2[] = "System.println('zip v2');\n";
    static const uint8_t BIN[] = "asset0123456789asset0123456789";
    const char* meta =
        "{\"name\":\"Teste Zip\",\"packageName\":\"teste.zip\",\"version\":\"1.0.0\","
        "\"author\":\"eu\",\"description\":\"t\"}";
    ZipTEntry es1[] = {
        {"app.json", (const uint8_t*)meta, (uint32_t)strlen(meta), false, false},
        {"main.js", JS1, (uint32_t)(sizeof(JS1) - 1), false, false},
        {"arte.bin", BIN, (uint32_t)(sizeof(BIN) - 1), true, false},
    };
    ZipTEntry es2[] = {
        {"app.json", (const uint8_t*)meta, (uint32_t)strlen(meta), false, false},
        {"main.js", JS2, (uint32_t)(sizeof(JS2) - 1), false, false},
        {"arte.bin", BIN, (uint32_t)(sizeof(BIN) - 1), true, false},
    };
    const char* dest = "/tmp/celeros_zt/pkg";
    const char* zpath = "/tmp/celeros_zt/pkg.zip";

    // 1a instalacao
    CHECK(buildZip(zpath, es1, 3));
    Result res;
    CHECK(installZip(zpath, dest, &res));
    CHECK(res.ok && res.files == 3);
    CHECK(slurpZip("/tmp/celeros_zt/pkg/main.js") == (const char*)JS1);
    CHECK(slurpZip("/tmp/celeros_zt/pkg/arte.bin") == (const char*)BIN);
    CHECK(slurpZip("/tmp/celeros_zt/pkg/app.json") == meta);
    CHECK(!existsPathSt("/tmp/celeros_zt/pkg.new") && !existsPathSt("/tmp/celeros_zt/pkg.old"));

    // update: v2 substitui o main.js inteiro
    CHECK(buildZip(zpath, es2, 3));
    CHECK(installZip(zpath, dest, &res));
    CHECK(res.ok && slurpZip("/tmp/celeros_zt/pkg/main.js") == (const char*)JS2);

    // falha no meio (CRC do app.json): app antigo INTACTO e sem lixo de staging
    CHECK(buildZip(zpath, es1, 3));
    {
        FILE* g = fopen(zpath, "r+b");
        fseek(g, 50, SEEK_SET);  // dado do app.json (local: 30 de header + 8 de nome)
        int c = fgetc(g);
        fseek(g, 50, SEEK_SET);
        fputc(c ^ 0xFF, g);
        fclose(g);
    }
    CHECK(!installZip(zpath, dest, &res));
    CHECK(slurpZip("/tmp/celeros_zt/pkg/main.js") == (const char*)JS2);
    CHECK(!existsPathSt("/tmp/celeros_zt/pkg.new") && !existsPathSt("/tmp/celeros_zt/pkg.old"));

    // sem app.json nao e pacote
    ZipTEntry semMeta[] = {{"main.js", JS1, (uint32_t)(sizeof(JS1) - 1), false, false}};
    CHECK(buildZip(zpath, semMeta, 1));
    CHECK(!installZip(zpath, dest, &res));
    CHECK(slurpZip("/tmp/celeros_zt/pkg/main.js") == (const char*)JS2);

    // mentira no tamanho declarado: teto por arquivo rejeita ANTES de extrair
    CHECK(buildZip(zpath, es1, 3));
    {
        FILE* g = fopen(zpath, "r+b");
        // CD: 3 entradas (app.json=8, main.js=7, arte.bin=8) + EOCD 22
        long cdStart = (long)slurpZip(zpath).size() - 22 - (46 + 8) - (46 + 7) - (46 + 8);
        fseek(g, cdStart + (46 + 8) + (46 + 7) + 24, SEEK_SET);  // uncomp da arte.bin
        fputc(0xFF, g); fputc(0xFF, g); fputc(0xFF, g); fputc(0x7F, g);
        fclose(g);
    }
    CHECK(!installZip(zpath, dest, &res));
    CHECK(slurpZip("/tmp/celeros_zt/pkg/main.js") == (const char*)JS2);
}

static void testUsbDesc() {
    using namespace usbdesc;

    // Impressora ESC/POS: 1 interface (classe 7/1/2), bulk OUT 0x01 + bulk IN
    // 0x82, com um descritor de classe no meio (deve ser pulado).
    const uint8_t printer[] = {
        9,  0x02, 41, 0, 1, 1, 0, 0x80, 0x32,       // config (41 bytes, 1 iface)
        9,  0x04, 0,  0, 2, 7, 1, 2, 0,             // interface 0, 2 EPs, 7/1/2
        9,  0x24, 0,  1, 0, 0, 0, 0, 0,             // CS_INTERFACE (ignorar)
        7,  0x05, 0x01, 0x02, 64, 0, 0,             // EP 0x01 OUT bulk
        7,  0x05, 0x82, 0x02, 64, 0, 0,             // EP 0x82 IN bulk
    };
    DevDesc d;
    CHECK(parseConfig(printer, sizeof(printer), d));
    CHECK(d.nIfs == 1);
    CHECK(d.ifs[0].num == 0);
    CHECK(d.ifs[0].cls == 7);
    CHECK(d.ifs[0].subcls == 1);
    CHECK(d.ifs[0].proto == 2);
    CHECK(d.ifs[0].nEps == 2);
    CHECK(d.ifs[0].eps[0].addr == 0x01);
    CHECK(d.ifs[0].eps[0].type == kEpBulk);
    CHECK(d.ifs[0].eps[0].mps == 64);
    CHECK(d.ifs[0].eps[1].addr == 0x82);
    CHECK(d.ifs[0].eps[1].type == kEpBulk);
    CHECK(d.ifs[1].nEps == 0);  // fora do range: zerado

    // Teclado boot: interface 3/1/1, interrupt IN 0x81 mps 8, 2 alts.
    const uint8_t kbd[] = {
        9, 0x02, 43, 0, 2, 1, 0, 0x80, 0x32,
        9, 0x04, 0, 0, 0, 3, 1, 1, 0,               // alt 0, sem EP
        9, 0x04, 0, 1, 1, 3, 1, 1, 0,               // alt 1, 1 EP
        7, 0x05, 0x81, 0x03, 8, 0, 10,              // INT IN 0x81, mps 8, 10ms
    };
    DevDesc h;
    CHECK(parseConfig(kbd, sizeof(kbd), h));
    CHECK(h.nIfs == 2);
    CHECK(h.ifs[1].alt == 1);
    CHECK(h.ifs[1].nEps == 1);
    CHECK(h.ifs[1].eps[0].type == kEpInterrupt);
    CHECK(h.ifs[1].eps[0].addr == 0x81);
    CHECK(h.ifs[1].eps[0].interval == 10);

    // Teto de interfaces: 7 no blob -> 6 guardadas, sem estourar.
    uint8_t many[9 + 7 * 9] = {9, 0x02, (uint8_t)(sizeof(many) & 0xFF),
                               (uint8_t)(sizeof(many) >> 8), 7, 1, 0, 0x80, 0x32};
    for (int i = 0; i < 7; i++) {
        uint8_t* p = many + 9 + i * 9;
        p[0] = 9; p[1] = 0x04; p[2] = (uint8_t)i; p[3] = 0; p[4] = 0;
        p[5] = 0xFF; p[6] = 0; p[7] = 0; p[8] = 0;
    }
    DevDesc m;
    CHECK(parseConfig(many, sizeof(many), m));
    CHECK(m.nIfs == kMaxIfaces);

    // Blobs invalidos: null, curto, tipo errado, total quebrado.
    DevDesc bad;
    CHECK(!parseConfig(nullptr, 0, bad));
    CHECK(!parseConfig(printer, 4, bad));
    const uint8_t notCfg[] = {9, 0x01, 9, 0, 0, 0, 0, 0, 0};
    CHECK(!parseConfig(notCfg, sizeof(notCfg), bad));
    const uint8_t noIf[] = {9, 0x02, 9, 0, 0, 0, 0, 0, 0};
    CHECK(!parseConfig(noIf, sizeof(noIf), bad));

    // Endpoint de 9 bytes (audio) e bloco truncado: para sem ler alem do total.
    const uint8_t trunc[] = {9, 0x02, 40, 0, 1, 1, 0, 0x80, 0x32,
                             9, 0x04, 0, 0, 2, 7, 1, 2, 0,
                             7, 0x05, 0x01, 0x02, 64, 0, 0};  // diz 40, tem 26
    DevDesc t;
    CHECK(parseConfig(trunc, sizeof(trunc), t));
    CHECK(t.ifs[0].nEps == 1);
}

static void testInstallMarker() {
    using namespace celer::setup;
    CHECK(due("1.0.0", ""));        // nunca rodou
    CHECK(due("1.1.0", "1.0.0"));   // versao nova
    CHECK(!due("1.0.0", "1.0.0"));  // mesma versao
    CHECK(!due("1.0.0", "2.0.0"));  // downgrade nao re-roda
    CHECK(!due("", "1.0.0"));       // sem versao no app.json: nunca roda
    CHECK(!due("", ""));
}

int main() {
    testSemVer();
    testFsJail();
    testPermissions();
    testJsStrip();
    testJsStripInPlaceApps();
    testHostFrame();
    testAlarmCalc();
    testGbProto();
    testDeviceStatsJson();
    testMemWatch();
    testSettings();
    testMusicEngine();
    testMusicHandoff();
    testSfxVoice();
    testDirtyRects();
    testDirtyRectsScattered();
    testJsonMap();
    testNetFrame();
    testResProto();
    testResMeta();
    testResGpioOps();
    testReflex();
    testUsbRes();
    testHelloHunt();
    testUsbMedia();
    testUsbJoin();
    testUsbVirtualNode();
    testPackId();
    testProvProto();
    testRigid2D();
    testRigid2DHammer();
    testRigid2DMath();
    testVerlet2D();
    testShellResolveWild();
    testShellTail();
    testShellVarsArith();
    testShScript();
    testAppZip();
    testAppZipAdversarial();
    testAppPackage();
    testInstallMarker();
    testUsbDesc();
    if (g_failed == 0) {
        printf("OK: %d checks passaram\n", g_total);
        return 0;
    }
    printf("%d/%d falharam\n", g_failed, g_total);
    return 1;
}
