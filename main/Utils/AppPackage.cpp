#include "AppPackage.h"

#include "AppZip.h"
#include "AppManifest.h"

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <mutex>
#include <vector>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef CELER_HOST_TEST
#include <esp_heap_caps.h>
#endif

namespace celer::apppkg {

namespace {

// Janela do tinfl (~43 KB) PSRAM-first no device; nos builds sem PSRAM cai
// para DRAM 8-bit e depois IRAM 8-bit (mesma escada do alocador do
// CelerKernel). Host: malloc padrao do AppZip.
#ifndef CELER_HOST_TEST
void setupDeviceAlloc() {
    static bool done = false;
    if (done) return;
    done = true;
    appzip::setAllocator(
        [](size_t n) -> void* {
            void* p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM);
            if (p != nullptr) return p;
            return heap_caps_malloc(n, MALLOC_CAP_8BIT | MALLOC_CAP_IRAM_8BIT);
        },
        free);
}
#endif

bool existsPath(const char* p) {
    struct stat st;
    return stat(p, &st) == 0;
}

// Tetos efetivos desta placa (runtime): PSRAM abre a era nativa (pacote com
// blob CLRN de ate 512KB); sem PSRAM ficam os tetos classicos. Host test usa
// a base (heap_caps nao existe la).
struct Caps { uint32_t file; uint32_t total; };
Caps effectiveCaps() {
#if defined(CELER_HOST_TEST)
    return {kMaxFileUncomp, kMaxTotalUncomp};
#else
    if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0)
        return {kMaxFileUncompPsram, kMaxTotalUncompPsram};
    return {kMaxFileUncomp, kMaxTotalUncomp};
#endif
}

bool isDirPath(const char* p) {
    struct stat st;
    return stat(p, &st) == 0 && S_ISDIR(st.st_mode);
}

// rm -rf com teto de profundidade (pacote e flat; pastas do proprio app)
bool rmRf(const std::string& path, int depth = 0) {
    if (depth > 8) return false;
    DIR* d = opendir(path.c_str());
    if (d == nullptr) return unlink(path.c_str()) == 0;
    struct dirent* e;
    bool ok = true;
    while ((e = readdir(d)) != nullptr) {
        if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
        std::string child = path + "/" + e->d_name;
        struct stat st;
        if (stat(child.c_str(), &st) != 0) continue;
        ok = S_ISDIR(st.st_mode) ? rmRf(child, depth + 1) : (unlink(child.c_str()) == 0);
        if (!ok) break;
    }
    closedir(d);
    return ok && rmdir(path.c_str()) == 0;
}

bool mkdirP(const std::string& path) {
    if (path.empty()) return false;
    std::string cur;
    size_t i = 0;
    if (path[0] == '/') {
        cur = "/";
        i = 1;
    }
    while (i <= path.size()) {
        size_t slash = path.find('/', i);
        if (slash == std::string::npos) slash = path.size();
        if (slash > i) {
            cur.append(path, i, slash - i);
            if (mkdir(cur.c_str(), 0775) != 0 && errno != EEXIST) return false;
            cur.append("/");
        }
        i = slash + 1;
    }
    return isDirPath(path.c_str());
}

// Le arquivo pequeno inteiro (app.json do pacote)
bool readSmall(const char* path, std::string* out, size_t cap) {
    FILE* f = fopen(path, "rb");
    if (f == nullptr) return false;
    char buf[512];
    size_t total = 0;
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        total += n;
        if (total > cap) {
            fclose(f);
            return false;
        }
        out->append(buf, n);
    }
    fclose(f);
    return true;
}

// "sub/arq.js" -> cria <base>/sub e devolve o caminho do arquivo
bool makeParentOf(const std::string& base, const char* rel, std::string* outFile) {
    std::string full = base + "/" + rel;
    size_t slash = full.rfind('/');
    if (slash == std::string::npos) return false;
    if (!mkdirP(full.substr(0, slash))) return false;
    *outFile = full;
    return true;
}

// Instalacoes concorrentes (shell, svchost, web), a recuperacao de boot e o
// health check de update compartilham o mesmo staging: um mutex so.
std::mutex s_installMux;

std::string trialPath(const std::string& stage, const std::string& base) {
    return stage + "/" + base + ".trial";
}

// Apps de INTERFACE do caminho de reparo/atualizacao: sao os que, quebrados,
// tiram do usuario a saida (a Loja nao abre, as Configuracoes nao abrem, o
// WiFi nao configura). So eles guardam o .old do update em trial — manter
// copia de TODO app system:true encheria o LittleFS da CYD (768 KB) depois de
// um lote da Loja. Servicos (Nucleo/Agente) nunca passam pelo runFile, entao
// um trial deles ficaria pendente para sempre.
bool criticalTrialApp(const std::string& id) {
    return id == "celeros.appstore" || id == "celeros.settings" ||
           id == "celeros.installer" || id == "celeros.wifi";
}

