#ifndef CELER_KERNEL_H
#define CELER_KERNEL_H

#include <Arduino.h>
#include <string>
#include "../../Boards/Board.h"
#include <duktape.h>

class CelerKernel {
public:
    static void init(CelerDisplay *tft);
    static void runFile(const char* filePath, const char* appTitle = "", bool topbarFixed = true,
                        const char* appPkg = "", uint32_t perms = 0xFFFFFFFFu);
    static void loop();
    static void executeJS(const char* jsCode);
    static duk_context *ctx;
    static CelerDisplay *tftInstance;
    // Heap livre para o app corrente no inicio (DRAM + IRAM de transbordo,
    // apos liberar os caches do launcher, antes do fonte/heap JS):
    // System.getInfo().appRAM
    static size_t appLaunchFreeHeap;
    // Mensagem do fatal do Duktape que reiniciou o aparelho (uma vez; nullptr
    // se o ultimo reset nao foi um fatal JS)
    static const char* takeLastFatal();
    // Persiste o ultimo erro de app em /local/lastcrash.txt (header versao/
    // data/app + detail). Best-effort SEM alocacao C++: roda tambem no caminho
    // de OOM, onde um std::string/new que nao cresce aborta o aparelho
    static void recordCrash(const char* kind, const char* detail);
    // O app cedeu (passou por JSBindings::present()): reinicia a janela de
    // cortesia do interrupt do executor (loop JS puro sem ceder -> erro em
    // vez de TWDT/reboot)
    static void noteAppYield();
    // Janela do interrupt em ms (default 1000 p/ apps; os servicos rodem com
    // 250 — AppServices troca no dispatch e restaura depois)
    static void setExecSliceMs(uint32_t ms);

    // Alocador do heap Duktape (reservas por placa: PSRAM-first / DRAM com
    // reserve 24KB + transbordo IRAM na CYD). Publicos para o svchost criar
    // o SEGUNDO heap com as mesmas regras (AppServices).
    static void* heapAlloc(void* udata, duk_size_t size);
    static void* heapRealloc(void* udata, void* ptr, duk_size_t size);
    static void heapFree(void* udata, void* ptr);

private:
    static void checkJSError(duk_context *ctx, duk_int_t result);
};

#endif // CELER_KERNEL_H
