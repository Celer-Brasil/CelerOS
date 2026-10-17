#include "AudioPlayer.h"
#include "../Boards/Board.h"
#include "BoardIO.h"
#include "PowerPolicy.h"  // audio segura o light sleep (watch com a tela apagada)
#include <Arduino.h>
#include <atomic>
#include <cstdio>
#include <cstring>
#include "driver/i2s_std.h"
#include "esp_task_wdt.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"

// QOA ("Quite OK Audio", phoboslab, MIT): decoder de ~60 linhas, ponto
// fixo, sem tabelas/malloc — 5x menor que PCM16 e MUITO mais leve que um
// decoder MP3 (sem componente, sem licenca, sem saga). O header de FRAME
// ja traz canais e taxa: nem precisa decodificar pra abrir o canal I2S.
#include "Audio/qoa.h"

namespace AudioPlayer {

// Corte por fora (AI.cancel/exit do app no meio da fala do TTS, que toca na
// worker do AI): os loops checam a cada chunk e o pedido limpa no inicio de
// cada playWav. s_playing garante UMA reproducao por vez — o TTS roda na
// worker do AI e um playWav da task JS nao pode escrever no mesmo canal I2S
// no meio dela (vira Busy; o app decide o fallback).
static std::atomic_bool s_stopReq{false};
static std::atomic_bool s_playing{false};

void requestStop() { s_stopReq = true; }

bool acquireOutput() {
    bool livre = false;
    if (!s_playing.compare_exchange_strong(livre, true)) return false;
    // O driver do I2S so pega ESP_PM_APB_FREQ_MAX (nao barra light sleep):
    // no watch, com a tela apagada, o sleep entre descritores para o clock
    // e o stream engasga. Tom e musica usam esta guarda; o playWav toma a
    // mesma s_playing por conta propria e segura o PM la tambem (o PcmFeed
    // idem, no begin/end). No-op nas placas sem CONFIG_PM_ENABLE.
    PowerPolicy::audioBusy(true);
    return true;
}
void releaseOutput() {
    s_playing = false;
    PowerPolicy::audioBusy(false);
}

bool active() { return s_playing; }  // detector de wake dorme enquanto toca

void feedWatchdog() {
    if (esp_task_wdt_status(nullptr) == ESP_OK) esp_task_wdt_reset();
}

namespace {

// little-endian helpers (WAV e LE por especificacao)
uint32_t rdU32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
uint16_t rdU16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }

// Teto de cada i2s_channel_write e estouros seguidos antes de desistir.
// portMAX_DELAY prendia a task (e a guarda do I2S) para SEMPRE se o DMA
// parasse: o vigia de 500 ms do end() desistia, recursos e s_playing
// vazavam e o audio do aparelho ficava morto ate rebootar. Com teto, o
// player volta ao laco, ve _quit/s_stopReq e sai limpo.
constexpr uint32_t kWriteMs = 100;    // ~3 blocos de DMA a 16 kHz
constexpr int kWriteStalls = 5;       // 5 estouros seguidos (~0,5 s) = canal morto

// Escreve o bloco INTEIRO. false = corte pedido, canal morto ou erro.
// `quit` permite ao PcmFeed abortar no meio do bloco quando o end() pede.
bool writeAll(i2s_chan_handle_t tx, const void* data, size_t bytes,
              const volatile bool* quit = nullptr) {
    const uint8_t* p = (const uint8_t*)data;
    size_t left = bytes;
    int stalls = 0;
    while (left > 0) {
        if (s_stopReq || (quit != nullptr && *quit)) return false;
        size_t w = 0;
        const esp_err_t e = i2s_channel_write(tx, p, left, &w, pdMS_TO_TICKS(kWriteMs));
        if (w > 0) {
            p += w;
            left -= w;
            stalls = 0;
        }
        if (e != ESP_OK && e != ESP_ERR_TIMEOUT) return false;  // driver invalido
        // i2s_channel_write tambem devolve ESP_OK sem escrever quando o canal
        // foi desabilitado por baixo (o laco do driver so termina no estado
        // != RUNNING): sem progresso e sem erro, o teto vale igual.
        if (w == 0 && ++stalls >= kWriteStalls) return false;
    }
    return true;
}

// Buffers de trabalho grandes (decode QOA) vao para a PSRAM e so caem na
// interna se ela nao existir. O DMA do I2S exige RAM interna apenas para os
// descritores do driver: o i2s_channel_write COPIA o bloco do chamador para
// o DMA, entao a fonte pode morar na PSRAM sem risco de corrupcao.
void* mallocAudio(size_t bytes) {
    void* p = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (p == nullptr) p = malloc(bytes);
    return p;
}

struct WavInfo {
    uint32_t sampleRate = 0;
    uint16_t channels = 0;     // 1 ou 2
    long dataOffset = 0;       // onde comecam as amostras
    uint32_t dataBytes = 0;
};

// ID3v2 na frente do arquivo (o ffmpeg as vezes prefixa a tag): devolve o
// offset do conteudo real. Sem isto as magias 'qoaf'/'RIFF' nao apareciam no
// sniff e um QOA valido virava BadHeader — o app caia no fallback de melodia
// (2 bipes) mesmo com o audio certo no FS.
long skipId3(FILE* f) {
    if (fseek(f, 0, SEEK_END) != 0) return 0;
    const long size = ftell(f);
    if (size < 10 || fseek(f, 0, SEEK_SET) != 0) return 0;
    uint8_t h[10];
    if (fread(h, 1, 10, f) != 10) return 0;
    if (memcmp(h, "ID3", 3) != 0 || h[3] < 2 || h[3] > 4) return 0;
    uint32_t tag;
    if (h[3] == 2) {  // ID3v2.2: tamanho de 3 bytes (nao synchsafe de 4)
        tag = ((uint32_t)h[6] << 16) | ((uint32_t)h[7] << 8) | h[8];
    } else {
        if (((h[6] | h[7] | h[8] | h[9]) & 0x80) != 0) return 0;  // synchsafe invalido
        tag = ((uint32_t)(h[6] & 0x7f) << 21) | ((uint32_t)(h[7] & 0x7f) << 14) |
              ((uint32_t)(h[8] & 0x7f) << 7) | (h[9] & 0x7f);
    }
    // rodape opcional do ID3v2.4 (flag 0x10): mais 10 bytes apos a tag
    const bool footer = (h[3] == 4 && (h[5] & 0x10) != 0);
    const long long off = 10 + (long long)tag + (footer ? 10 : 0);
    if (off <= 10 || off >= size) return 0;  // tag corrompida/colada no fim
    return (long)off;
}

// Percorre os chunks RIFF ate achar fmt (obrigatorio) e data. Sem parser de
// JSON/strings gigante: cabecalho WAV sao blocos de 8 bytes (id + tamanho).
// Arquivo nao confiavel: todo salto e para FRENTE e dentro do arquivo. Antes
// um tamanho >= 2^31 virava long negativo no fseek, o parser voltava ao
// mesmo cabecalho e o loop nunca terminava (watchdog reiniciava o aparelho).
// `start` e o offset do 'RIFF' (0, ou depois de uma tag ID3).
bool parseHeader(FILE* f, WavInfo& out, long start) {
    if (fseek(f, 0, SEEK_END) != 0) return false;
    const long fileSize = ftell(f);
    if (start < 0 || fileSize - start < 12 || fseek(f, start, SEEK_SET) != 0) return false;

    uint8_t h[12];
    if (fread(h, 1, 12, f) != 12) return false;
    if (memcmp(h, "RIFF", 4) != 0 || memcmp(h + 8, "WAVE", 4) != 0) return false;

    bool haveFmt = false, haveData = false;
    uint8_t ch[8];
    for (;;) {
        const long pos = ftell(f);
        if (pos < start || fileSize - pos < 8 || fread(ch, 1, 8, f) != 8) break;
        const uint64_t sz = rdU32(ch + 4);
        const long body = pos + 8;                       // inicio do conteudo
        const uint64_t avail = (uint64_t)(fileSize - body);
        if (memcmp(ch, "fmt ", 4) == 0) {
            uint8_t fmt[16];
            if (sz < 16 || sz > avail || fread(fmt, 1, 16, f) != 16) return false;
            if (rdU16(fmt) != 1) return false;             // so PCM linear
            out.channels = rdU16(fmt + 2);
            out.sampleRate = rdU32(fmt + 4);
            if (rdU16(fmt + 14) != 16) return false;       // 16 bits
            haveFmt = true;
        } else if (memcmp(ch, "data", 4) == 0) {
            // data truncado (download pela metade): toca o que existe
            out.dataBytes = (uint32_t)(sz < avail ? sz : avail);
            out.dataOffset = body;
            haveData = true;
        }
        if (haveFmt && haveData) break;
        // proximo chunk: conteudo + padding par, sempre adiante
        const uint64_t next = (uint64_t)body + sz + (sz & 1);
        if (next >= (uint64_t)fileSize) break;
        if (fseek(f, (long)next, SEEK_SET) != 0) return false;
    }
    if (!haveFmt || !haveData) return false;
    // "data" pode vir antes do "fmt ": volta ao inicio das amostras
    return fseek(f, out.dataOffset, SEEK_SET) == 0;
}

// ---- canal de saida (WAV e MP3 compartilham) ------------------------------
// Sem codec o canal e PERSISTENTE (BoardIO::speakerChannel): o amp dessas
// placas nao tem pino de enable e so descansa frio recebendo silencio com
// os clocks correndo — apaga-lo por som deixou a bobina do cao cozinhando
// (bancada 2026-10-03). Com codec, o canal nasce por som e morre no fim
// (clocks emprestados do I2S1 do mic + micPinsDirty no teardown).
struct TxSink {
    i2s_chan_handle_t tx = nullptr;
    bool keep = false;   // canal persistente: fica ligado no silencio no fim
};

bool openTxSink(uint32_t sampleRate, TxSink& s) {
    const BoardProfile& bp = Board::profile();
    const AudioI2sPins& p = bp.i2s;
    if (bp.audioCodecWake != nullptr) {
        i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
        // I2S_NUM_0 fixo: o I2S1 fica reservado ao microfone (mesma regra do
        // toneI2s — NUM_AUTO podia roubar o canal RX dele)
        chanCfg.auto_clear = true;
        // DMA enxuto (4 descritores ~3,8 KB internos em vez dos 6 default):
        // com a RAM interna apertada (sdkconfig regenerado + API 17) o default
        // falhava em "allocate DMA buffer failed" e TODO playWav vinha false
        // (bancada 2026-10-02). 4 descritores bastam para o stream de 16 kHz.
        chanCfg.dma_desc_num = 4;
        if (i2s_new_channel(&chanCfg, &s.tx, nullptr) != ESP_OK) return false;

        i2s_std_config_t stdCfg = {};
        stdCfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate);
        stdCfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
        stdCfg.gpio_cfg.mclk = p.mclk >= 0 ? (gpio_num_t)p.mclk : I2S_GPIO_UNUSED;
        stdCfg.gpio_cfg.bclk = (gpio_num_t)p.bclk;
        stdCfg.gpio_cfg.ws = (gpio_num_t)p.lrc;
        stdCfg.gpio_cfg.dout = (gpio_num_t)p.dout;
        stdCfg.gpio_cfg.din = I2S_GPIO_UNUSED;
        if (i2s_channel_init_std_mode(s.tx, &stdCfg) != ESP_OK || i2s_channel_enable(s.tx) != ESP_OK) {
            i2s_del_channel(s.tx);
            s.tx = nullptr;
            return false;
        }
    } else {
        s.tx = BoardIO::speakerChannel((int)sampleRate);
        if (s.tx == nullptr) return false;
        s.keep = true;
    }
    if (bp.audioCodecWake != nullptr) bp.audioCodecWake();
    if (bp.audioPaPin >= 0) {
        pinMode(bp.audioPaPin, OUTPUT);
        digitalWrite(bp.audioPaPin, HIGH);
        delay(2);  // PA estabiliza antes do primeiro sample
    }
    return true;
}

