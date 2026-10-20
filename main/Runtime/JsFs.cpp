#include "JSBindings.h"
#include "../USBDevice/LogSink.h"
#include "../Display/Layout.h"
#include "../FileSystem/FileSystem.h"
#include "../UI/Keyboard.h"
#include "../WebManager/WebManager.h"
#include "../WebManager/WebAuth.h"
#include "../Kernel/TimeManager.h"
#include "../Utils/StrUtils.h"
#include "../Utils/PinStore.h"
#include "HttpClient.h"
#include "SystemInfo.h"
#include "esp_rom_md5.h"
#include "../Display/Backlight.h"
#include "../Display/Theme.h"
#include "../Display/Icon.h"
#include "../OTA/OtaManager.h"
#include "../Launcher/LauncherUI.h"
#include "../Launcher/Screens.h"
#include <lgfx/v1/misc/DataWrapper.hpp>
#include "JsInternal.h"
#include "JsFsJail.h"
#include <stdio.h>
#include <unistd.h>
#include <dirent.h>

// =====================================================
// FileSystem Bindings
// =====================================================

// Operacoes de CONTEUDO em arquivo do sistema sem a capability "system":
// erro legivel (o app ve a causa em vez de um null misterioso).
static void fsDeny(duk_context *ctx, const char* path) {
    // PRE-FORMATADO e duk_error SEM argumentos de conversao: throw com
    // %s/%d a partir de um lightfunc corrompe o heap (ver JsGpio.cpp)
    char msg[192];
    snprintf(msg, sizeof(msg),
             "FS: acesso negado a %s (arquivo do sistema, pasta de apps ou dados de outro app)", path);
    jsThrowMsg(ctx, DUK_ERR_ERROR, msg);
}

duk_ret_t JSBindings::js_readTextFile(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    if (!fsPathAllowed(path)) fsDeny(ctx, path);
    // Antes: FileSystem::readTextFile devolvia std::string e o
    // duk_push_string copiava tudo DE NOVO para o heap Duktape; um app com
    // permissao fs podia pedir /sd/video.mp4 e o resize sem excecoes
    // abortava o aparelho. Agora malloc + jsPushOwnedString (uma copia) com
    // teto: 256 KB cobre o all.json da Loja (~58 KB) e texto de app.
    constexpr long kMaxText = 256 * 1024;
    JSBindings::present();  // leitura grande (SD): quadro antes
    FILE* f = fopen(path, "rb");
    if (f == nullptr) { duk_push_null(ctx); return 1; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) { fclose(f); duk_push_null(ctx); return 1; }
    if (sz > kMaxText) {
        fclose(f);
        char msg[96];
        snprintf(msg, sizeof(msg), "FS.readTextFile: arquivo acima de %ld KB", kMaxText / 1024);
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
        return 0;
    }
    char* buf = (char*)malloc((size_t)sz + 1);
    if (buf == nullptr) {
        fclose(f);
        jsThrowMsg(ctx, DUK_ERR_ERROR, "FS.readTextFile: sem RAM para o arquivo");
        return 0;
    }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[got] = '\0';
    CelerKernel::noteAppYield();  // tempo NATIVO da leitura
    return jsPushOwnedString(ctx, buf, got);
}

duk_ret_t JSBindings::js_writeTextFile(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    if (!fsWriteAllowed(path)) fsDeny(ctx, path);
    // o writeTextFile monta "<path>.tmp" num std::string: path absurdo
    // (app hostil) abortaria o aparelho no -fno-exceptions
    if (strlen(path) > kJsPathMax) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "FS: caminho longo demais");
    }
    const char *content = duk_require_string(ctx, 1);
    bool success = jsBlocking([&] { return FileSystem::writeTextFile(path, content); });
    duk_push_boolean(ctx, success);
    return 1;
}

duk_ret_t JSBindings::js_deleteFile(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    if (!fsWriteAllowed(path)) fsDeny(ctx, path);
    bool success = FileSystem::deleteFile(path);
    duk_push_boolean(ctx, success);
    return 1;
}

duk_ret_t JSBindings::js_fileExists(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    bool exists = fsPathAllowed(path) && FileSystem::exists(path);
    duk_push_boolean(ctx, exists);
    return 1;
}

// Le o diretorio direto para o array JS: sem teto (o vetor fixo de 128
// cortava pastas grandes em silencio) e sem std::string intermediaria.
// Montar o array pode lancar (sem RAM): roda em duk_safe_call e o DIR* e
// fechado de qualquer jeito.
struct ListDirArgs {
    DIR* dir;
    const char* path;
};

