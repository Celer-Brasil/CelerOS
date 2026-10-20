#include "FileSystem.h"
#include "../Utils/StrUtils.h"
#include "../USBDevice/LogSink.h"
#include "../Boards/Board.h"

#include <sys/stat.h>
#include <dirent.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <vector>

#include "sdkconfig.h"
#include "esp_log.h"
#include "esp_littlefs.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "driver/sdspi_host.h"
#include "driver/spi_common.h"
#include "driver/gpio.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"

static const char* FS_TAG = "celer.fs";

#if CONFIG_CELEROS_SD_CARD
// Handle do cartao para unmount; bus SPI inicializada sob demanda
static sdmmc_card_t* s_sd_card = nullptr;
static bool s_spi_bus_ready = false;

// Contagem de clusters livres do FAT. Com o FSInfo do cartao valido o
// f_getfree e instantaneo; invalido (0xFFFFFFFF), o FatFs varre a FAT
// INTEIRA — no SDSPI e 1 CMD17 por setor: um cartao de 32 GB com cluster
// de 4 KB passou de 45 s (bancada esp32-cam 2026-10-10). Na task main isso
// estourava o task WDT (15 s) a cada boot via LogPersist, e a varredura,
// morta no meio, nunca chegava a gravar o FSInfo: crash-loop permanente.
// Agora a varredura roda UMA vez por montagem numa task propria; quando
// termina o FatFs guarda a contagem (f_getfree vira O(1)) e o proximo sync
// de escrita grava o FSInfo — boots seguintes nem varrem.
static volatile bool s_sdFreeReady = false;  // contagem em cache no FatFs
static volatile bool s_sdFreeBusy = false;   // varredura em curso (segura o volume)

// Pedido de formato (NVS) — "sd format" grava e reinicia: o cartao responde
// de forma confiavel SO NO BOOT (um init depois de um mount falho nao o
// traz de volta: send_if_cond devolve 0x108), entao o formato acontece no
// mount de boot com format_if_mount_failed.
static bool sdFormatFlagGet() {
    nvs_handle_t h;
    if (nvs_open("fs", NVS_READONLY, &h) != ESP_OK) return false;
    uint8_t v = 0;
    nvs_get_u8(h, "sd_fmt", &v);
    nvs_close(h);
    return v != 0;
}
static void sdFormatFlagSet(bool on) {
    nvs_handle_t h;
    if (nvs_open("fs", NVS_READWRITE, &h) != ESP_OK) return;
    if (on) nvs_set_u8(h, "sd_fmt", 1);
    else nvs_erase_key(h, "sd_fmt");
    nvs_commit(h);
    nvs_close(h);
}
static bool s_sdFormatNext = false;          // mount corrente formata (pedido do NVS)

static void sdFreeScanTask(void*) {
    FATFS* fs = nullptr;
    DWORD freeClusters = 0;
    int64_t t0 = esp_timer_get_time();
    FRESULT r = f_getfree("0:", &freeClusters, &fs);
    int ms = (int)((esp_timer_get_time() - t0) / 1000);
    if (r == FR_OK) s_sdFreeReady = true;
    if (ms > 1000) celer_log_printf("SD: contagem de livres levou %d ms (FSInfo invalido)\n", ms);
    s_sdFreeBusy = false;
    vTaskDelete(nullptr);
}
#endif
static bool s_localMountFailed = false;

// Flag NVS do primeiro mount de fabrica: sem ela, format_if_mount_failed
// apagava TUDO (apps/configs do usuario) numa corrupcao silenciosa. Agora:
// particao crua de fabrica formata UMA vez; depois disso, falha de montagem
// preserva os dados e o boot segue sem /local (toast no launcher).
static const char* NVS_NS = "celer";
static const char* NVS_FLAG = "fs_mounted";

// Inicializa a NVS com o mesmo tratamento do Storage/NVS (erase + retry).
// Sem isto, uma NVS sem paginas livres/versao nova fazia a leitura da flag
// falhar e o mount com format_if_mount_failed podia apagar /local inteiro
// (apps/configs do usuario). Retorno false = NVS nao confiavel: nesse caso
// NUNCA se formata por ausencia de flag.
static bool nvsReady() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(FS_TAG, "NVS: %s; apagando a NVS (settings voltam ao padrao)",
                 esp_err_to_name(err));
        if (nvs_flash_erase() != ESP_OK) {
            ESP_LOGE(FS_TAG, "NVS: erase falhou; /local sera preservado");
            return false;
        }
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(FS_TAG, "NVS: init falhou (%s); /local sera preservado",
                 esp_err_to_name(err));
        return false;
    }
    return true;
}

static bool littlefsEverMounted() {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return false;
    uint8_t v = 0;
    bool set = nvs_get_u8(h, NVS_FLAG, &v) == ESP_OK && v == 1;
    nvs_close(h);
    return set;
}