// Marcador do update em trial (app de sistema). A EXISTENCIA e o estado; o
// conteudo e so diagnostico.
void writeTrial(const std::string& stage, const std::string& base) {
    FILE* f = fopen(trialPath(stage, base).c_str(), "w");
    if (f == nullptr) return;
    fprintf(f, "base=%s\n", base.c_str());
    fclose(f);
}

// Confirma o trial: a versao nova abriu limpa. Remove a copia anterior.
bool commitTrialLocked(const std::string& dest) {
    const size_t slash = dest.find_last_of('/');
    if (slash == std::string::npos) return false;
    const std::string parent = dest.substr(0, slash);
    const std::string base = dest.substr(slash + 1);
    const std::string stage = parent + "/.install";
    const std::string trial = trialPath(stage, base);
    if (!existsPath(trial.c_str())) return false;
    rmRf(stage + "/" + base + ".old");
    unlink(trial.c_str());
    rmdir(stage.c_str());
    return true;
}

// Reverte o trial: devolve o .old (versao que ja rodava) e descarta a nova.
// Troca em tres passos com volta atras, para uma falha no meio nao perder
// as duas copias.
bool revertTrialLocked(const std::string& dest) {
    const size_t slash = dest.find_last_of('/');
    if (slash == std::string::npos) return false;
    const std::string parent = dest.substr(0, slash);
    const std::string base = dest.substr(slash + 1);
    const std::string stage = parent + "/.install";
    const std::string trial = trialPath(stage, base);
    const std::string oldDir = stage + "/" + base + ".old";
    if (!existsPath(trial.c_str()) || !existsPath(oldDir.c_str())) return false;
    if (!existsPath(dest.c_str())) {
        // A troca nem publicou a versao nova: so devolve a antiga.
        if (rename(oldDir.c_str(), dest.c_str()) != 0) return false;
        unlink(trial.c_str());
        rmdir(stage.c_str());
        return true;
    }
    const std::string bad = stage + "/" + base + ".bad";
    rmRf(bad);
    if (rename(dest.c_str(), bad.c_str()) != 0) return false;
    if (rename(oldDir.c_str(), dest.c_str()) != 0) {
        rename(bad.c_str(), dest.c_str());  // desfaz a primeira troca
        return false;
    }
    rmRf(bad);
    unlink(trial.c_str());
    rmdir(stage.c_str());
    return true;
}

// Recuperacao de <root>/.install (chamada com s_installMux preso).
Recovery recoverLocked(const std::string& root, bool lastBootUnstable) {
    Recovery rec;
    const std::string stage = root + "/.install";
    if (!isDirPath(stage.c_str())) return rec;

    std::vector<std::string> olds, news, trials, bads;
    DIR* d = opendir(stage.c_str());
    if (d == nullptr) return rec;
    struct dirent* e;
    while ((e = readdir(d)) != nullptr) {
        const std::string n(e->d_name);
        if (n.size() <= 4) continue;  // ".old"/".new" no minimo com nome
        const std::string suffix = n.substr(n.size() - 4);
        const std::string base = n.substr(0, n.size() - 4);
        if (suffix == ".old") olds.push_back(base);
        else if (suffix == ".new") news.push_back(base);
        else if (suffix == ".bad") bads.push_back(base);
        else if (n.size() > 6 && n.compare(n.size() - 6, 6, ".trial") == 0)
            trials.push_back(n.substr(0, n.size() - 6));
    }
    closedir(d);

    // Trial primeiro: o .old de um update nao confirmado nao e "sobra".
    for (const auto& base : trials) {
        const std::string dest = root + "/" + base;
        const std::string oldDir = stage + "/" + base + ".old";
        if (!existsPath(oldDir.c_str())) {
            unlink(trialPath(stage, base).c_str());  // orfao: nada a reverter
            continue;
        }
        if (!existsPath(dest.c_str())) {
            // Queda entre os dois renames: a versao nova nao chegou a existir
            // no destino; volta a antiga.
            if (rename(oldDir.c_str(), dest.c_str()) == 0) {
                rec.restored++;
                if (rec.revertedName[0] == '\0')
                    snprintf(rec.revertedName, sizeof(rec.revertedName), "%s", base.c_str());
            }
            unlink(trialPath(stage, base).c_str());
            continue;
        }
        if (lastBootUnstable) {
            // O boot anterior nao chegou a estabilizar com a versao nova:
            // devolve a que rodava.
            if (revertTrialLocked(dest)) {
                rec.reverted++;
                if (rec.revertedName[0] == '\0')
                    snprintf(rec.revertedName, sizeof(rec.revertedName), "%s", base.c_str());
            }
        } else {
            rec.pending++;  // aguarda o primeiro lancamento limpo
        }
        olds.erase(std::remove(olds.begin(), olds.end(), base), olds.end());
    }

    // .old sem trial: se o destino sumiu, e a ultima copia que rodou.
    for (const auto& base : olds) {
        if (existsPath(trialPath(stage, base).c_str())) continue;  // revert falhou
        const std::string dest = root + "/" + base;
        const std::string oldDir = stage + "/" + base + ".old";
        if (existsPath(dest.c_str())) {
            if (rmRf(oldDir)) rec.completed++;  // troca concluida: so a sobra
        } else if (rename(oldDir.c_str(), dest.c_str()) == 0) {
            rec.restored++;  // queda entre os dois renames: volta o antigo
        }
    }
    // .new so e promovido pelo installZip, que validou o pacote inteiro.
    for (const auto& base : news) {
        if (rmRf(stage + "/" + base + ".new")) rec.dropped++;
    }
    // .bad e sobra de um revert interrompido (a versao ruim ja saiu do ar).
    for (const auto& base : bads) rmRf(stage + "/" + base + ".bad");

    unlink((stage + "/journal.txt").c_str());  // diagnostico, nao estado
    rmdir(stage.c_str());                      // so sai se vazio
    return rec;
}