static duk_ret_t listDirPush(duk_context *ctx, void *udata) {
    ListDirArgs* a = (ListDirArgs*)udata;
    const size_t plen = strlen(a->path);
    const bool slash = plen > 0 && a->path[plen - 1] == '/';
    duk_push_array(ctx);
    duk_uarridx_t n = 0;
    struct dirent* ent;
    while ((ent = readdir(a->dir)) != nullptr) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        duk_push_string(ctx, a->path);
        if (!slash) duk_push_string(ctx, "/");
        duk_push_string(ctx, ent->d_name);
        duk_concat(ctx, slash ? 2 : 3);
        duk_put_prop_index(ctx, -2, n++);
    }
    return 1;
}

duk_ret_t JSBindings::js_listDir(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    // "/local/." etc. e pasta privada de outro app: lista vazia (como ausente)
    present();  // chamada bloqueante (pasta grande no SD): quadro antes
    DIR* dir = fsPathAllowed(path) ? opendir(path) : nullptr;
    if (dir == nullptr) {
        duk_push_array(ctx);
        return 1;
    }
    ListDirArgs args{dir, path};
    duk_int_t rc = duk_safe_call(ctx, listDirPush, &args, 0, 1);
    closedir(dir);
    CelerKernel::noteAppYield();  // montar o array de milhares de entradas
    if (rc != DUK_EXEC_SUCCESS) duk_throw(ctx);
    return 1;
}

duk_ret_t JSBindings::js_appendTextFile(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    if (!fsWriteAllowed(path)) fsDeny(ctx, path);
    const char *content = duk_require_string(ctx, 1);
    bool ok = jsBlocking([&] { return FileSystem::appendTextFile(path, content); });
    duk_push_boolean(ctx, ok);
    return 1;
}

duk_ret_t JSBindings::js_renameFile(duk_context *ctx) {
    const char *pathFrom = duk_require_string(ctx, 0);
    const char *pathTo = duk_require_string(ctx, 1);
    if (!fsWriteAllowed(pathFrom)) fsDeny(ctx, pathFrom);
    if (!fsWriteAllowed(pathTo)) fsDeny(ctx, pathTo);
    duk_push_boolean(ctx, FileSystem::renameFile(pathFrom, pathTo));
    return 1;
}

duk_ret_t JSBindings::js_mkdir(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    if (!fsWriteAllowed(path)) fsDeny(ctx, path);  // pasta no nome de arquivo do sistema
    duk_push_boolean(ctx, FileSystem::mkdir(path));
    return 1;
}

duk_ret_t JSBindings::js_rmdir(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    if (!fsTreeWriteAllowed(path)) fsDeny(ctx, path);
    duk_push_boolean(ctx, FileSystem::rmdir(path));
    return 1;
}

duk_ret_t JSBindings::js_isDirectory(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    duk_push_boolean(ctx, fsPathAllowed(path) && FileSystem::isDirectory(path));
    return 1;
}

duk_ret_t JSBindings::js_isFile(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    duk_push_boolean(ctx, fsPathAllowed(path) && FileSystem::isFile(path));
    return 1;
}

duk_ret_t JSBindings::js_getFileSize(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    duk_push_uint(ctx, fsPathAllowed(path) ? FileSystem::getFileSize(path) : 0);
    return 1;
}

duk_ret_t JSBindings::js_getTotalSpace(duk_context *ctx) {
    const char *drive = duk_require_string(ctx, 0);
    duk_push_number(ctx, (double)FileSystem::getTotalSpace(drive));  // > 4 GB no SD
    return 1;
}

duk_ret_t JSBindings::js_getUsedSpace(duk_context *ctx) {
    const char *drive = duk_require_string(ctx, 0);
    duk_push_number(ctx, (double)FileSystem::getUsedSpace(drive));  // > 4 GB no SD
    return 1;
}

duk_ret_t JSBindings::js_getFreeSpace(duk_context *ctx) {
    const char *drive = duk_require_string(ctx, 0);
    duk_push_number(ctx, (double)FileSystem::getFreeSpace(drive));  // > 4 GB no SD
    return 1;
}

