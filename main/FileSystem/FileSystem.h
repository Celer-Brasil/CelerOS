#ifndef FILE_SYSTEM_H
#define FILE_SYSTEM_H

#include <Arduino.h>
#include <string>
#include <stdint.h>
#include <time.h>

// Camada de arquivos do CelerOS sobre VFS do ESP-IDF:
//   /local/...  -> particao LittleFS ("littlefs") via esp_littlefs
//   /sd/...     -> cartao SD via sdspi + esp_vfs_fat (FATFS)
// Os prefixos que antes eram virtuais (traduzidos para fs::FS do Arduino)
// agora sao pontos de montagem reais: os caminhos resolvem direto nas APIs
// POSIX (open/opendir/stat/...).

struct FileEntry {
    std::string name;
    std::string path;
    bool isDir;
};

// Par "chave":"valor" de um objeto JSON flat (deps.json do app): o tipo e
// o parser vivem no header puro Utils/JsonMap.h (testado no host).
#include "../Utils/JsonMap.h"

class FileSystem {
public:
    static bool init();
    // true quando o LittleFS falhou ao montar neste boot (dados preservados:
    // desde a F2 nao se formata mais silenciosamente apos o primeiro mount)
    static bool localMountFailed();
    static std::string readTextFile(const char* path);
    // Atomica em /local: grava em <path>.tmp e renomeia por cima (queda de
    // energia no meio deixa o arquivo antigo intacto, nunca um pela metade)
    static bool writeTextFile(const char* path, const char* content);
    static bool exists(const char* path);
    static int listDir(const char* dirPath, std::string* resultFiles, int maxFiles);
    static int listDirectory(const char* dirPath, FileEntry* entries, int maxEntries);
    static bool copyFile(const char* srcPath, const char* dstPath);
    // Recursiva; para no PRIMEIRO erro e devolve false (disco cheio, arquivo
    // ilegivel...) — antes ignorava falhas e reportava sucesso com a copia
    // pela metade
    static bool copyDirectory(const char* srcDir, const char* destDir, void (*progressCb)(int current, int total) = nullptr);
    static int countFilesInDir(const char* dirPath);
    static std::string parseJsonValue(const std::string& json, const char* key);
    // Pares "chave":"valor" de um objeto FLAT (deps.json: {nome: versao}).
    // Ignora valores nao-string e pares soltos; devolve quantos gravou.
    static int parseJsonStringMap(const std::string& json, JsonStringPair* out, int maxPairs);
    static bool deleteFile(const char* path);
    static bool formatLittleFS();
    static bool readCalData(uint16_t* calData);
    static bool writeCalData(uint16_t* calData);
    
    // Directory Operations
    static bool mkdir(const char* path);
    static bool rmdir(const char* path);
    // Remove a pasta e tudo dentro (desinstalar app); false no primeiro erro
    static bool removeTree(const char* path);
    static bool isDirectory(const char* path);
    static bool isFile(const char* path);
    
    // Advanced File Operations
    static bool appendTextFile(const char* path, const char* content);
    static bool renameFile(const char* pathFrom, const char* pathTo);
    static size_t getFileSize(const char* path);
    static time_t getLastModified(const char* path);
    
    // Metrics
    // 64 bits: cartoes SD > 4 GB estouravam o size_t de 32 bits
    static uint64_t getTotalSpace(const char* drive);
    static uint64_t getUsedSpace(const char* drive);
    static uint64_t getFreeSpace(const char* drive);
    
    // Cryptography
    static std::string getFileMD5(const char* path);
    
    // Mounting/Formatting
    static bool mountSD();
    static void unmountSD();
    /** @brief SD montado em /sd (barato: nao toca o FatFs). */
    static bool sdMounted();
    /** @brief Contagem de livres do SD em curso (segura o volume FAT; quem
     *  nao pode esperar ate CONFIG_FATFS_TIMEOUT_MS deve adiar o acesso). */
    static bool sdScanBusy();
    static bool formatSD();
    
private:
    // Pinos do SD vem do perfil da placa (Boards/<placa>/Board.cpp) via
    // Board::profile().sd — nao existem constantes de placa aqui.
};

#endif // FILE_SYSTEM_H