static void markLittlefsMounted() {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    uint8_t one = 1;
    nvs_set_u8(h, NVS_FLAG, one);
    nvs_commit(h);
    nvs_close(h);
}

bool FileSystem::localMountFailed() {
    return s_localMountFailed;
}

// O barramento do SD e sempre o SPI2 (FSPI no S3, HSPI no ESP32 classico);
// pinos e velocidade vem do perfil da placa (Boards/<placa>/Board.cpp).
#define CELEROS_SD_SPI_HOST SPI2_HOST

bool FileSystem::init() {
    bool success = true;
    const bool nvs = nvsReady();  // flag do primeiro mount (idempotente: WebManager repete)

    // --- LittleFS em /local ---
    esp_vfs_littlefs_conf_t lfsc = {};
    lfsc.base_path = "/local";
    lfsc.partition_label = "littlefs";
    // Formata so quando a NVS esta confiavel E a flag diz "nunca montou":
    // NVS ilegivel nao pode virar licenca para apagar os dados do usuario.
    lfsc.format_if_mount_failed = nvs && !littlefsEverMounted();
    lfsc.dont_mount = false;
    esp_err_t err = esp_vfs_littlefs_register(&lfsc);
    if (err != ESP_OK) {
        ESP_LOGE(FS_TAG, "LittleFS mount falhou: %s (dados preservados)",
                 esp_err_to_name(err));
        s_localMountFailed = true;
        success = false;
    } else {
        size_t total = 0, used = 0;
        esp_littlefs_info("littlefs", &total, &used);
        ESP_LOGI(FS_TAG, "LittleFS montado em /local (%u/%u usado)", (unsigned)used, (unsigned)total);
        markLittlefsMounted();
        mkdir("/local/apps");  // ignora EEXIST
    }

    // --- SD em /sd ---
    if (!mountSD()) {
        ESP_LOGW(FS_TAG, "SD Card Mount Failed");
        success = false;
    }

    return success;
}

