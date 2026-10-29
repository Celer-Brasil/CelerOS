/* Fixup do duk_config.h (gerado com --fixup-header-file): declara o hook de
 * timeout de execucao (DUK_USE_EXEC_TIMEOUT_CHECK) no escopo do duktape.c.
 * O guarda extern "C" e essencial: duktape.c e C, o CelerKernel.cpp e C++.
 */
#ifdef __cplusplus
extern "C" {
#endif

extern duk_bool_t celer_exec_timeout_check(void *udata);

#ifdef __cplusplus
}
#endif

/* Debugger do Duktape por placa (Kconfig CELEROS_JS_DEBUGGER): o yaml liga
 * DUK_USE_DEBUGGER_SUPPORT e o recorte acontece AQUI, onde o sdkconfig da
 * placa e visivel. Ligado, cada funcao compilada ganha a propriedade
 * fileName — sem ela o executor nunca ativa breakpoint (o match e por
 * fileName da funcao) e o Status chega com arquivo undefined. Custo: uma
 * propriedade por funcao/closure, por isso so nas placas com PSRAM.
 */
#include "sdkconfig.h"
#if defined(CONFIG_CELEROS_JS_DEBUGGER) && CONFIG_CELEROS_JS_DEBUGGER
#define DUK_USE_FUNC_FILENAME_PROPERTY
/* Erro que derrubaria o app pausa no ponto do throw (pilha e locais
 * intactos para inspecao); o pcall do kernel e C, nao conta como catcher */
#define DUK_USE_DEBUGGER_PAUSE_UNCAUGHT
/* identifica o alvo na linha de versao do handshake do debugger */
#undef DUK_USE_TARGET_INFO
#define DUK_USE_TARGET_INFO "CelerOS"
#else
#undef DUK_USE_DEBUGGER_SUPPORT
#endif

/* Placas com PSRAM: cache de activation/catcher ligado. O yaml desliga para
 * a CYD (cada registro em cache segura RAM interna), mas sem ele TODA
 * chamada JS ou nativa faz malloc+free do registro de activation no
 * heap_caps (lock TLSF): medido no SmartDisplay 2026-10-09, ~23 us por
 * chamada — System.millis() custava o mesmo que uma funcao JS inteira.
 */
#if defined(CONFIG_SPIRAM) && CONFIG_SPIRAM
#define DUK_USE_CACHE_ACTIVATION
#define DUK_USE_CACHE_CATCHER
#endif

/* Placas sem PSRAM (CYD, devkit, esp32-cam): fora o que so troca flash por
 * velocidade em caminhos raros. Fastpaths de hex/base64 (Duktape.enc/dec,
 * tabelas de 1 KB), verificacao paranoica de Date e o suporte exato a
 * caracteres fora do BMP no FONTE (identificadores; strings seguem UTF-8
 * inteiras). O slot OTA da CYD e o recurso escasso.
 */
#if !(defined(CONFIG_SPIRAM) && CONFIG_SPIRAM)
#undef DUK_USE_HEX_FASTPATH
#undef DUK_USE_BASE64_FASTPATH
#undef DUK_USE_PARANOID_DATE_COMPUTATION
#undef DUK_USE_SOURCE_NONBMP
#endif