// Journal best-effort: se a queda for entre os dois renames, o proximo boot
// ve "swap". O estado real esta nos diretorios — o journal nunca e a unica
// fonte (por isso a recuperacao varre o staging em vez de confiar nele).
void writeJournal(const std::string& stage, const std::string& base, const char* phase) {
    FILE* j = fopen((stage + "/journal.txt").c_str(), "w");
    if (j == nullptr) return;
    fprintf(j, "base=%s\nphase=%s\n", base.c_str(), phase);
    fclose(j);
}

}  // namespace

Recovery recover(const char* appsDir, bool lastBootUnstable) {
    if (appsDir == nullptr) return Recovery{};
    std::lock_guard<std::mutex> lock(s_installMux);
    return recoverLocked(std::string(appsDir), lastBootUnstable);
}

bool trialPending(const char* destDir) {
    if (destDir == nullptr) return false;
    std::lock_guard<std::mutex> lock(s_installMux);
    const std::string dest(destDir);
    const size_t slash = dest.find_last_of('/');
    if (slash == std::string::npos) return false;
    const std::string stage = dest.substr(0, slash) + "/.install";
    const std::string base = dest.substr(slash + 1);
    return existsPath(trialPath(stage, base).c_str());
}

bool commitTrial(const char* destDir) {
    if (destDir == nullptr) return false;
    std::lock_guard<std::mutex> lock(s_installMux);
    return commitTrialLocked(std::string(destDir));
}

bool revertTrial(const char* destDir) {
    if (destDir == nullptr) return false;
    std::lock_guard<std::mutex> lock(s_installMux);
    return revertTrialLocked(std::string(destDir));
}