bool FileSystem::mountSD() {
#if CONFIG_CELEROS_SD_CARD
    if (s_sd_card != nullptr) return true;

    // Host do perfil: -1 = SPI2 (classico). Placas com display no SPI2
    // (ex.: QSPI do watch) apontam o SPI3 no perfil.
    const SdConfig& sd = Board::profile().sd;
    spi_host_device_t sdHost = (sd.spiHost >= 0)
        ? (spi_host_device_t)sd.spiHost : (spi_host_device_t)CELEROS_SD_SPI_HOST;

    // RESET + PULL-UP so no CS ANTES de tocar no bus. O boot log da
    // 4848 (2026-10-18) mostrou "failed to mount card" com o CS (GPIO42)
    // preso na funcao de IOMUX de UART1 ("gpio conflict found") — um pino
    // em funcao de periferico nao responde como CS e o CMD0 nunca volta.
    // As outras 3 linhas ficam: SCK/MOSI/MISO podem pertencer a um bus SPI
    // ja em pe (compartilhado com o display no CYD/4848) e gpio_reset_pin
    // as despluga do controlador sem ninguem as reconfigurar depois.
    if (sd.cs >= 0) {
        gpio_reset_pin((gpio_num_t)sd.cs);               // IOMUX -> GPIO, pull-up
        gpio_set_pull_mode((gpio_num_t)sd.cs, GPIO_PULLUP_ONLY);
    }

    if (!s_spi_bus_ready) {
        spi_bus_config_t buscfg = {};
        buscfg.mosi_io_num = sd.mosi;
        buscfg.miso_io_num = sd.miso;
        buscfg.sclk_io_num = sd.sck;
        buscfg.quadwp_io_num = -1;
        buscfg.quadhd_io_num = -1;
        buscfg.max_transfer_sz = 4092;
        esp_err_t err = spi_bus_initialize(sdHost, &buscfg, SPI_DMA_CH_AUTO);
        if (err == ESP_ERR_INVALID_STATE) {
            // BUS COMPARTILHADO COM O DISPLAY (ex.: microSD do CYD classico,
            // que divide o HSPI com o TFT): o LovyanGFX ja inicializou o host
            // (spi_bus_initialize + spi_device_add_device no boot) e, em modo
            // IDF, adquire/libera o bus por transacao via
            // spi_device_acquire_bus. O sdspi adicionado pelo mount abaixo
            // segue o mesmo lock — as transferencias de video e de cartao se
            // serializam sozinhas. Contrato: os pinos do perfil DEVEM ser os
            // mesmos do barramento do display (a config de pinos aqui seria
            // ignorada: o host ja esta de pe com os pinos do display).
            ESP_LOGI(FS_TAG, "SPI%d ja pertence ao display: SD em bus compartilhado",
                     (int)sdHost + 1);
            s_spi_bus_ready = true;
        } else if (err != ESP_OK) {
            ESP_LOGE(FS_TAG, "spi_bus_initialize falhou: %s", esp_err_to_name(err));
            return false;
        } else {
            s_spi_bus_ready = true;
        }
    }

    // IDF 6: esp_vfs_fat_sdspi_mount continua "all-in-one" — anexa o
    // dispositivo do slot_config no bus indicado por host.slot. O detalhe
    // critico e slot.host_id: com zero-init vai para o SPI1 (flash!) e falha
    // com "invalid host".
    static bool s_isr_installed = false;
    if (!s_isr_installed) {
        gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
        s_isr_installed = true;
    }

    sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot.host_id = sdHost;
    slot.gpio_cs = (gpio_num_t)Board::profile().sd.cs;
    slot.gpio_cd = GPIO_NUM_NC;

    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = sdHost;

    esp_vfs_fat_mount_config_t mountcfg = {};
    s_sdFormatNext = sdFormatFlagGet();   // "sd format" pediu: formata no boot
    mountcfg.format_if_mount_failed = s_sdFormatNext;
    mountcfg.max_files = 5;
    mountcfg.allocation_unit_size = 16 * 1024;

    // Tentativa 1 no clock do perfil; tentativa 2 em 400 kHz. Cartao
    // grande/oxidado responde CMD no clock baixo e o mount degrade so o
    // throughput (nao sobe de volta sozinho: o proximo boot tenta 1o).
    const int kHz[2] = { (Board::profile().sd.freqKhz > 0) ? Board::profile().sd.freqKhz : 4000, 400 };
    esp_err_t err = ESP_FAIL;
    esp_err_t err1 = ESP_FAIL;
    for (int i = 0; i < 2; i++) {
        host.max_freq_khz = kHz[i];
        err = esp_vfs_fat_sdspi_mount("/sd", &host, &slot, &mountcfg, &s_sd_card);
        if (err == ESP_OK) break;
        if (i == 0) err1 = err;
        ESP_LOGW(FS_TAG, "sdspi mount falhou a %d kHz: %s", kHz[i],
                 esp_err_to_name(err));
        s_sd_card = nullptr;
        if (i == 0) {
            // CS de volta ao GPIO com pull-up e DESELECIONADO antes da 2a
            // tentativa (o mount falho pode ter deixado o CS em IOMUX).
            // SCK/MISO/MOSI ficam intocados: resetar as linhas do bus aqui
            // as despluga do controlador SPI (o spi_bus_initialize nao roda
            // de novo) e a 2a tentativa jamais veria o cartao — era o 0x108
            // em TODO retry, inclusive no FS.mountSD() de runtime, que
            // sustentou a conclusao errada de que "o cartao so responde no
            // boot" (4848, 2026-10-18).
            if (sd.cs >= 0) {
                gpio_reset_pin((gpio_num_t)sd.cs);
                gpio_set_pull_mode((gpio_num_t)sd.cs, GPIO_PULLUP_ONLY);
                gpio_set_direction((gpio_num_t)sd.cs, GPIO_MODE_OUTPUT);
                gpio_set_level((gpio_num_t)sd.cs, 1);    // desseleciona
            }
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }
    if (err != ESP_OK) {
        if (err1 == ESP_FAIL)
            // o card init passou e o f_mount devolveu FR_NO_FILESYSTEM (13):
            // exFAT ou virgem (o FatFs do IDF nao le exFAT)
            ESP_LOGW(FS_TAG, "SD: cartao OK mas SEM volume FAT32 (exFAT ou "
                             "virgem) — `sd format` formata (APAGA TUDO)");
        else
            ESP_LOGW(FS_TAG, "SD: cartao sem resposta (%s) — veja contato/"
                             "cartao", esp_err_to_name(err1));
        if (s_sdFormatNext)
            ESP_LOGW(FS_TAG, "SD: pedido de formato segue para o proximo boot");
        return false;
    }
    if (s_sdFormatNext) {
        sdFormatFlagSet(false);
        ESP_LOGI(FS_TAG, "SD formatado no boot (FAT32) e montado");
    }
    ESP_LOGI(FS_TAG, "SD montado em /sd (%s)", s_sd_card->cid.name);
    // Contagem de livres fora do caminho de quem chamou (ver sdFreeScanTask).
    // Prioridade 1, sem pino de nucleo (CYD/cam unicore ou dual).
    s_sdFreeReady = false;
    s_sdFreeBusy = true;
    if (xTaskCreate(sdFreeScanTask, "sd_free", 3072, nullptr, 1, nullptr) != pdPASS) {
        s_sdFreeBusy = false;  // sem RAM p/ a task: espaco do SD fica "desconhecido"
    }
    // Layout padrao do cartao, o mesmo trato do mkdir("/local/apps"): o
    // launcher, Installer, App Store e o celerctl (apps list) escaneiam
    // /sd/apps. Sem a pasta, um cartao de dados puro (gcode, wallpaper)
    // montava numa boa mas o celerctl rotulava "sd: sem cartao".
    mkdir("/sd/apps");  // ignora EEXIST
    return true;
#else
    return false;
#endif
}

void FileSystem::unmountSD() {
#if CONFIG_CELEROS_SD_CARD
    if (s_sd_card != nullptr) {
        // varredura segurando o volume: desmontar no meio dela solta o FATFS
        // debaixo do f_getfree
        while (s_sdFreeBusy) vTaskDelay(pdMS_TO_TICKS(50));
        esp_vfs_fat_sdcard_unmount("/sd", s_sd_card);
        s_sd_card = nullptr;
        s_sdFreeReady = false;
    }
#endif
}

bool FileSystem::formatSD() {
#if CONFIG_CELEROS_SD_CARD
    // DESTRUTIVO: so pelo comando explicito do shell ("sd format") ou da Web
    // UI — o mount normal NUNCA formata (o cartao do usuario pode ter dados
    // legiveis no PC, mesmo exFAT). O cartao responde de forma confiavel so
    // no boot (o re-init apos um mount falho nao o traz de volta), entao o
    // pedido vai em NVS e o aparelho reinicia: o mount de boot formata em
    // FAT32 (format_if_mount_failed) e limpa o pedido.
    sdFormatFlagSet(true);
    return true;
#else
    return false;
#endif
}

// ---------------------------------------------------------------------------
// Helpers locais
// ---------------------------------------------------------------------------

static bool pathOk(const char* path) {
    // O prefixo tem que ser um SEGMENTO inteiro: "/localfoo"/"/sdcard"
    // passavam no strncmp e caíam fora do jail (F6).
    if (path == nullptr) return false;
    if (strncmp(path, "/local", 6) == 0) return path[6] == '\0' || path[6] == '/';
    if (strncmp(path, "/sd", 3) == 0) return path[3] == '\0' || path[3] == '/';
    return false;
}

std::string FileSystem::readTextFile(const char* path) {
    if (!pathOk(path)) return "";

    FILE* f = fopen(path, "rb");
    if (f == nullptr) return "";

    struct stat st;
    if (fstat(fileno(f), &st) != 0 || st.st_size <= 0 || S_ISDIR(st.st_mode)) {
        fclose(f);
        return "";
    }

    // Sem excecoes, o new do std::string ABORTA quando nao ha bloco contiguo
    // (sem PSRAM + heap fragmentado: FS.readTextFile de arquivo grande
    // derrubava o aparelho). Sonda com alocacao real (o TLSF pode recusar
    // mesmo com o "maior bloco livre" acima); sem bloco: "" como ilegivel.
    void* probe = malloc((size_t)st.st_size + 1);
    free(probe);
    if (probe == nullptr) {
        fclose(f);
        celer_log_printf("readTextFile: sem bloco p/ %u B (%s)\n", (unsigned)st.st_size, path);
        return "";
    }

    // UMA leitura direto no destino: em fatias de 512 B cada fread virava
    // uma ida ao VFS/LittleFS (~100 por modulo de 48 KB) mais a copia do
    // buffer de pilha para a string
    std::string content;
    content.resize((size_t)st.st_size);
    size_t total = 0;
    while (total < content.size()) {
        size_t n = fread(&content[total], 1, content.size() - total, f);
        if (n == 0) break;
        total += n;
    }
    content.resize(total);

    fclose(f);
    return content;
}

bool FileSystem::writeTextFile(const char* path, const char* content) {
    if (!pathOk(path) || content == nullptr) return false;

    // LittleFS: rename sobre arquivo existente e atomico (troca de metadados),
    // entao escreve ao lado e troca. No FAT do SD rename nao sobrescreve:
    // escrita direta (como antes).
    const bool atomic = strncmp(path, "/local", 6) == 0;
    std::string tmp = atomic ? std::string(path) + ".tmp" : std::string(path);

    FILE* f = fopen(tmp.c_str(), "wb");
    if (f == nullptr) return false;

    size_t len = strlen(content);
    bool ok = (fwrite(content, 1, len, f) == len);
    ok = (fclose(f) == 0) && ok;  // fclose faz o flush: erro de disco cheio aparece aqui
    if (!atomic) return ok;
    if (!ok || rename(tmp.c_str(), path) != 0) {
        unlink(tmp.c_str());
        return false;
    }
    return true;
}

bool FileSystem::writeFileAtomic(const char* path, const void* data, size_t len) {
    if (!pathOk(path) || (data == nullptr && len > 0)) return false;
    // Buffer fixo: std::string num caminho de escrita pode abortar sem
    // excecoes quando a RAM aperta (CYD). Mesmo teto pratico do jail.
    char tmp[300];
    const int n = snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    if (n < 0 || (size_t)n >= sizeof(tmp)) return false;
    FILE* f = fopen(tmp, "wb");
    if (f == nullptr) return false;
    const bool wrote = (len == 0) || (fwrite(data, 1, len, f) == len);
    const bool closed = fclose(f) == 0;  // flush: disco cheio aparece aqui
    if (!wrote || !closed) {
        unlink(tmp);
        return false;
    }
    // LittleFS troca por rename (atomico). FAT nao renomeia por cima: so
    // remove o destino DEPOIS do tmp completo (a janela sem arquivo e do
    // FAT, nao do LittleFS).
    if (rename(tmp, path) == 0) return true;
    if (strncmp(path, "/local", 6) == 0) {
        unlink(tmp);
        return false;
    }
    // FAT: so remove o destino se ele realmente existe (erro de permissao/
    // caminho nao pode virar perda do arquivo antigo).
    struct stat st;
    if (stat(path, &st) != 0 || S_ISDIR(st.st_mode)) {
        unlink(tmp);
        return false;
    }
    if (unlink(path) != 0) {
        unlink(tmp);
        return false;
    }
    return rename(tmp, path) == 0;
}

bool FileSystem::appendTextFile(const char* path, const char* content) {
    if (!pathOk(path) || content == nullptr) return false;

    FILE* f = fopen(path, "ab");
    if (f == nullptr) return false;

    size_t len = strlen(content);
    bool ok = (fwrite(content, 1, len, f) == len);
    fclose(f);
    return ok;
}

bool FileSystem::exists(const char* path) {
    if (!pathOk(path)) return false;
    struct stat st;
    return stat(path, &st) == 0;
}

bool FileSystem::deleteFile(const char* path) {
    if (!pathOk(path)) return false;
    return unlink(path) == 0;
}

bool FileSystem::formatLittleFS() {
    ESP_LOGI(FS_TAG, "Formatando LittleFS...");
    return esp_littlefs_format("littlefs") == ESP_OK;
}

int FileSystem::listDir(const char* dirPath, std::string* resultFiles, int maxFiles) {
    if (dirPath == nullptr || resultFiles == nullptr) return 0;

    DIR* dir = opendir(dirPath);
    if (dir == nullptr) return 0;

    int count = 0;
    struct dirent* ent;
    while ((ent = readdir(dir)) != nullptr && count < maxFiles) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;

        std::string fullPath = dirPath;
        if (!kstr::endsWith(fullPath, "/")) fullPath += "/";
        fullPath += ent->d_name;
        resultFiles[count++] = fullPath;
    }
    closedir(dir);
    return count;
}

