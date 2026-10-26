#ifndef CELER_CRASH_RECORD_H
#define CELER_CRASH_RECORD_H

/**
 * @file CrashRecord.h
 * @brief Forense de crash: registro em RAM RTC + tela/QR + crash.txt no boot.
 *
 * Um hook no esp_panic_handler (linker wrap, --wrap=esp_panic_handler) captura
 * causa, endereco e backtrace num struct RTC_NOINIT_ATTR que SOBREVIVE ao
 * reboot do panic. No boot seguinte, se o motivo do reset foi ESP_RST_PANIC
 * (excecao ou abort; watchdogs NAO contam, para nao apagar um crash real com
 * um kick), o aparelho:
 *   1. desenha uma tela de crash nativa com QR (placas com CELEROS_CRASH_SCREEN);
 *   2. anexa uma linha em /local/log/crash.txt (toda placa, headless incluso).
 * O agente de frota (celeros.agent) le esse arquivo e reporta ao cloud.
 *
 * No contexto do panic NAO ha malloc nem std::string (um new que nao cresce
 * e abort() — abortaria dentro do proprio handler). O hook grava apenas em
 * RAM RTC; a tela e o arquivo acontecem no boot SEGUINTE, com o sistema de pé.
 */

namespace CrashRecord {

/**
 * @brief Registra o wrap do linker (--wrap=esp_panic_handler).
 *
 * Chamar no comeco do celerSetup, antes de qualquer coisa que possa panicar.
 */
void installPanicHook();

/**
 * @brief Existe registro de crash valido para este boot?
 *
 * reset == ESP_RST_PANIC && magic do struct RTC confere.
 */
bool pending();

/**
 * @brief Anexa o registro em /local/log/crash.txt e limpa o magic.
 *
 * Chamar depois de FileSystem::init(). Escrita direta fopen/fwrite (padrao
 * do recordCrash: zero malloc, best-effort). Consome o registro (magic=0):
 * um novo panic sobrescreve e o ciclo recomeca.
 */
void consumeAndLog();

#if defined(CONFIG_CELEROS_CRASH_SCREEN) && CONFIG_CELEROS_CRASH_SCREEN
/**
 * @brief Desenha a tela de crash nativa (titulo, causa, PCs e QR) e espera
 *        ~7 s (toque no botao fisico pula). Desenho direto no tft, sem
 *        Navigator/Kui — roda antes do bootSplash.
 */
void showScreen();
#endif

}  // namespace CrashRecord

#endif  // CELER_CRASH_RECORD_H