void closeTxSink(TxSink& s) {
    const BoardProfile& bp = Board::profile();
    if (bp.audioPaPin >= 0) digitalWrite(bp.audioPaPin, LOW);
    if (bp.audioCodecWake != nullptr) bp.audioCodecSleep();
    if (!s.keep && s.tx != nullptr) {  // persistente: auto_clear segue mandando silencio
        i2s_channel_disable(s.tx);
        i2s_del_channel(s.tx);
        BoardIO::speakerPinsPark();
    }
    if (bp.audioCodecWake != nullptr) BoardIO::micPinsDirty();  // pins do I2S1 voltam mortos
    s.tx = nullptr;
}

}  // namespace

// QOA em STREAMING: frame-a-frame do arquivo (header ja diz taxa/canais),
// decode no buffer e o MESMO caminho do WAV (mono duplicado + volume).
namespace {

WavError playQoaStream(FILE* f) {
    qoa_desc q = {};
    uint8_t fh[8];
    if (fread(fh, 1, 8, f) != 8 || memcmp(fh, "qoaf", 4) != 0) {
        fclose(f);
        return WavError::BadHeader;
    }
    // big endian (QOA e BE por especificacao). total = 0 e o modo
    // "streaming" da especificacao (numero de amostras desconhecido): toca
    // frame a frame ate o EOF em vez de recusar o arquivo.
    const uint32_t total = ((uint32_t)fh[4] << 24) | ((uint32_t)fh[5] << 16) | (fh[6] << 8) | fh[7];

    const uint32_t kFrameMax = 8 + 16 * 2 + 8 * 256 * 2;             // frame max stereo
    uint8_t* fbuf = (uint8_t*)mallocAudio(kFrameMax);                // 4 KB
    int16_t* pcm = (int16_t*)mallocAudio(QOA_FRAME_LEN * 2 * sizeof(int16_t));  // 20 KB -> PSRAM
    int16_t (*frames)[2] = (int16_t(*)[2])malloc(256 * 2 * sizeof(int16_t));
    if (fbuf == nullptr || pcm == nullptr || frames == nullptr) {
        free(fbuf); free(pcm); free(frames);
        fclose(f);
        return WavError::NoAudio;
    }

    TxSink sink;
    const int vol = BoardIO::volumePct();
    uint32_t played = 0;
    bool anyFrame = false;   // pelo menos um frame valido decodificado
    bool ioOk = true;        // canal de saida aceitou tudo (false = morreu)
    bool sinkFail = false;   // openTxSink recusou (sem canal/sem RAM)
    const bool streaming = (total == 0);
    while (streaming || played < total) {
        if (s_stopReq) break;  // corte pedido por fora (fala do TTS)
        // header do frame (8 B, BE): canais, taxa, amostras, tamanho
        uint8_t h[8];
        if (fread(h, 1, 8, f) != 8) break;
        const uint32_t channels = h[0];
        const uint32_t rate = ((uint32_t)h[1] << 16) | ((uint32_t)h[2] << 8) | h[3];
        const uint32_t samples = ((uint32_t)h[4] << 8) | h[5];
        const uint32_t frameSize = ((uint32_t)h[6] << 8) | h[7];
        if (channels < 1 || channels > 2 || rate < 8000 || rate > 48000 || samples == 0 ||
            frameSize < 8 + 16 * channels || frameSize > kFrameMax) break;
        fseek(f, -8, SEEK_CUR);  // qoa_decode_frame le o frame INTEIRO (header incluso)
        if (fread(fbuf, 1, frameSize, f) != frameSize) break;

        if (sink.tx == nullptr) {
            q.channels = channels;
            q.samplerate = rate;
            ESP_LOGI("celer.audio", "qoa: %u Hz ch=%u (%u amostras)", rate, channels, total);
            if (!openTxSink(rate, sink)) {
                sinkFail = true;
                break;
            }
        }
        unsigned frameLen = 0;
        if (qoa_decode_frame(fbuf, frameSize, &q, pcm, &frameLen) == 0 || frameLen == 0) break;
        anyFrame = true;

        for (uint32_t b = 0; b < frameLen; b += 256) {
            const uint32_t m = (frameLen - b < 256) ? frameLen - b : 256;
            for (uint32_t i = 0; i < m; i++) {
                const int32_t l = pcm[(b + i) * q.channels];
                const int32_t r = q.channels == 2 ? pcm[(b + i) * q.channels + 1] : l;
                frames[i][0] = (int16_t)((l * vol) / 100);
                frames[i][1] = (int16_t)((r * vol) / 100);
            }
            if (!writeAll(sink.tx, frames, m * sizeof(frames[0]))) {
                ioOk = false;  // corte (s_stopReq) ou canal morto
                break;
            }
            feedWatchdog();
        }
        if (!ioOk) break;
        played += frameLen;
    }

    if (sink.tx != nullptr) closeTxSink(sink);
    free(fbuf); free(pcm); free(frames);
    fclose(f);
    if (sinkFail) return WavError::NoAudio;
    if (!ioOk && !s_stopReq) return WavError::NoAudio;  // canal morreu no meio
    if (!anyFrame && !s_stopReq) return WavError::BadHeader;
    return WavError::None;
}

}  // namespace

