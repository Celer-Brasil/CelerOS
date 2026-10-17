#include "AppPackage.h"

#include "AppZip.h"
#include "JsonMap.h"

#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>
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

}  // namespace

bool installZip(const char* zipPath, const char* destDir, Result* out) {
#ifndef CELER_HOST_TEST
    setupDeviceAlloc();
#endif
    Result r;
    if (out) *out = r;
    if (zipPath == nullptr || destDir == nullptr) return false;
    const std::string dest(destDir);
    const std::string newDir = dest + ".new";
    const std::string oldDir = dest + ".old";

    // 1. Validacao INTEIRA antes de tocar o disco de destino
    appzip::Reader z;
    if (!z.open(zipPath)) return false;
    int n = z.count();
    bool ok = n > 0;  // zip vazio nao e pacote
    bool hasAppJson = false;
    uint64_t total = 0;
    for (int i = 0; ok && i < n; i++) {
        appzip::Entry e;
        if (!z.stat(i, &e)) { ok = false; break; }
        if (e.isDir) continue;
        if (e.uncompSize > kMaxFileUncomp) { ok = false; break; }
        total += e.uncompSize;
        if (total > kMaxTotalUncomp) { ok = false; break; }
        if (strcmp(e.name, "app.json") == 0) hasAppJson = true;
    }
    if (ok && !hasAppJson) ok = false;  // sem app.json nao e pacote

    // 2. Extracao em <dest>.new
    if (ok) {
        rmRf(newDir);
        ok = mkdirP(newDir);
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

    // 3. O entry declarado no app.json tem que existir no pacote
    if (ok) {
        std::string appJson;
        ok = !appJsonPath.empty() && readSmall(appJsonPath.c_str(), &appJson, 16 * 1024);
        if (ok) {
            JsonStringPair pairs[8];
            int np = parseJsonStringMap(appJson, pairs, 8);
            std::string entry = "main.js";
            for (int i = 0; i < np; i++) {
                if (pairs[i].key == "main" && !pairs[i].value.empty()) entry = pairs[i].value;
            }
            ok = entry.find('/') == std::string::npos && entry.find("..") == std::string::npos &&
                 existsPath((newDir + "/" + entry).c_str());
        }
    }

    // 4. Troca com rollback: dest -> .old, .new -> dest; qualquer falha
    //    devolve o app antigo inteiro.
    if (ok) {
        rmRf(oldDir);
        bool hadOld = existsPath(dest.c_str());
        if (hadOld && rename(dest.c_str(), oldDir.c_str()) != 0) {
            ok = false;
        } else if (rename(newDir.c_str(), dest.c_str()) != 0) {
            if (hadOld) rename(oldDir.c_str(), dest.c_str());  // rollback
            ok = false;
        }
        // sobra de .old nao invalida a instalacao
        if (ok) rmRf(oldDir);
    }

    if (!ok) rmRf(newDir);  // dest/.old ficam intactos
    z.close();
    r.ok = ok;
    if (out) *out = r;
    return ok;
}

}  // namespace celer::apppkg