duk_ret_t JSBindings::js_getFileMD5(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    const char *path = duk_require_string(ctx, 0);
    if (!fsPathAllowed(path)) fsDeny(ctx, path);
    std::string hash = FileSystem::getFileMD5(path);
    CelerKernel::noteAppYield();  // hash de arquivo grande (SD/firmware) > 1s
    duk_push_string(ctx, hash.c_str());
    return 1;
}

duk_ret_t JSBindings::js_mountSD(duk_context *ctx) {
    present();  // chamada bloqueante: o que o app desenhou aparece antes
    bool ok = FileSystem::mountSD();  // init do cartao pode levar segundos
    CelerKernel::noteAppYield();
    duk_push_boolean(ctx, ok);
    return 1;
}

duk_ret_t JSBindings::js_unmountSD(duk_context *ctx) {
    present();  // flush/desligamento do cartao e bloqueante
    FileSystem::unmountSD();
    CelerKernel::noteAppYield();
    return 0;
}


// API 12: leitura BINARIA — cada byte do arquivo vira um char (0..255) da
// string devolvida (duk_push_lstring preserva NUL; o readTextFile antigo
// truncava no primeiro 0). maxLen opcional limita a leitura (default 16KB,
// teto 64KB: o corpo e copiado para o heap do Duktape).
duk_ret_t JSBindings::js_readFile(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    if (!fsPathAllowed(path)) fsDeny(ctx, path);
    size_t maxLen = 16 * 1024;
    if (duk_is_number(ctx, 1)) {
        maxLen = duk_require_uint(ctx, 1);
        if (maxLen > 64 * 1024) maxLen = 64 * 1024;
    }

    present();  // leitura de ate 64KB no SD: quadro antes
    FILE* f = fopen(path, "rb");
    if (f == nullptr) { duk_push_null(ctx); return 1; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) { fclose(f); duk_push_null(ctx); return 1; }
    if ((size_t)sz > maxLen) sz = maxLen;

    char* buf = (char*)malloc(sz > 0 ? sz : 1);
    if (buf == nullptr) { fclose(f); duk_push_null(ctx); return 1; }
    size_t got = fread(buf, 1, sz, f);
    fclose(f);
    CelerKernel::noteAppYield();  // tempo NATIVO da leitura
    return jsPushOwnedString(ctx, buf, got);
}

// API 12: escrita BINARIA — os bytes da string (0..255 por char) vão
// crús para o arquivo (duk_require_lstring preserva NUL). Append com o
// FS.appendTextFile (que tambem é byte-safe p/ strings com NUL).
duk_ret_t JSBindings::js_writeFile(duk_context *ctx) {
    const char *path = duk_require_string(ctx, 0);
    if (!fsWriteAllowed(path)) fsDeny(ctx, path);
    // o ".tmp" da escrita atomica era um std::string: path absurdo (app
    // hostil) abortaria o aparelho no -fno-exceptions. Buffer de pilha
    // dimensionado pelo teto (jail).
    if (strlen(path) > kJsPathMax) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "FS.writeFile: caminho longo demais");
    }
    size_t len = 0;
    const char* data = duk_require_lstring(ctx, 1, &len);
    if (len > 64 * 1024) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "FS.writeFile: maximo 64KB");
    }
    // /local: escreve ao lado e troca por rename (atomico no LittleFS, como
    // o writeTextFile) — queda de energia nao deixa o arquivo pela metade.
    // FAT do SD nao sobrescreve com rename: escrita direta.
    const bool atomic = strncmp(path, "/local/", 7) == 0;
    char tmp[kJsPathMax + 8];
    snprintf(tmp, sizeof(tmp), "%s%s", path, atomic ? ".tmp" : "");
    present();  // escrita de ate 64KB (LittleFS fragmentado): quadro antes
    FILE* f = fopen(tmp, "wb");
    if (f == nullptr) { duk_push_boolean(ctx, 0); return 1; }
    bool ok = fwrite(data, 1, len, f) == len;
    ok = fclose(f) == 0 && ok;
    if (atomic && (!ok || rename(tmp, path) != 0)) {
        unlink(tmp);
        ok = false;
    }
    CelerKernel::noteAppYield();  // tempo NATIVO da escrita/rename
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

duk_ret_t JSBindings::js_appData(duk_context *ctx) {
    // Pasta privada do app (F4): /local/data/<packageName>/ criada na
    // primeira chamada. Sem packageName no app.json devolve "".
    std::string dir = jsAppDataDir();
    if (dir.empty()) { duk_push_string(ctx, ""); return 1; }
    duk_push_string(ctx, (dir + "/").c_str());
    return 1;
}