int FileSystem::listDirectory(const char* dirPath, FileEntry* entries, int maxEntries) {
    if (dirPath == nullptr || entries == nullptr) return 0;

    DIR* dir = opendir(dirPath);
    if (dir == nullptr) return 0;

    int count = 0;
    struct dirent* ent;
    while ((ent = readdir(dir)) != nullptr && count < maxEntries) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;

        entries[count].name = ent->d_name;

        std::string fullPath = dirPath;
        if (!kstr::endsWith(fullPath, "/")) fullPath += "/";
        fullPath += entries[count].name;
        entries[count].path = fullPath;

        if (ent->d_type == DT_DIR) {
            entries[count].isDir = true;
        } else if (ent->d_type == DT_UNKNOWN) {
            struct stat st;
            entries[count].isDir = (stat(fullPath.c_str(), &st) == 0 && S_ISDIR(st.st_mode));
        } else {
            entries[count].isDir = false;
        }

        count++;
    }
    closedir(dir);
    return count;
}

bool FileSystem::readCalData(uint16_t* calData) {
    FILE* f = fopen("/local/touch_cal_p.bin", "rb");
    if (f == nullptr) return false;
    bool ok = (fread(calData, 1, 10, f) == 10);
    fclose(f);
    return ok;
}

bool FileSystem::writeCalData(uint16_t* calData) {
    FILE* f = fopen("/local/touch_cal_p.bin", "wb");
    if (f == nullptr) return false;
    // fwrite de 10 bytes pode falhar (disco cheio): sem checar, devolvia
    // sucesso e a calibracao antiga seguia valendo no proximo boot
    bool ok = (fwrite(calData, 1, 10, f) == 10);
    fclose(f);
    return ok;
}

