#ifndef APP_PACKAGE_H
#define APP_PACKAGE_H

#include <stdint.h>

/**
 * @file AppPackage.h
 * @brief Instalacao do pacote unico do app (.zip que o hub ja produz):
 * validacao de conteudo com os tetos do lint, extracao para
 * <destDir>.new e troca com rollback (o app antigo fica intacto se algo
 * falhar no meio — queda de energia incluida).
 *
 * POSIX puro pelo mesmo motivo do AppZip (os mounts sao VFS real e o
 * codigo e testavel no host, test/cpp): o device chama direto, sem o
 * wrapper FileSystem. Consome celer::appzip::Reader por cima.
 */

namespace celer::apppkg {

// Tetos de seguranca na extracao (o lint fino por categoria continua no
// publish; aqui so impede zip bomb e disco cheio por meta-gordura).
// Base: o pacote classico (128 codigo + 256 assets + 10 icone + folga). Os
// tetos EFETIVOS sao escolhidos em runtime (installZip): com PSRAM a placa
// abre a era nativa (blob CLRN de ate 512KB) — o mesmo binario atende as
// duas familias de placa; o host test (CELER_HOST_TEST) usa a base.
constexpr uint32_t kMaxFileUncomp = 272 * 1024;        // maior asset (256K) + folga
constexpr uint32_t kMaxTotalUncomp = 448 * 1024;       // pacote classico + folga
constexpr uint32_t kMaxFileUncompPsram = 560 * 1024;   // blob CLRN (512K) + folga
constexpr uint32_t kMaxTotalUncompPsram = 1024 * 1024; // pacote nativo + folga

struct Result {
    bool ok = false;
    int files = 0;       // arquivos publicados (sem pastas)
    uint32_t bytes = 0;  // soma nao comprimida publicada
};

/** Instala <zipPath> em <destDir> (ex.: "/local/apps/Meu App"; a pasta pai
 *  tem que existir). O zip e FLAT (app.json na raiz, layout do hub).
 *  Passos: valida o zip inteiro ANTES de extrair (nomes, metodos, tetos,
 *  app.json presente) -> extrai em <destDir>.new -> confere que o entry
 *  declarado no app.json ("main", default main.js) existe -> troca
 *  <destDir> <-> <destDir>.new via <destDir>.old com rollback. */
bool installZip(const char* zipPath, const char* destDir, Result* out);

// Resultado da recuperacao de uma instalacao interrompida (queda de energia
// entre os renames da troca) ou de um update em trial.
struct Recovery {
    int restored = 0;   // .old devolvido ao lugar (o destino tinha sumido)
    int completed = 0;  // troca ja concluida; so sobrou o .old (limpo)
    int dropped = 0;    // .new de tentativa nao confirmada (removido)
    int reverted = 0;   // update de app de sistema revertido (boot instavel)
    int pending = 0;    // trial aguardando o primeiro lancamento limpo
    char revertedName[40] = {};  // primeiro app revertido (para o aviso)
};

/** Recupera <appsDir>/.install depois de uma instalacao interrompida.
 *  Idempotente e seguro para rodar em todo boot, DEPOIS do FileSystem::init
 *  e ANTES do scan do launcher. Regra conservadora: se o destino sumiu e
 *  existe um .old, ele volta (ultima versao que ja rodou); o .new de uma
 *  troca nao confirmada nunca e promovido — a loja tenta de novo.
 *  Journal (best-effort) em .install/journal.txt e so diagnostico.
 *
 *  `lastBootUnstable`: o boot anterior nao chegou a estabilizar. Com um
 *  trial pendente (update de app de sistema ainda nao confirmado), isso
 *  reverte para a versao anterior; sem a flag, o trial so e mantido. */
Recovery recover(const char* appsDir, bool lastBootUnstable = false);

// ---- Update de app de sistema com health check -------------------------
// installZip guarda o .old de um app "system": true e grava <base>.trial.
// O runtime confirma no primeiro lancamento limpo (commitTrial) ou reverte
// na hora se o app falhar (revertTrial). Sem nenhum dos dois, o proximo boot
// decide pelo estado do boot anterior (recover).
bool trialPending(const char* destDir);
bool commitTrial(const char* destDir);   // remove .old e o marcador
bool revertTrial(const char* destDir);   // devolve o .old e remove o marcador

}  // namespace celer::apppkg

#endif  // APP_PACKAGE_H