static WavError playWavLocked(const char* path);

WavError playWav(const char* path) {
    const BoardProfile& bp = Board::profile();
    if (bp.i2s.dout < 0) return WavError::NoAudio;  // CYD: sem alto-falante

    bool livre = false;
    if (!s_playing.compare_exchange_strong(livre, true)) return WavError::Busy;
    // playWav nao passa por acquireOutput (a guarda e tomada aqui): segura o
    // light sleep pelo mesmo motivo (ver acquireOutput) — TTS/alarme com a
    // tela apagada no watch engasgava com o clock do I2S dormindo.
    PowerPolicy::audioBusy(true);
    s_stopReq = false;
    const WavError e = playWavLocked(path);
    s_playing = false;
    PowerPolicy::audioBusy(false);
    return e;
}

// Reproducao em si (a guarda de concorrencia fica no playWav publico).
static WavError playWavLocked(const char* path) {
    const BoardProfile& bp = Board::profile();
    const AudioI2sPins& p = bp.i2s;
    if (p.dout < 0) return WavError::NoAudio;

    FILE* f = fopen(path, "rb");
    if (f == nullptr) return WavError::OpenFailed;

    // Placa com codec: gravacao em curso tem prioridade (mesmo motivo do
    // toneI2s — o I2S0 compartilha bclk/ws/mclk com o I2S1 do mic)
    if (bp.audioCodecWake != nullptr && BoardIO::micRecActive()) {
        fclose(f);
        return WavError::NoAudio;
    }

    // Fareio o formato DEPOIS de pular uma eventual tag ID3v2 (ffmpeg):
    // RIFF..WAVE = WAV PCM; magica "qoaf" = QOA (big endian).
    const long start = skipId3(f);
    {
        uint8_t m[4];
        if (fseek(f, start, SEEK_SET) != 0) {
            fclose(f);
            return WavError::BadHeader;
        }
        const size_t rn = fread(m, 1, 4, f);
        fseek(f, start, SEEK_SET);
        if (rn == 4 && m[0] == 'q' && m[1] == 'o' && m[2] == 'a' && m[3] == 'f') {
            return playQoaStream(f);
        }
    }

    WavInfo wi;
    if (!parseHeader(f, wi, start) ||
        (wi.channels != 1 && wi.channels != 2) ||
        wi.sampleRate < 8000 || wi.sampleRate > 48000 || wi.dataBytes < 4) {
        fclose(f);
        return WavError::BadHeader;
    }

    TxSink sink;
    if (!openTxSink(wi.sampleRate, sink)) {
        fclose(f);
        return WavError::NoAudio;
    }

    // Streaming: le MONO/STEREO do arquivo em chunks e entrega ESTEREO ao
    // I2S (mono duplicado L/R, como o tom — o amp e mono nas placas atuais).
    // int16 puro + fread: sem std::string/new no caminho (regra do firmware).
    const int kFrames = 256;                    // 256 frames = 1 KB por canal de leitura
    int16_t* src = (int16_t*)malloc(kFrames * wi.channels * sizeof(int16_t));
    int16_t (*frames)[2] = (int16_t(*)[2])malloc(kFrames * 2 * sizeof(int16_t));
    const int vol = BoardIO::volumePct();

    // malloc falhou nao e sucesso silencioso: antes devolvia None e o
    // fallback do AI.speak jurava played:true sem ter tocado nada. Mesmo
    // WavError::NoAudio do OOM do playQoaStream.
    const bool oom = src == nullptr || frames == nullptr;
    bool ioOk = true;
    if (!oom) {
        uint32_t remaining = wi.dataBytes / (2u * wi.channels);  // em frames
        while (remaining > 0) {
            if (s_stopReq) break;  // corte pedido por fora (fala do TTS)
            uint32_t want = remaining < (uint32_t)kFrames ? remaining : kFrames;
            size_t got = fread(src, 2 * wi.channels, want, f);
            if (got == 0) break;
            for (uint32_t i = 0; i < got; i++) {
                int32_t l = src[i * wi.channels];
                int32_t r = wi.channels == 2 ? src[i * wi.channels + 1] : l;
                frames[i][0] = (int16_t)((l * vol) / 100);
                frames[i][1] = (int16_t)((r * vol) / 100);
            }
            if (!writeAll(sink.tx, frames, got * sizeof(frames[0]))) {
                ioOk = false;  // corte (s_stopReq) ou canal morreu
                break;
            }
            feedWatchdog();
            remaining -= got;
        }
    }
    free(src);
    free(frames);

    closeTxSink(sink);
    fclose(f);
    if (oom) return WavError::NoAudio;
    // canal morreu sem pedido de corte: nao mentir "tocou" para o chamador
    if (!ioOk && !s_stopReq) return WavError::NoAudio;
    return WavError::None;
}