bool FileSystem::copyFile(const char* srcPath, const char* dstPath) {
    if (!pathOk(srcPath) || !pathOk(dstPath)) return false;

    FILE* src = fopen(srcPath, "rb");
    if (src == nullptr) return false;

    struct stat st;
    if (fstat(fileno(src), &st) == 0 && S_ISDIR(st.st_mode)) {
        fclose(src);
        return false;
    }

    // Copia ao lado e troca no fim (como o writeTextFile): o "wb" direto
    // zerava o destino e uma falha no meio (disco cheio, SD solto) apagava
    // o arquivo que existia — atualizar um app instalado o deixava sem
    // main.js. renameFile cobre o FAT (remove o destino antes).
    std::string tmp = std::string(dstPath) + ".tmp";
    FILE* dst = fopen(tmp.c_str(), "wb");
    if (dst == nullptr) {
        fclose(src);
        return false;
    }

    // 4 KB = setor/bloco tipico do FAT e do LittleFS: ~4-8x menos chamadas
    // que os 512 B de antes (instalar app do SD ficava lento)
    constexpr size_t BUF = 4096;
    uint8_t* buf = (uint8_t*)malloc(BUF);
    bool ok = buf != nullptr;
    size_t n;
    while (ok && (n = fread(buf, 1, BUF, src)) > 0) {
        if (fwrite(buf, 1, n, dst) != n) ok = false;
    }
    if (ok && ferror(src)) ok = false;
    free(buf);
    fclose(src);
    ok = (fclose(dst) == 0) && ok;
    if (ok) ok = renameFile(tmp.c_str(), dstPath);
    if (!ok) unlink(tmp.c_str());  // sem copia pela metade com cara de valida
    return ok;
}

