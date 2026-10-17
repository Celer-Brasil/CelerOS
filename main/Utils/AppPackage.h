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
constexpr uint32_t kMaxFileUncomp = 272 * 1024;   // maior asset (256K) + folga
constexpr uint32_t kMaxTotalUncomp = 448 * 1024;  // 128 codigo + 256 assets + 10 icone + folga

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

}  // namespace celer::apppkg

#endif  // APP_PACKAGE_H
