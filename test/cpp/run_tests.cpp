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
#include "../../main/Hardware/MusicEngine.h"
#include "../../main/Display/DirtyRects.h"
#include "../../main/Utils/JsonMap.h"
#include "../../main/Bluetooth/NetFrame.h"
#include "../../main/Pack/ResProto.h"
#include "../../main/Utils/Rigid2D.h"
#include "../../main/Utils/Verlet2D.h"

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
    CHECK(parsePermissions("{\"name\":\"x\"}") == PERM_ALL);                       // ausente
    CHECK(parsePermissions("{\"permissions\":[\"fs\",\"net\"]}") == (PERM_FS | PERM_NET));
    CHECK(parsePermissions("{\"permissions\":[\"gpio\"]}") == PERM_GPIO);
    CHECK(parsePermissions("{\"permissions\":[\"system\"]}") == PERM_SYSTEM);
    CHECK(parsePermissions("{\"permissions\":[\"mic\"]}") == PERM_MIC);             // API 19
    CHECK(parsePermissions("{\"permissions\":[\"fs\",\"gpio\",\"system\",\"net\",\"mic\"]}") ==
          (PERM_FS | PERM_NET | PERM_GPIO | PERM_SYSTEM | PERM_MIC));
    CHECK(parsePermissions("{\"permissions\":[]}") == 0);                         // vazio = nenhuma
    CHECK(parsePermissions("{\"permissions\":[}") == PERM_ALL);                   // invalido = nao tranca
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

    // payload grande (limite do parser)
    for (size_t i = 0; i < sizeof(pbuf); i++) payload[i] = (uint8_t)(i * 7);
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