int FileSystem::countFilesInDir(const char* dirPath) {
    DIR* dir = opendir(dirPath);
    if (dir == nullptr) return 0;

    int count = 0;
    struct dirent* ent;
    while ((ent = readdir(dir)) != nullptr) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;

        bool isDir;
        if (ent->d_type == DT_DIR) isDir = true;
        else if (ent->d_type == DT_UNKNOWN) {
            std::string full = std::string(dirPath) + "/" + ent->d_name;
            struct stat st;
            isDir = (stat(full.c_str(), &st) == 0 && S_ISDIR(st.st_mode));
        } else isDir = false;

        if (!isDir) {
            count++;
        } else {
            std::string subPath = dirPath;
            if (!kstr::endsWith(subPath, "/")) subPath += "/";
            subPath += ent->d_name;
            count += countFilesInDir(subPath.c_str());
        }
    }
    closedir(dir);
    return count;
}

namespace {
struct CopyProgress {
    int copied = 0;
    int total = 1;
    void (*cb)(int, int) = nullptr;
};

bool copyTree(const std::string& srcDir, const std::string& dstDir, CopyProgress& pr) {
    // mkdirs: o destino pode ser uma arvore nova inteira (backup/restaurar
    // para pasta que ainda nao existe) — o mkdir de um nivel so cobria o
    // ultimo componente
    if (!FileSystem::mkdirs(dstDir.c_str())) return false;
    DIR* dir = opendir(srcDir.c_str());
    if (dir == nullptr) return false;

    bool ok = true;
    struct dirent* ent;
    while (ok && (ent = readdir(dir)) != nullptr) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        std::string src = srcDir + (kstr::endsWith(srcDir, "/") ? "" : "/") + ent->d_name;
        std::string dst = dstDir + (kstr::endsWith(dstDir, "/") ? "" : "/") + ent->d_name;

        bool isDir;
        if (ent->d_type == DT_DIR) isDir = true;
        else if (ent->d_type == DT_UNKNOWN) {
            struct stat st;
            isDir = (stat(src.c_str(), &st) == 0 && S_ISDIR(st.st_mode));
        } else isDir = false;

        if (isDir) {
            ok = copyTree(src, dst, pr);
        } else {
            ok = FileSystem::copyFile(src.c_str(), dst.c_str());
            if (!ok) ESP_LOGW(FS_TAG, "copia falhou: %s -> %s", src.c_str(), dst.c_str());
            pr.copied++;
            if (pr.cb) pr.cb(pr.copied, pr.total);
            taskYIELD();
        }
    }
    closedir(dir);
    return ok;
}
}  // namespace

bool FileSystem::copyDirectory(const char* srcDir, const char* destDir, void (*progressCb)(int current, int total)) {
    if (!srcDir || !destDir || !pathOk(srcDir) || !pathOk(destDir)) return false;
    CopyProgress pr;
    pr.total = countFilesInDir(srcDir);
    if (pr.total <= 0) pr.total = 1;
    pr.cb = progressCb;
    return copyTree(srcDir, destDir, pr);
}