bool installZip(const char* zipPath, const char* destDir, Result* out) {
#ifndef CELER_HOST_TEST
    setupDeviceAlloc();
#endif
    // Shell e svchost podem instalar ao mesmo tempo (NVS/servico): um staging
    // compartilhado fazia um apagar o do outro. Serializa a instalacao.
    std::lock_guard<std::mutex> installLock(s_installMux);
    Result r;
    if (out) *out = r;
    if (zipPath == nullptr || destDir == nullptr) return false;
    const std::string dest(destDir);
    // Staging FORA de /apps: <dest>.new colidia com um app legitimo chamado
    // "A.new"/"A.old" (nome com ponto e aceito) e o rmRf apagava o outro app.
    // .install e oculto (o launcher ja pula entradas com '.').
    const size_t slash = dest.find_last_of('/');
    const std::string parent = slash == std::string::npos ? std::string(".") : dest.substr(0, slash);
    const std::string base = slash == std::string::npos ? dest : dest.substr(slash + 1);
    const std::string stage = parent + "/.install";
    // Uma instalacao anterior interrompida e resolvida ANTES de apagar
    // qualquer .old (o rmRf abaixo podia destruir a unica copia do app).
    recoverLocked(parent, false);
    // Um trial pendente desta base e superado pela versao nova: confirma o
    // anterior (remove o .old) antes de abrir espaco para o proximo.
    commitTrialLocked(dest);
    if (!mkdirP(stage)) return false;
    const std::string newDir = stage + "/" + base + ".new";
    const std::string oldDir = stage + "/" + base + ".old";

    // 1. Validacao INTEIRA antes de tocar o disco de destino. O Reader vai
    //    pro heap (~8,4 KB de central directory): na stack nao cabe nem na
    //    task do canal (8 KB) nem na do shell (6 KB).
    appzip::Reader* zp = appzip::newReader();
    if (zp == nullptr) return false;
    appzip::Reader& z = *zp;
    bool ok = z.open(zipPath);
    int n = z.count();
    ok = ok && n > 0;  // zip vazio nao e pacote
    const Caps caps = effectiveCaps();
    bool hasAppJson = false;
    uint64_t total = 0;
    for (int i = 0; ok && i < n; i++) {
        appzip::Entry e;
        if (!z.stat(i, &e)) { ok = false; break; }
        if (e.isDir) continue;
        if (e.uncompSize > caps.file) { ok = false; break; }
        total += e.uncompSize;
        if (total > caps.total) { ok = false; break; }
        if (strcmp(e.name, "app.json") == 0) hasAppJson = true;
    }
    if (ok && !hasAppJson) ok = false;  // sem app.json nao e pacote

    // 2. Extracao em <dest>.new
    if (ok) {
        // Journal so depois do pacote validado: uma recusa de validacao nao
        // deixa "extract" pendente no staging.
        writeJournal(stage, base, "extract");
        // Staging limpo: se o .new de uma tentativa anterior nao pode ser
        // removido, seguir em frente publicaria arquivos velhos misturados
        // com o pacote novo (mkdirP devolve true so por a pasta existir)
        if (existsPath(newDir.c_str()) && !rmRf(newDir)) ok = false;
        if (ok) ok = mkdirP(newDir);
    }
    std::string appJsonPath;
    for (int i = 0; ok && i < n; i++) {
        appzip::Entry e;
        if (!z.stat(i, &e)) { ok = false; break; }
        if (e.isDir) {
            ok = mkdirP(newDir + "/" + e.name);  // nome com '/' final
            continue;
        }
        std::string file;
        ok = makeParentOf(newDir, e.name, &file) && z.extractTo(i, file.c_str());
        if (ok) {
            r.files++;
            r.bytes += e.uncompSize;
        }
        if (ok && strcmp(e.name, "app.json") == 0) appJsonPath = file;
    }

    // 3. Contrato do app.json: o entry declarado existe e o manifesto passa
    //    pelas MESMAS regras do runtime (AppManifest). `system` + packageName
    //    decidem se o update ganha health check (guarda o .old para reverter).
    bool trialApp = false;
    if (ok) {
        std::string appJson;
        ok = !appJsonPath.empty() && readSmall(appJsonPath.c_str(), &appJson, 16 * 1024);
        if (ok) {
            const celer::AppManifest mf = celer::parseAppManifest(appJson);
            trialApp = mf.isSystem && criticalTrialApp(mf.id);
            ok = !mf.mainInvalid && existsPath((newDir + "/" + mf.main).c_str());
        }
    }

    // 4. Troca com rollback: dest -> .old, .new -> dest; qualquer falha
    //    devolve o app antigo inteiro.
    if (ok) {
        writeJournal(stage, base, "swap");  // a queda aqui e recuperada no boot
        rmRf(oldDir);
        const bool hadOld = existsPath(dest.c_str());
        if (hadOld && rename(dest.c_str(), oldDir.c_str()) != 0) {
            ok = false;
        } else if (rename(newDir.c_str(), dest.c_str()) != 0) {
            if (hadOld) rename(oldDir.c_str(), dest.c_str());  // rollback
            ok = false;
        }
        if (ok) {
            if (trialApp && hadOld) {
                // App do caminho de reparo atualizado: guarda a versao
                // anterior ate a nova abrir limpa (commitTrial) ou falhar
                // (revertTrial). O boot tambem decide: instavel = volta o .old.
                writeTrial(stage, base);
            } else {
                // App comum: a loja reinstala; guardar copia so consumiria o
                // LittleFS apertado da CYD.
                rmRf(oldDir);
            }
        }
    }

    if (!ok) rmRf(newDir);  // dest/.old ficam intactos
    unlink((stage + "/journal.txt").c_str());  // sucesso ou rollback: nada pendente
    rmdir(stage.c_str());   // staging vazio sai; com resto, o proximo boot limpa
    z.close();
    appzip::freeReader(zp);
    r.ok = ok;
    if (out) *out = r;
    return ok;
}

}  // namespace celer::apppkg