// CelerNet (NetFrame.h): quadro da malha por flood de advertising —
// round-trip (com dst do unicast), fragmentacao/remontagem e dedup, no host.
static void testNetFrame() {
    using namespace netframe;

    // round-trip DATA com o payload maximo (16 B) e dst do unicast
    uint8_t buf[ADV_MAX];
    Frame f;
    f.type = TYPE_DATA;
    f.netId = 0xBEEF;
    f.src = 0x1234;
    f.dst = 0xA1B2;
    f.seq = 0x5678;
    f.ttl = 4;
    f.hops = 2;
    const uint8_t payload[DATA_MAX] = "0123456789ABCDE";  // 15 + NUL = 16
    f.dlen = DATA_MAX;
    f.data = payload;
    size_t n = encode(f, buf, sizeof(buf));
    CHECK(n == HDR + DATA_MAX);
    Frame g;
    CHECK(decode(buf, n, &g));
    CHECK(g.type == TYPE_DATA && g.netId == 0xBEEF && g.src == 0x1234 && g.seq == 0x5678);
    CHECK(g.dst == 0xA1B2);
    CHECK(g.ttl == 4 && g.hops == 2 && g.dlen == DATA_MAX);
    CHECK(memcmp(g.data, payload, DATA_MAX) == 0);
    CHECK(g.dst != DST_BROADCAST);

    // default do Frame e broadcast: vizinho nao filtrado entrega
    Frame bc;
    CHECK(bc.dst == DST_BROADCAST);
    bc.type = TYPE_DATA;
    bc.netId = 0xBEEF;
    bc.src = 0x1234;
    bc.seq = 1;
    bc.dlen = 2;
    const uint8_t two[2] = {0xAA, 0xBB};
    bc.data = two;
    n = encode(bc, buf, sizeof(buf));
    CHECK(decode(buf, n, &g) && g.dst == DST_BROADCAST);

    // rejeicoes: dados grandes demais, ttl fora da faixa, lixo no ar
    Frame bad = f;
    bad.dlen = DATA_MAX + 1;
    CHECK(encode(bad, buf, sizeof(buf)) == 0);
    bad = f; bad.ttl = 0;   CHECK(encode(bad, buf, sizeof(buf)) == 0);
    bad = f; bad.ttl = TTL_MAX + 1; CHECK(encode(bad, buf, sizeof(buf)) == 0);
    CHECK(!decode(buf, n - 1, &g));                 // tamanho colidindo
    buf[0] = 'X';            CHECK(!decode(buf, n, &g));  // magic errado
    buf[0] = 'C'; buf[2] = 1; CHECK(!decode(buf, n, &g));  // versao errada (v1)

    // BEAT v2: [caps(1)][nome] — o papel do no viaja na presenca
    f.type = TYPE_BEAT;
    f.dst = DST_BROADCAST;
    const char* nome = "Celer-Dog";
    uint8_t beat[DATA_MAX];
    beat[0] = CAPS_SPEAKER | CAPS_MOTORS | CAPS_LEDS;
    size_t nomeLen = strlen(nome);
    memcpy(beat + 1, nome, nomeLen);
    f.dlen = (uint8_t)(1 + nomeLen);
    f.data = beat;
    n = encode(f, buf, sizeof(buf));
    CHECK(n == HDR + 1 + nomeLen);
    CHECK(decode(buf, n, &g) && g.type == TYPE_BEAT);
    CHECK(g.data[0] == (CAPS_SPEAKER | CAPS_MOTORS | CAPS_LEDS));
    CHECK(memcmp(g.data + 1, nome, nomeLen) == 0);

    // fnv16: deterministico e distingue nomes de rede
    CHECK(fnv16("celer") == fnv16("celer"));
    CHECK(fnv16("celer") != fnv16("casa"));

    // dedup: (src, seq, idx) visto 2x; vizinhos distintos passam
    DedupRing<4> dd;
    CHECK(!dd.seen(1, 100, 0));   // 1a vez = novo
    CHECK(dd.seen(1, 100, 0));    // repetido
    CHECK(!dd.seen(1, 100, 1));   // outro fragmento
    CHECK(!dd.seen(1, 101, 0));   // outro seq
    CHECK(!dd.seen(2, 100, 0));   // outro no
    CHECK(dd.seen(1, 100, 1));    // frag repetido de antes
    dd.clear();
    CHECK(!dd.seen(1, 100, 0));   // clear: tudo novo de novo

    // dedup do tamanho do CelerNet: uma mensagem cheia (31 frags) x 2 copias
    // + 30 BEATs de vizinhos; o frag 0 repetido DEPOIS da rajada (2o evento
    // do adv, relay atrasado) ainda tem que ser reconhecido. Com 32 entradas
    // (o tamanho antigo) o anel transbordava no meio da propria mensagem.
    DedupRing<128> big;
    DedupRing<32> old;
    for (uint16_t c = 0; c < 2; c++) {
        for (uint8_t i = 0; i < 31; i++) {
            big.seen(5, (uint16_t)(200 + c), i);
            old.seen(5, (uint16_t)(200 + c), i);
        }
    }
    for (uint16_t k = 0; k < 30; k++) { big.seen(9, k, 0); old.seen(9, k, 0); }
    CHECK(big.seen(5, 200, 0));    // 128: ainda lembra o 1o frag
    CHECK(!old.seen(5, 200, 0));   // 32: esqueceu (o bug da bancada)

    // copias de unicast dividem o seq: o frag que faltou na copia 0 vem da
    // copia 1 (copia nos bits 5-6 do idx) e a remontagem sai UMA vez so
    {
        Reassembler rc;
        uint8_t m3[3 * CHUNK_MAX];
        for (size_t i = 0; i < sizeof(m3); i++) m3[i] = (uint8_t)(i + 1);
        uint8_t o3[MSG_MAX];
        size_t l3 = 0;
        const uint8_t c1 = (uint8_t)(1 << FRAG_COPY_SHIFT);
        CHECK(!rc.feed(7, 50, 0, 3, m3, CHUNK_MAX, 0, o3, sizeof(o3), &l3));            // copia 0: frag 0
        CHECK(!rc.feed(7, 50, 2, 3, m3 + 28, CHUNK_MAX, 10, o3, sizeof(o3), &l3));      // copia 0: frag 2 (1 perdido)
        CHECK(!rc.feed(7, 50, (uint8_t)(0 | c1), 3, m3, CHUNK_MAX, 20, o3, sizeof(o3), &l3));  // copia 1: frag 0 repetido
        CHECK(rc.feed(7, 50, (uint8_t)(1 | c1), 3, m3 + 14, CHUNK_MAX, 30, o3, sizeof(o3), &l3)); // copia 1 completa
        CHECK(l3 == sizeof(m3) && memcmp(o3, m3, sizeof(m3)) == 0);
        CHECK(!rc.feed(7, 50, (uint8_t)(2 | c1), 3, m3 + 28, CHUNK_MAX, 40, o3, sizeof(o3), &l3)); // sem 2a entrega
        CHECK(!rc.feed(7, 50, (uint8_t)(0 | c1), 3, m3, CHUNK_MAX, 50, o3, sizeof(o3), &l3));      // nem slot novo
    }

    // remontagem: mensagem de 434 B = 31 fragmentos de 14 B, fora de ordem
    uint8_t msg[MSG_MAX];
    for (size_t i = 0; i < MSG_MAX; i++) msg[i] = (uint8_t)(i * 7);
    Reassembler ra;
    uint8_t out[MSG_MAX];
    size_t outLen = 0;
    const uint8_t total = (MSG_MAX + CHUNK_MAX - 1) / CHUNK_MAX;  // 31
    CHECK(total == MAX_FRAGS);
    bool done = false;
    for (int pass = 0; pass < 2 && !done; pass++) {
        for (int k = 0; k < total && !done; k++) {
            int idx = (k * 7) % total;  // ordem embaralhada (7 e coprimo de 31)
            size_t off = (size_t)idx * CHUNK_MAX;
            uint8_t len = idx + 1 == total ? (uint8_t)(MSG_MAX - off) : CHUNK_MAX;
            done = ra.feed(0xA1B2, 42, (uint8_t)idx, total, msg + off, len,
                           pass * 100 + k * 10, out, sizeof(out), &outLen);
        }
    }
    CHECK(done);
    CHECK(outLen == MSG_MAX);
    CHECK(memcmp(out, msg, MSG_MAX) == 0);

    // fragmento repetido nao entrega duas vezes nem corrompe o slot
    ra.reset();
    done = ra.feed(3, 7, 0, 2, msg, CHUNK_MAX, 0, out, sizeof(out), &outLen);
    CHECK(!done);
    done = ra.feed(3, 7, 0, 2, msg, CHUNK_MAX, 1, out, sizeof(out), &outLen);  // repetido
    CHECK(!done);
    done = ra.feed(3, 7, 1, 2, msg + CHUNK_MAX, 4, 2, out, sizeof(out), &outLen);
    CHECK(done && outLen == CHUNK_MAX + 4);

    // chunk curto no MEIO (nao-ultimo) e recusado: buraco nao cola
    ra.reset();
    CHECK(!ra.feed(3, 8, 0, 2, msg, CHUNK_MAX - 1, 0, out, sizeof(out), &outLen));

    // total acima do teto e recusado (31 e o maximo de fragmentos)
    ra.reset();
    CHECK(!ra.feed(3, 8, 30, 32, msg, CHUNK_MAX, 0, out, sizeof(out), &outLen));

    // slot vence: fragmento perdido libera para a proxima mensagem
    ra.reset();
    CHECK(!ra.feed(4, 9, 0, 2, msg, CHUNK_MAX, 0, out, sizeof(out), &outLen));
    ra.prune(3000, 2000);  // 3 s depois do lastMs=0
    done = ra.feed(4, 9, 1, 2, msg + CHUNK_MAX, 4, 4000, out, sizeof(out), &outLen);
    CHECK(!done);  // slot antigo foi podado: frag solto nao entrega
    done = ra.feed(4, 9, 0, 2, msg, CHUNK_MAX, 4100, out, sizeof(out), &outLen);
    CHECK(done);   // mensagem nova (mesmo src/seq) recomeca limpa
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

// Verlet nativo (API 31): Utils/Verlet2D.h — o mesmo codigo do
// System.verlet* (JsPhysics.cpp). O corte do vinculo (delStick) devolve a
// colisao ao par: a bitmask de vinculados e' recompute (relinkAll); o
// swap-remove antigo nao limpava a marca e o pedaco cortado parava de
// colidir para sempre
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

// ------------------------------------------------------------- shell (shl)

#include <cstdarg>

// Cenario do sh: variaveis + linhas executadas + saida do interpretador.
struct ShTVar {
    std::string name, val;
};
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
    testMusicEngine();
    testMusicHandoff();
    testSfxVoice();
    testDirtyRects();
    testJsonMap();
    testNetFrame();
    testResProto();
    testRigid2D();
    testRigid2DHammer();
    testRigid2DMath();
    testVerlet2D();
    if (g_failed == 0) {
        printf("OK: %d checks passaram\n", g_total);
        return 0;
    }
    printf("%d/%d falharam\n", g_failed, g_total);
    return 1;
}