std::string FileSystem::parseJsonValue(const std::string& json, const char* key) {
    std::string searchKey = std::string("\"") + key + "\"";
    int keyIdx = kstr::indexOf(json, searchKey);
    if (keyIdx == -1) return "";

    int colonIdx = kstr::indexOf(json, ':', keyIdx + (int)searchKey.length());
    if (colonIdx == -1) return "";

    int valStart = colonIdx + 1;
    while (valStart < (int)json.length() && (json[valStart] == ' ' || json[valStart] == '\t')) valStart++;

    if (valStart >= (int)json.length()) return "";

    if (json[valStart] == '"') {
        // Fecha a string respeitando escapes (\" e \\): antes a primeira
        // aspa escapada encerrava o valor (update.json com URL/version
        // contendo \" quebrava o OTA silenciosamente)
        int valEnd = -1;
        for (int i = valStart + 1; i < (int)json.length(); ++i) {
            char c = json[i];
            if (c == '\\') { ++i; continue; }
            if (c == '"') { valEnd = i; break; }
        }
        if (valEnd == -1) return "";
        // Destranspila o basico do JSON (suficiente para manifests:
        // version/firmware_url/changelog nao carregam \uXXXX)
        std::string out;
        out.reserve(valEnd - valStart);
        for (int i = valStart + 1; i < valEnd; ++i) {
            if (json[i] != '\\' || i + 1 >= valEnd) { out += json[i]; continue; }
            char e = json[++i];
            switch (e) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case '/': out += '/';  break;
                default: out += e;     break;  // \\ e \" (e \x literal)
            }
        }
        return out;
    } else {
        int valEnd = valStart;
        while (valEnd < (int)json.length() && json[valEnd] != ',' && json[valEnd] != '}' && json[valEnd] != '\n') valEnd++;
        std::string val = json.substr(valStart, valEnd - valStart);
        return kstr::trim(val);
    }
}

int FileSystem::parseJsonStringMap(const std::string& json, JsonStringPair* out, int maxPairs) {
    return celer::parseJsonStringMap(json, out, maxPairs);  // Utils/JsonMap.h
}

bool FileSystem::mkdir(const char* path) {
    if (!pathOk(path)) return false;
    return ::mkdir(path, 0775) == 0 || errno == EEXIST;
}

bool FileSystem::mkdirs(const char* path) {
    if (!pathOk(path)) return false;
    // Caminha componente a componente ("/local/data/pkg/sub"): o que existe
    // tem que ser pasta DE VERDADE (o que falta nasce com 0775). O teto
    // conta so os CRIADOS: pais pre-existentes nao consomem o orcamento.
    // stat e nao lstat: o VFS do ESP-IDF nao implementa lstat, e os pontos
    // de montagem (LittleFS/FATFS/SD) nao tem symlink — no device o stat
    // e o lstat sao o mesmo teste.
    const size_t len = strlen(path);
    if (len == 0 || len >= 128) return false;
    char cur[128];
    memcpy(cur, path, len + 1);
    int created = 0;
    for (size_t i = 1; i <= len; i++) {
        if (cur[i] != '/' && cur[i] != '\0') continue;
        const char saved = cur[i];
        cur[i] = '\0';
        struct stat st;
        if (stat(cur, &st) == 0) {
            if (!S_ISDIR(st.st_mode)) return false;
        } else {
            if (++created > 10) return false;
            if (::mkdir(cur, 0775) != 0 && errno != EEXIST) return false;
        }
        cur[i] = saved;
    }
    return true;
}

bool FileSystem::rmdir(const char* path) {
    if (!pathOk(path)) return false;
    return ::rmdir(path) == 0;
}

bool FileSystem::removeTree(const char* path) {
    if (!pathOk(path)) return false;
    DIR* dir = opendir(path);
    if (dir == nullptr) return false;
    bool ok = true;
    struct dirent* ent;
    // coleta antes de apagar: remover durante o readdir pula entradas no FAT
    std::vector<std::pair<std::string, bool>> items;
    while ((ent = readdir(dir)) != nullptr) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        std::string full = std::string(path) + (kstr::endsWith(path, "/") ? "" : "/") + ent->d_name;
        bool isDir = ent->d_type == DT_DIR;
        if (ent->d_type == DT_UNKNOWN) {
            struct stat st;
            isDir = stat(full.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
        }
        items.emplace_back(full, isDir);
    }
    closedir(dir);
    for (const auto& it : items) {
        ok = it.second ? removeTree(it.first.c_str()) : (unlink(it.first.c_str()) == 0);
        if (!ok) return false;
    }
    return ::rmdir(path) == 0;
}