// ---- PcmFeed: streaming ao vivo do TTS (AI.speak) --------------------------
// begin/write/end seguem a mesma disciplina do playWav: guarda de UMA
// reproducao por vez (s_playing), corte por fora checado por bloco e
// canal aberto/fechado pelo TxSink (codec acordado em volta, amp frio no
// silencio nas placas sem pino de enable).

// Reserva para (re)comecar: 200 ms. Na falta de dado o player PAUSA ate
// juntar isso de novo (ou o download acabar) — uma pausa limpa em vez de
// uma rajada de cliques de 10 ms.
static constexpr uint32_t kResumeMs = 200;

// Teto do dreno de rabo no end() sem finish() (AudioRes::playStop): a fila
// daquele caminho cabe em ~1 s (playFeed so enfileira ate 900 ms a frente).
static constexpr uint32_t kEndDrainMaxMs = 1200;

void PcmFeed::playerTask(void* arg) {
    PcmFeed* f = (PcmFeed*)arg;
    int16_t frames[256][2];  // bloco estereo (mono duplicado + volume)
    const size_t resume = (size_t)f->_rate * kResumeMs / 1000;
    bool starving = false;
    int64_t starveT0 = 0;
    while (!f->_quit) {
        if (!f->_go) {
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
            continue;
        }
        if (s_stopReq) break;
        const size_t w = f->_w;
        __sync_synchronize();  // amostras publicadas antes do indice
        const size_t r = f->_r;
        const size_t avail = w - r;
        if (avail == 0 || (starving && avail < resume && !f->_eof)) {
            if (avail == 0 && f->_eof) break;  // fim: tocou tudo
            if (!starving) {  // engasgo: rede atras da voz
                starving = true;
                starveT0 = esp_timer_get_time();
                f->_starves = f->_starves + 1;
            }
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10));
            continue;
        }
        if (starving) {
            starving = false;
            f->_starveMs = f->_starveMs + (uint32_t)((esp_timer_get_time() - starveT0) / 1000);
        }
        const size_t m = avail < 256 ? avail : 256;
        for (size_t i = 0; i < m; i++) {
            const int32_t v = ((int32_t)f->_ring[(r + i) % f->_cap] * f->_vol) / 100;
            frames[i][0] = (int16_t)v;
            frames[i][1] = (int16_t)v;
        }
        __sync_synchronize();
        f->_r = r + m;  // espaco devolvido ao produtor
        // Bloco com teto (writeAll): se o DMA parar, o laco volta e ve
        // _quit/s_stopReq. Com portMAX_DELAY a task ficava presa para sempre
        // e o end() desistia — vazava task, fila, canal e a guarda do I2S.
        if (!writeAll(f->_tx, frames, m * sizeof(frames[0]), &f->_quit)) {
            // _r ja avancou: sem a flag, o finish() veria a fila vazia e
            // reportaria "tocou tudo" com o canal morto no meio do bloco.
            if (!s_stopReq && !f->_quit) f->_err = true;
            break;
        }
        feedWatchdog();
    }
    f->_done = true;
    vTaskSuspend(nullptr);  // stack na PSRAM: quem libera e o end()
}

