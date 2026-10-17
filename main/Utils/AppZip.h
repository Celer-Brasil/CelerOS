#ifndef APP_ZIP_H
#define APP_ZIP_H

#include <stdint.h>
#include <stddef.h>

/**
 * @file AppZip.h
 * @brief Leitor de ZIP para o pacote unico de app (.zip que o hub ja produz
 * no publish): anda pelo central directory e infla cada entrada com o tinfl
 * do miniz vendored (LovyanGFX, lgfx_*) em streaming — o buffer de saida de
 * 32 KB e o proprio dicionario LZ, entao uma entrada maior que a RAM extrai
 * sem carregar o zip inteiro.
 *
 * POSIX puro (os pontos de montagem /local e /sd sao VFS real), e por isso o
 * MESMO codigo roda no host (test/cpp). Metodos suportados: 0 (stored) e 8
 * (deflate); zip com comentario > 4 KB, criptografado ou com mais de
 * kMaxEntries entra por erro. Uso single-thread (lseek+read no proprio fd).
 */

namespace celer::appzip {

constexpr int kMaxEntries = 64;   // o lint permite 18 arquivos + extras
constexpr int kMaxName = 112;     // "<pkg>/main.js", "<pkg>/img/fundo.bin"...

struct Entry {
    char name[kMaxName];
    uint32_t uncompSize;
    uint16_t method;   // 0 = stored, 8 = deflate
    bool isDir;
};

/** Janela do tinfl (~43 KB): malloc no host; no device o AppPackage aponta
 *  para heap_caps PSRAM-first antes do 1o open. O padrao e malloc/free. */
void setAllocator(void* (*alloc)(size_t), void (*freeFn)(void* p));

/** true se o nome de entrada e seguro para extrair: nao vazio, cabe em
 *  kMaxName, ASCII imprimivel, sem barra invertida, sem barra inicial, sem
 *  segmento ".." (tokenizado por '/'). isDirOut (opcional) = termina em '/'. */
bool nameSafe(const char* name, bool* isDirOut);

class Reader {
public:
    Reader() = default;
    ~Reader();
    Reader(const Reader&) = delete;
    Reader& operator=(const Reader&) = delete;

    /** Abre o zip e le o EOCD + central directory para RAM. false em zip
     *  ausente, truncado, sem EOCD alcançavel (comentario > 4 KB) ou com
     *  entrada demais. Zip VAZIO (0 entradas) abre com count() == 0. */
    bool open(const char* path);
    void close();
    bool isOpen() const { return m_fd >= 0; }
    int count() const { return m_n; }
    /** Preenche out com a entrada idx (idx < count()). */
    bool stat(int idx, Entry* out) const;

    /** Extrai a entrada idx para destPath (cria/substitui o arquivo; pastas
     *  ficam por conta do chamador). Confere o tamanho declarado e o CRC32
     *  do central directory; falha deixa o destino truncado (o chamador
     *  extrai para um diretorio .new e so entao publica — AppPackage). */
    bool extractTo(int idx, const char* destPath) const;

private:
    struct Cd {
        uint32_t localOff;
        uint32_t compSize;
        uint32_t uncompSize;
        uint32_t crc;
        uint16_t method;
        bool isDir;
        char name[kMaxName];
    };
    bool preadExact(uint8_t* dst, uint32_t off, uint32_t len) const;

    Cd m_cd[kMaxEntries];
    int m_n = 0;
    int m_fd = -1;
};

/** Reader no alocador corrente: a classe carrega o central directory
 *  (~8,4 KB) e NAO cabe na stack das tasks do shell/canal (6-8 KB — o
 *  `installzip` por elas estourava). freeReader() sempre depois, mesmo
 *  quando open() falha (null se sem memoria). */
Reader* newReader();
void freeReader(Reader* r);

}  // namespace celer::appzip

#endif  // APP_ZIP_H