bool FileSystem::isDirectory(const char* path) {
    if (!pathOk(path)) return false;
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

bool FileSystem::isFile(const char* path) {
    if (!pathOk(path)) return false;
    struct stat st;
    return stat(path, &st) == 0 && !S_ISDIR(st.st_mode);
}

bool FileSystem::renameFile(const char* pathFrom, const char* pathTo) {
    if (!pathOk(pathFrom) || !pathOk(pathTo)) return false;
    if (rename(pathFrom, pathTo) == 0) return true;
    // FAT (SD) nao renomeia por cima de arquivo existente (EEXIST), ao
    // contrario do LittleFS: sem isso, atualizar app instalado no cartao
    // (main.js.new -> main.js) falhava. Remove o destino e tenta de novo —
    // nao-atomico, mas o FAT nao oferece troca atomica.
    struct stat st;
    if (stat(pathTo, &st) == 0 && !S_ISDIR(st.st_mode) && stat(pathFrom, &st) == 0 &&
        !S_ISDIR(st.st_mode) && unlink(pathTo) == 0) {
        return rename(pathFrom, pathTo) == 0;
    }
    return false;
}

size_t FileSystem::getFileSize(const char* path) {
    if (!pathOk(path)) return 0;
    struct stat st;
    if (stat(path, &st) != 0 || S_ISDIR(st.st_mode)) return 0;
    return (size_t)st.st_size;
}

time_t FileSystem::getLastModified(const char* path) {
    if (!pathOk(path)) return 0;
    struct stat st;
    if (stat(path, &st) != 0) return 0;
    return st.st_mtime;
}

bool FileSystem::sdMounted() {
#if CONFIG_CELEROS_SD_CARD
    return s_sd_card != nullptr;
#else
    return false;
#endif
}

bool FileSystem::sdScanBusy() {
#if CONFIG_CELEROS_SD_CARD
    return s_sdFreeBusy;
#else
    return false;
#endif
}

uint64_t FileSystem::getTotalSpace(const char* drive) {
    if (drive == nullptr) return 0;
#if CONFIG_CELEROS_SD_CARD
    if (strncmp(drive, "/sd", 3) == 0) {
        if (s_sd_card == nullptr) return 0;
        if (!s_sdFreeReady) {
            // contagem ainda nao pronta: o f_getfree varreria (ou esperaria o
            // lock da varredura). Capacidade crua do cartao (CSD) — difere do
            // volume FAT so pelas tabelas/area reservada.
            return (uint64_t)s_sd_card->csd.capacity * (uint64_t)s_sd_card->csd.sector_size;
        }
        FATFS* fs = nullptr;
        DWORD freeClusters = 0;
        if (f_getfree("0:", &freeClusters, &fs) != FR_OK || fs == nullptr) return 0;
        return (uint64_t)(fs->n_fatent - 2) * fs->csize * 512ULL;
    }
#endif
    if (strncmp(drive, "/local", 6) == 0) {
        size_t total = 0, used = 0;
        if (esp_littlefs_info("littlefs", &total, &used) != ESP_OK) return 0;
        return total;
    }
    return 0;
}

uint64_t FileSystem::getUsedSpace(const char* drive) {
    if (drive == nullptr) return 0;
#if CONFIG_CELEROS_SD_CARD
    if (strncmp(drive, "/sd", 3) == 0) {
        if (s_sd_card == nullptr || !s_sdFreeReady) return 0;  // desconhecido (ver getFreeSpace)
        uint64_t total = getTotalSpace(drive);
        uint64_t freeB = getFreeSpace(drive);
        return total > freeB ? (total - freeB) : 0;
    }
#endif
    if (strncmp(drive, "/local", 6) == 0) {
        size_t total = 0, used = 0;
        if (esp_littlefs_info("littlefs", &total, &used) != ESP_OK) return 0;
        return used;
    }
    return 0;
}

uint64_t FileSystem::getFreeSpace(const char* drive) {
    if (drive == nullptr) return 0;
#if CONFIG_CELEROS_SD_CARD
    if (strncmp(drive, "/sd", 3) == 0) {
        // 0 = desconhecido enquanto a varredura nao termina (a App Store ja
        // trata 0 assim; quem bloqueasse aqui travava a task main)
        if (s_sd_card == nullptr || !s_sdFreeReady) return 0;
        FATFS* fs = nullptr;
        DWORD freeClusters = 0;
        if (f_getfree("0:", &freeClusters, &fs) != FR_OK || fs == nullptr) return 0;
        return (uint64_t)freeClusters * fs->csize * 512ULL;
    }
#endif
    if (strncmp(drive, "/local", 6) == 0) {
        size_t total = 0, used = 0;
        if (esp_littlefs_info("littlefs", &total, &used) != ESP_OK) return 0;
        return total > used ? (total - used) : 0;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// MD5 — implementacao da ROM da Espressif (mbedtls 3.x esconde o MD5 como
// API privada; a ROM expoe direto e o hash precisa continuar MD5 porque e
// formato publicado: System.getFileMD5 do JS e PIN do Settings)
// ---------------------------------------------------------------------------

#include "esp_rom_md5.h"

std::string FileSystem::getFileMD5(const char* path) {
    if (!pathOk(path)) return "";
    FILE* f = fopen(path, "rb");
    if (f == nullptr) return "";

    md5_context_t ctx;
    esp_rom_md5_init(&ctx);

    uint8_t buffer[512];
    size_t len;
    while ((len = fread(buffer, 1, sizeof(buffer), f)) > 0) {
        esp_rom_md5_update(&ctx, buffer, (uint32_t)len);
    }
    fclose(f);

    uint8_t hash[16];
    esp_rom_md5_final(hash, &ctx);

    std::string hexHash;
    for (int i = 0; i < 16; i++) {
        char buf[3];
        sprintf(buf, "%02x", hash[i]);
        hexHash += buf;
    }
    return hexHash;
}
