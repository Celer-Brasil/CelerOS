#include "AppZip.h"

#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <cstdlib>
#include <new>

// tinfl do miniz vendored (LovyanGFX). No device os prototipos bastam: o
// componente LovyanGFX compila lgfx_miniz.c (gcc, ligacao C) em todas as
// placas — incluir as implementacoes aqui daria simbolo duplicado no link.
// No host (test/cpp) o g++ nao compila o .c: as implementacoes entram NESTA
// TU (as definicoes herdam a ligacao C dos prototipos do cabecalho).
#ifdef CELER_HOST_TEST
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wextra"  // miniz vendored compilado como C++
#include "../../components/LovyanGFX/src/lgfx/utility/lgfx_miniz.c"
#pragma GCC diagnostic pop
#else
#include "../../components/LovyanGFX/src/lgfx/utility/lgfx_miniz.h"
#endif

namespace celer::appzip {

namespace {

// CRC32 do central directory (polinomio zlib; o mz_crc32 do proprio miniz
// ja esta no binario — nenhuma copia nova).
inline uint32_t zipCrc32(uint32_t crc, const uint8_t* p, size_t n) {
    return (uint32_t)lgfx_mz_crc32(crc, p, n);
}

// Alocador da janela do tinfl + do buffer do central directory. O device
// troca por heap_caps PSRAM-first (AppPackage), o padrao e malloc.
void* (*s_alloc)(size_t) = malloc;
void (*s_free)(void*) = free;

constexpr uint32_t kEocdSig = 0x06054b50u;  // "PK\5\6"
constexpr uint32_t kCdSig   = 0x02014b50u;  // "PK\1\2"
constexpr uint32_t kLocalSig = 0x04034b50u; // "PK\3\4"
constexpr uint32_t kEocdLen = 22;
constexpr uint32_t kCdLen = 46;
constexpr uint32_t kLocalLen = 30;
// Busca do EOCD para tras: 22 fixos + folga para comentario de 4 KB (o
// comentario maximo legal do zip e 64 KB; o do hub nao tem comentario —
// comentario maior que isso rejeita na abertura, de proposito).
constexpr uint32_t kEocdScan = kEocdLen + 4096;
// O tetos de pacote do lint (48/128 KB de codigo + 256 KB de assets) cabem
// com folga; um central directory maior que isso nao e um pacote nosso.
constexpr uint32_t kCdMax = 16 * 1024;

uint16_t rd16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
uint32_t rd32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

bool readAt(int fd, uint8_t* dst, uint32_t off, uint32_t len) {
    while (len > 0) {
        off_t got = lseek(fd, (off_t)off, SEEK_SET);
        if (got < 0) return false;
        ssize_t n = read(fd, dst, len);
        if (n <= 0) return false;
        dst += n;
        off += (uint32_t)n;
        len -= (uint32_t)n;
    }
    return true;
}

bool writeAll(int fd, const uint8_t* src, uint32_t len) {
    while (len > 0) {
        ssize_t n = write(fd, src, len);
        if (n <= 0) return false;
        src += n;
        len -= (uint32_t)n;
    }
    return true;
}

}  // namespace

void setAllocator(void* (*alloc)(size_t), void (*freeFn)(void* p)) {
    s_alloc = alloc;
    s_free = freeFn;
}

Reader* newReader() {
    void* m = s_alloc(sizeof(Reader));
    if (m == nullptr) return nullptr;
    return new (m) Reader();
}

void freeReader(Reader* r) {
    if (r == nullptr) return;
    r->~Reader();
    s_free(r);
}

bool nameSafe(const char* name, bool* isDirOut) {
    if (isDirOut) *isDirOut = false;
    size_t n = strlen(name);
    if (n == 0 || n >= kMaxName) return false;
    if (name[0] == '/' || name[n - 1] == '\\') return false;
    for (size_t i = 0; i < n; i++) {
        char c = name[i];
        if (c < 0x20 || c > 0x7E) return false;
        if (c == '\\') return false;
    }
    if (name[n - 1] == '/') {
        if (isDirOut) *isDirOut = true;
    } else {
        // nome de arquivo nao pode terminar em barra nem conter segmento vazio
        if (strstr(name, "//") != nullptr) return false;
    }
    // segmento ".." em qualquer posicao e traversal (tambem cobre "a/../..")
    const char* p = name;
    while ((p = strstr(p, "..")) != nullptr) {
        bool startOk = (p == name || p[-1] == '/');
        bool endOk = (p[2] == '\0' || p[2] == '/');
        if (startOk && endOk) return false;
        p += 2;
    }
    return true;
}

Reader::~Reader() { close(); }

void Reader::close() {
    if (m_fd >= 0) ::close(m_fd);
    m_fd = -1;
    m_n = 0;
}

bool Reader::preadExact(uint8_t* dst, uint32_t off, uint32_t len) const {
    return readAt(m_fd, dst, off, len);
}

bool Reader::open(const char* path) {
    close();
    m_fd = ::open(path, O_RDONLY);
    if (m_fd < 0) return false;
    off_t end = lseek(m_fd, 0, SEEK_END);
    if (end < (off_t)kEocdLen) { close(); return false; }
    uint32_t fileSize = (uint32_t)end;

    // EOCD: le a cauda e procura a assinatura de tras para frente
    uint32_t tail = fileSize < kEocdScan ? fileSize : kEocdScan;
    uint8_t* buf = (uint8_t*)s_alloc(tail);
    if (buf == nullptr) { close(); return false; }
    if (!readAt(m_fd, buf, fileSize - tail, tail)) { s_free(buf); close(); return false; }
    int found = -1;
    for (uint32_t i = tail - kEocdLen + 1; i-- > 0;) {
        if (rd32(buf + i) == kEocdSig) { found = (int)i; break; }
    }
    bool ok = false;
    do {
        if (found < 0) break;
        const uint8_t* e = buf + found;
        uint16_t entries = rd16(e + 10);
        uint32_t cdSize = rd32(e + 12);
        uint32_t cdOff = rd32(e + 16);
        if (entries > kMaxEntries) break;
        if ((uint64_t)cdOff + cdSize > fileSize) break;
        if (cdSize > kCdMax) break;
        if (entries == 0) { ok = true; break; }  // zip vazio valido

        uint8_t* cd = (uint8_t*)s_alloc(cdSize);
        if (cd == nullptr) break;
        ok = readAt(m_fd, cd, cdOff, cdSize);
        uint32_t p = 0;
        for (int i = 0; ok && i < entries; i++) {
            if (p + kCdLen > cdSize || rd32(cd + p) != kCdSig) { ok = false; break; }
            uint16_t method = rd16(cd + p + 10);
            uint32_t crc = rd32(cd + p + 16);
            uint32_t comp = rd32(cd + p + 20);
            uint32_t uncomp = rd32(cd + p + 24);
            uint16_t nameLen = rd16(cd + p + 28);
            uint16_t extraLen = rd16(cd + p + 30);
            uint16_t commLen = rd16(cd + p + 32);
            uint32_t localOff = rd32(cd + p + 42);
            if (p + kCdLen + (uint32_t)nameLen + extraLen + commLen > cdSize) { ok = false; break; }
            if (nameLen == 0 || nameLen >= kMaxName) { ok = false; break; }
            if (method != 0 && method != 8) { ok = false; break; }

            Cd& c = m_cd[m_n];
            memcpy(c.name, cd + p + kCdLen, nameLen);
            c.name[nameLen] = '\0';
            bool isDir = false;
            if (!nameSafe(c.name, &isDir)) { ok = false; break; }
            if ((uint64_t)localOff + kLocalLen > fileSize) { ok = false; break; }
            c.localOff = localOff;
            c.compSize = comp;
            c.uncompSize = uncomp;
            c.crc = crc;
            c.method = method;
            c.isDir = isDir;
            m_n++;
            p += kCdLen + nameLen + extraLen + commLen;
        }
        if (ok && m_n != entries) ok = false;  // central directory inconsistente
        s_free(cd);
    } while (false);
    s_free(buf);
    if (!ok) close();
    return ok;
}

bool Reader::stat(int idx, Entry* out) const {
    if (idx < 0 || idx >= m_n || out == nullptr) return false;
    const Cd& c = m_cd[idx];
    memset(out->name, 0, sizeof(out->name));
    strcpy(out->name, c.name);
    out->uncompSize = c.uncompSize;
    out->method = c.method;
    out->isDir = c.isDir;
    return true;
}

bool Reader::extractTo(int idx, const char* destPath) const {
    if (idx < 0 || idx >= m_n || destPath == nullptr) return false;
    const Cd& c = m_cd[idx];
    if (c.isDir) return false;

    // Cabecalho local: valida a assinatura e acha o comeco do dado (o nome e
    // o extra do cabecalho local podem diferir em tamanho do do CD — e o
    // campo do proprio cabecalho local que manda).
    uint8_t lh[kLocalLen];
    if (!preadExact(lh, c.localOff, kLocalLen)) return false;
    if (rd32(lh) != kLocalSig) return false;
    uint16_t lName = rd16(lh + 26);
    uint16_t lExtra = rd16(lh + 28);
    uint64_t dataOff = (uint64_t)c.localOff + kLocalLen + lName + lExtra;
    if (dataOff + c.compSize > 0xFFFFFFFFu) return false;

    int out = ::open(destPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out < 0) return false;

    uint32_t crc = 0;
    bool ok = false;
    uint8_t* buf = (uint8_t*)s_alloc(1024);
    if (buf != nullptr) {
        if (c.method == 0) {
            ok = true;
            for (uint32_t left = c.compSize; ok && left > 0;) {
                uint32_t chunk = left < 1024 ? left : 1024;
                ok = preadExact(buf, (uint32_t)dataOff + (c.compSize - left), chunk);
                if (ok) ok = writeAll(out, buf, chunk);
                if (ok) crc = zipCrc32(crc, buf, chunk);
                left -= chunk;
            }
            if (ok && c.compSize != c.uncompSize) ok = false;
        } else {
            // deflate em streaming: a propria janela de saida de 32 KB e o
            // dicionario LZ; quando enche, descarrega e recomeca (referencia
            // retroativa nunca passa de 32 KB). Entrada maior que a RAM
            // extrai sem nunca carregar o zip inteiro.
            lgfx_tinfl_decompressor* r = (lgfx_tinfl_decompressor*)s_alloc(sizeof(lgfx_tinfl_decompressor));
            uint8_t* dict = (uint8_t*)s_alloc(TINFL_LZ_DICT_SIZE);
            uint8_t* in = (uint8_t*)s_alloc(4096);
            ok = (r != nullptr && dict != nullptr && in != nullptr);
            if (ok) {
                lgfx_tinfl_init(r);
                uint32_t inPos = 0;    // offset no disco do proximo byte comprimido
                uint32_t inHave = 0;   // pendencia no inicio de in[] (nao consumida)
                uint32_t done = 0;
                size_t dictFill = 0;
                lgfx_tinfl_status st = TINFL_STATUS_NEEDS_MORE_INPUT;
                while (ok) {
                    if (st == TINFL_STATUS_DONE) break;
                    if (st < TINFL_STATUS_DONE) { ok = false; break; }
                    if (dictFill == TINFL_LZ_DICT_SIZE) {
                        ok = writeAll(out, dict, TINFL_LZ_DICT_SIZE);
                        if (ok) crc = zipCrc32(crc, dict, TINFL_LZ_DICT_SIZE);
                        done += TINFL_LZ_DICT_SIZE;
                        dictFill = 0;
                        continue;
                    }
                    if (st == TINFL_STATUS_HAS_MORE_OUTPUT) {
                        ok = writeAll(out, dict, dictFill);
                        if (ok) crc = zipCrc32(crc, dict, dictFill);
                        done += (uint32_t)dictFill;
                        dictFill = 0;
                        continue;
                    }
                    if (inHave < 4096 && inPos < c.compSize) {
                        uint32_t want = 4096 - inHave;
                        uint32_t left = c.compSize - inPos;
                        if (want > left) want = left;
                        ok = preadExact(in + inHave, (uint32_t)dataOff + inPos, want);
                        if (!ok) break;
                        inHave += want;
                        inPos += want;
                    }
                    size_t inBytes = inHave;
                    size_t outBytes = TINFL_LZ_DICT_SIZE - dictFill;
                    int flags = (inPos < c.compSize) ? TINFL_FLAG_HAS_MORE_INPUT : 0;
                    st = lgfx_tinfl_decompress(r, in, &inBytes, dict, dict + dictFill, &outBytes, flags);
                    if (inBytes < inHave) memmove(in, in + inBytes, inHave - inBytes);
                    inHave -= (uint32_t)inBytes;
                    dictFill += outBytes;
                    if (st == TINFL_STATUS_NEEDS_MORE_INPUT && inPos >= c.compSize && inHave == 0) {
                        ok = false;  // stream truncado no meio do bloco
                    }
                    if (done + dictFill > c.uncompSize) { ok = false; break; }  // zip bomb
                }
                if (ok && st == TINFL_STATUS_DONE && dictFill > 0) {
                    ok = writeAll(out, dict, (uint32_t)dictFill);
                    if (ok) crc = zipCrc32(crc, dict, (uint32_t)dictFill);
                    done += (uint32_t)dictFill;
                    dictFill = 0;
                }
                if (ok && done != c.uncompSize) ok = false;
            }
            if (in) s_free(in);
            if (dict) s_free(dict);
            if (r) s_free(r);
        }
        s_free(buf);
    }
    if (::close(out) != 0) ok = false;
    if (ok && crc != c.crc) ok = false;  // ultima validacao: conteudo integra
    if (!ok) ::unlink(destPath);         // nao deixa lixo truncado para tras
    return ok;
}

}  // namespace celer::appzip