bool PcmFeed::begin(uint32_t sampleRate, size_t capBytes) {
    const BoardProfile& bp = Board::profile();
    if (bp.i2s.dout < 0 || sampleRate < 8000 || sampleRate > 48000) return false;
    if (bp.audioCodecWake != nullptr && BoardIO::micRecActive()) return false;
    bool livre = false;
    if (!s_playing.compare_exchange_strong(livre, true)) return false;  // playWav em curso
    _held = true;  // deste ponto em diante o end() e obrigatorio
    // O player drena o I2S por conta propria: sem o lock de PM o tickless
    // sleep para o clock do canal no meio da fala (tela apagada no watch).
    PowerPolicy::audioBusy(true);
    // corte VELHO (cancel de uma fala que ja tinha acabado): sem limpar, todo
    // feed seguinte nascia morto ate algum playWav zerar a flag
    s_stopReq = false;
    _hasCarry = false;
    _rate = sampleRate;
    _w = 0;
    _r = 0;
    _go = false;
    _eof = false;
    _quit = false;
    _done = false;
    _err = false;
    _starves = 0;
    _starveMs = 0;
    _cap = capBytes / 2;
    if (_cap < sampleRate) _cap = sampleRate;  // minimo 1 s de fila
    _ring = (int16_t*)heap_caps_malloc(_cap * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (_ring == nullptr) {
        end();
        return false;
    }
    TxSink s;
    if (!openTxSink(sampleRate, s)) {
        end();
        return false;
    }
    _tx = s.tx;
    _keep = s.keep;
    _vol = BoardIO::volumePct();
    // Player acima da worker do AI (3), do wake word (3) e da main (1): o
    // DMA do I2S segura so ~40 ms. Stack na PSRAM (a task nao toca a flash;
    // durante escrita de flash ninguem roda mesmo — o LogPersist segura o
    // flush enquanto toca).
    TaskHandle_t h = nullptr;
    if (xTaskCreatePinnedToCoreWithCaps(playerTask, "pcmfeed", 4096, this, 6, &h,
                                        tskNO_AFFINITY,
                                        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
        end();
        return false;
    }
    _task = h;
    return true;
}

bool PcmFeed::write(const void* le16, size_t bytes) {
    if (_tx == nullptr || _ring == nullptr) return false;
    const uint8_t* p = (const uint8_t*)le16;
    size_t left = bytes;
    while (left > 0) {
        if (s_stopReq || _done) return false;  // corte pedido / player saiu
        // byte a byte (LE): o chunk HTTP nao garante tamanho par nem
        // alinhamento de 2 — o cast direto desalinhava a fala inteira
        if (!_hasCarry) {
            _carry = *p++;
            left--;
            _hasCarry = true;
            continue;
        }
        while (_w - _r >= _cap) {  // fila cheia: espera o player abrir espaco
            if (s_stopReq || _done) return false;
            if (!_go) start();      // fila cheia sem tocar: nao ha o que esperar
            vTaskDelay(pdMS_TO_TICKS(5));
        }
        _ring[_w % _cap] = (int16_t)(uint16_t)(_carry | ((uint16_t)*p++ << 8));
        left--;
        _hasCarry = false;
        __sync_synchronize();  // amostra visivel antes do indice
        _w = _w + 1;
    }
    if (_task != nullptr) xTaskNotifyGive((TaskHandle_t)_task);
    return true;
}

void PcmFeed::start() {
    if (_go || _task == nullptr) return;
    _go = true;
    xTaskNotifyGive((TaskHandle_t)_task);
}

uint32_t PcmFeed::bufferedMs() const {
    return _rate ? (uint32_t)((uint64_t)(_w - _r) * 1000 / _rate) : 0;
}

bool PcmFeed::finish() {
    if (_task == nullptr) return false;
    _eof = true;
    start();
    xTaskNotifyGive((TaskHandle_t)_task);
    // espera o player drenar: o que falta tocar + 3 s de folga
    const int64_t limite = esp_timer_get_time() + (int64_t)(bufferedMs() + 3000) * 1000;
    while (!_done && !s_stopReq && esp_timer_get_time() < limite) {
        vTaskDelay(pdMS_TO_TICKS(20));
        feedWatchdog();
    }
    // _err: o player saiu por falha de I2S (nao por corte/fim). Sem isso o
    // _r avancado antes do write fazia a fila parecer vazia e o AI.speak
    // reportava "tocou tudo" com a voz cortada no meio.
    const bool inteiro = _done && !s_stopReq && !_err && _w == _r;
    // ultimo bloco ainda no DMA (~40 ms): sem isto o canal com codec
    // fechava cortando a ultima silaba
    if (inteiro) vTaskDelay(pdMS_TO_TICKS(60));
    return inteiro;
}

void PcmFeed::end() {
    if (_stuck) {
        // Player preso numa chamada ANTERIOR do end(): se ele finalmente
        // saiu, conclui a limpeza; senao nao toca em _ring/_tx (a task ainda
        // usa) nem solta a guarda. Antes o primeiro end() zerava _task
        // mesmo sem seguro e o SEGUNDO end() (destrutor do PcmFeed, que o
        // AudioRes chama depois do delete) liberava canal/fila sob a task
        // presa — use-after-free. Com o writeAll o caso virou quase
        // impossivel, mas o backstop nao pode piorar a situacao.
        if (_task == nullptr || !_done) return;
        _stuck = false;
    }
    bool seguro = true;  // nada mais toca no canal/fila
    if (_task != nullptr) {
        // Rabo: end() sem cancelamento e sem finish() (AudioRes::playStop)
        // drena o que ja esta na fila antes de matar o player — o corte
        // seco comia ate ~1 s de PCM recebido. finish() deixou a fila vazia
        // (sai na hora) e cancelamento (s_stopReq) corta na hora tambem.
        // Trade-off: esta espera pode somar ate kEndDrainMaxMs.
        if (!s_stopReq && _go && !_eof && !_done && _w != _r) {
            const uint32_t ms = bufferedMs();
            const uint32_t cap = ms < kEndDrainMaxMs ? ms : kEndDrainMaxMs;
            const int64_t lim = esp_timer_get_time() + (int64_t)(cap + 250) * 1000;
            while (_w != _r && !s_stopReq && esp_timer_get_time() < lim) {
                vTaskDelay(pdMS_TO_TICKS(10));
                feedWatchdog();
            }
            // ultimo bloco ainda no DMA (~40 ms): idem finish()
            if (_w == _r && !s_stopReq) vTaskDelay(pdMS_TO_TICKS(60));
        }
        _quit = true;
        xTaskNotifyGive((TaskHandle_t)_task);
        // 1 s: o pior caso do player com writeAll e ~600 ms (write de 100 ms
        // + 5 estouros de 100 ms). Esperar MENOS que isso deixava a task
        // sair logo depois do end() desistir — e o PcmFeed do AudioRes e
        // apagado em seguida (escrita em objeto liberado).
        for (int i = 0; i < 200 && !_done; i++) vTaskDelay(pdMS_TO_TICKS(5));
        if (_done) {
            vTaskDeleteWithCaps((TaskHandle_t)_task);
            _task = nullptr;
        } else {
            // player preso no I2S (writeAll torna o caso quase impossivel):
            // retem task, fila, canal e guarda em vez de solta-los sob ele.
            // _task fica para a proxima chamada poder concluir a limpeza.
            _stuck = true;
            seguro = false;
            ESP_LOGE("celer.audio", "pcmfeed: player nao saiu; recursos retidos");
        }
    }
    if (!seguro) return;
    if (_tx != nullptr) {
        TxSink s{_tx, _keep};
        closeTxSink(s);
        _tx = nullptr;
    }
    free(_ring);
    _ring = nullptr;
    _cap = 0;
    if (_held) {  // so solta a guarda que o begin pegou (nunca a de um playWav)
        releaseOutput();  // solta s_playing E o lock de PM do begin()
        _held = false;
    }
}

}  // namespace AudioPlayer
