// Task do System.playMusic (API 25): mistura o MusicEngine em blocos de
// 256 quadros e escreve no I2S0, no mesmo ciclo de canal do BoardIO::tone
// (canal PERSISTENTE do speakerChannel nas placas sem codec — cao e
// SmartDisplay; canal proprio + codec ES8311 acordado em volta no watch).
// A posse exclusiva (AudioPlayer::acquireOutput) e tomada AQUI na thread
// JS e devolvida pela task no fim: play() devolve false imediato se o
// alto-falante ja esta ocupado (fala do AI.speak, playWav, tom) e o
// detector de wake word dorme o tempo todo (AudioPlayer::active()).
#include "MusicSynth.h"

#include <Arduino.h>
#include <esp_attr.h>
#include <freertos/idf_additions.h>  // xTaskCreateWithCaps
#include <freertos/semphr.h>
#include <freertos/task.h>

#include "AudioPlayer.h"
#include "BoardIO.h"
#include "Boards/Board.h"

namespace MusicSynth {
namespace {

// Bloco de mistura: 256 quadros mono -> estereo INTERCALADO (amp mono) em
// buffers estaticos — sem malloc no caminho quente (std::string/new que
// nao cresce ABORTA o aparelho nas placas sem PSRAM). Nas placas com PSRAM
// os ~3,9 KB moram la (EXT_RAM_BSS_ATTR): o I2S copia o bloco para o DMA,
// e a stack da task ja e PSRAM — nada aqui exige RAM interna.
constexpr uint32_t kFrames = 256;
EXT_RAM_BSS_ATTR int16_t s_mono[kFrames];
EXT_RAM_BSS_ATTR int16_t s_frames[kFrames * 2];     // [L0,R0,L1,R1,...]
EXT_RAM_BSS_ATTR MusicEngine::Compiled s_compiled;  // .bss ~2,6 KB
MusicEngine::Renderer s_renderer;
MusicEngine::SfxVoice s_sfx;            // efeito do System.sfx (API 32)
MusicEngine::Song s_song;
// Sessao = a task possui o alto-falante (acquireOutput) e o canal I2S, e
// segue viva enquanto houver trilha OU efeito soando. Tudo abaixo e lido e
// escrito sob mu(); a task so consome os pedidos no inicio de cada bloco.
volatile bool s_session = false;
volatile bool s_musicOn = false;        // trilha tocando (playing())
bool s_songPending = false;             // play() pediu (re)carga da trilha
bool s_sfxPending = false;              // sfx() pediu um efeito novo
MusicEngine::SfxTone s_sfxBuf[MusicEngine::kMaxSfxTones];
int s_sfxN = 0;
volatile uint32_t s_played = 0;         // amostras da trilha ja escritas no I2S
uint32_t s_startMs = 0;                 // offset do handoff (task converte p/ amostras)
TaskHandle_t s_task = nullptr;
StaticSemaphore_t s_muBuf;
SemaphoreHandle_t s_mu = nullptr;

SemaphoreHandle_t mu() {
    if (s_mu == nullptr) s_mu = xSemaphoreCreateMutexStatic(&s_muBuf);
    return s_mu;
}

void taskFunc(void*);

// Sessao abortada antes do laco (sem alto-falante/canal): zera os pedidos
// e devolve a posse.
void endSession() {
    xSemaphoreTake(mu(), portMAX_DELAY);
    s_session = false;
    s_musicOn = false;
    s_songPending = false;
    s_sfxPending = false;
    xSemaphoreGive(mu());
    AudioPlayer::releaseOutput();
}

// Abre a sessao (sob mu()): cria a task na 1a vez e toma a posse do
// alto-falante. false = sem task/ocupado (fala, playWav, tom).
bool openSessionLocked() {
    if (s_task == nullptr) {  // criacao sob o lock: sem janela de task dupla
        // Stack na PSRAM quando existe (a interna e o bem escasso do cao
        // com NimBLE + TLS ativos), com fallback comum. Nucleo 0 fixo: o
        // compile da trilha e o canal I2S fazem malloc/free (secoes
        // criticas do heap mascaram ate o nivel 3) e no nucleo 1 isso
        // atrasava a ISR do VSYNC do 4848 — imagem deslocando (1 us = ~12
        // px, ver boards/AGENTS.md). O nucleo 0 existe em toda placa
        BaseType_t okc = xTaskCreatePinnedToCoreWithCaps(taskFunc, "celermusic", 4096, nullptr,
                                                         4, &s_task, 0,
                                                         MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (okc != pdPASS)
            okc = xTaskCreatePinnedToCore(taskFunc, "celermusic", 3072, nullptr, 4, &s_task, 0);
        if (okc != pdPASS) {
            s_task = nullptr;
            return false;
        }
    }
    // Posse exclusiva AQUI (nao na task): retorno false imediato quando o
    // alto-falante esta ocupado — a task so devolve a guarda no fim.
    if (!AudioPlayer::acquireOutput()) return false;
    s_session = true;
    return true;
}

void taskFunc(void*) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        const BoardProfile& bp = Board::profile();
        const bool hasCodec = bp.audioCodecWake != nullptr;
        const uint32_t rate = hasCodec ? 16000u : 44100u;

        const bool go = BoardIO::hasSpeaker() && !(hasCodec && BoardIO::micRecActive());
        if (!go) { endSession(); continue; }

        // Canal: espelha toneI2sOut — sem codec o persistente segue vivo
        // (o amp dessas placas so descansa com clocks rodando); com codec
        // o canal nasce por musica e morre no fim (pins emprestados do mic).
        i2s_chan_handle_t tx = nullptr;
        bool keep = false;
        if (hasCodec) {
            i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
            chanCfg.auto_clear = true;
            chanCfg.dma_desc_num = 4;  // RAM enxuta, idem AudioPlayer
            if (i2s_new_channel(&chanCfg, &tx, nullptr) != ESP_OK) tx = nullptr;
            if (tx != nullptr) {
                i2s_std_config_t stdCfg = {};
                stdCfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(rate);
                stdCfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                    I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
                stdCfg.gpio_cfg.mclk = bp.i2s.mclk >= 0 ? (gpio_num_t)bp.i2s.mclk
                                                        : I2S_GPIO_UNUSED;
                stdCfg.gpio_cfg.bclk = (gpio_num_t)bp.i2s.bclk;
                stdCfg.gpio_cfg.ws = (gpio_num_t)bp.i2s.lrc;
                stdCfg.gpio_cfg.dout = (gpio_num_t)bp.i2s.dout;
                stdCfg.gpio_cfg.din = I2S_GPIO_UNUSED;
                if (i2s_channel_init_std_mode(tx, &stdCfg) != ESP_OK ||
                    i2s_channel_enable(tx) != ESP_OK) {
                    i2s_del_channel(tx);
                    tx = nullptr;
                }
            }
        } else {
            tx = BoardIO::speakerChannel((int)rate);
            keep = tx != nullptr;
        }
        if (tx == nullptr) { endSession(); continue; }

        if (hasCodec) bp.audioCodecWake();
        if (bp.audioPaPin >= 0) {
            pinMode(bp.audioPaPin, OUTPUT);
            digitalWrite(bp.audioPaPin, HIGH);
            delay(2);  // PA estabiliza antes do primeiro sample
        }

        // Bloco a bloco: consome os pedidos (trilha nova, efeito novo,
        // stop) sob o lock e renderiza fora dele. A sessao acaba quando nem
        // a trilha nem o efeito tem o que tocar.
        const int32_t master = BoardIO::volumePct() * 200;  // = Renderer::reset
        uint32_t total = 0;
        for (;;) {
            xSemaphoreTake(mu(), portMAX_DELAY);
            if (s_songPending) {
                s_songPending = false;
                if (MusicEngine::compile(s_song, rate, s_compiled)) {
                    s_renderer.reset(&s_compiled, BoardIO::volumePct());
                    if (s_startMs > 0) {  // handoff: retoma de onde parou no vizinho
                        s_renderer.seek((uint32_t)((uint64_t)s_startMs * s_compiled.rate / 1000));
                    }
                    s_played = s_renderer.pos;
                    total = s_compiled.totalSamples;
                } else {
                    s_musicOn = false;  // musica vazia: so o efeito (se houver)
                }
                s_startMs = 0;
            }
            if (s_sfxPending) {
                s_sfxPending = false;
                s_sfx.load(s_sfxBuf, s_sfxN, rate);
            }
            const bool musicOn = s_musicOn;
            if (!musicOn && !s_sfx.active()) {
                s_session = false;  // sob o lock: play()/sfx() abrem sessao nova
                xSemaphoreGive(mu());
                break;
            }
            xSemaphoreGive(mu());

            if (musicOn) {
                s_renderer.render(s_mono, kFrames);
            } else {
                for (uint32_t i = 0; i < kFrames; i++) s_mono[i] = 0;
            }
            if (s_sfx.active()) s_sfx.mix(s_mono, kFrames, master);
            for (uint32_t i = 0; i < kFrames; i++) {
                s_frames[i * 2] = s_mono[i];
                s_frames[i * 2 + 1] = s_mono[i];
            }
            size_t written = 0;
            i2s_channel_write(tx, s_frames, sizeof(s_frames), &written,
                              pdMS_TO_TICKS(200));
            AudioPlayer::feedWatchdog();
            if (written == 0) {  // canal morreu: sai limpo
                xSemaphoreTake(mu(), portMAX_DELAY);
                s_musicOn = false;
                s_sfx.stop();
                s_session = false;
                xSemaphoreGive(mu());
                break;
            }
            if (musicOn) {
                s_played = s_renderer.pos;
                if (s_renderer.pos >= total) {  // loops acabaram
                    xSemaphoreTake(mu(), portMAX_DELAY);
                    if (!s_songPending) s_musicOn = false;
                    xSemaphoreGive(mu());
                }
            }
        }

        if (bp.audioPaPin >= 0) digitalWrite(bp.audioPaPin, LOW);
        if (hasCodec) bp.audioCodecSleep();
        if (!keep) {  // canal por musica (codec): desmonta e solta os pinos
            i2s_channel_disable(tx);
            i2s_del_channel(tx);
            BoardIO::speakerPinsPark();
            BoardIO::micPinsDirty();
        }
        // persistente (keep): fica vivo no silencio (auto_clear), idem tom
        AudioPlayer::releaseOutput();
    }
}

}  // namespace

bool play(const MusicEngine::Song& song, uint32_t startMs) {
    if (!BoardIO::hasSpeaker()) return false;
    xSemaphoreTake(mu(), portMAX_DELAY);
    // uma trilha por vez (contrato da API 25: a nova so entra quando a
    // anterior acaba ou leva stop); sessao viva so com efeito = embarca nela
    if (s_musicOn) {
        xSemaphoreGive(mu());
        return false;
    }
    const bool fresh = !s_session;
    if (fresh && !openSessionLocked()) {
        xSemaphoreGive(mu());
        return false;
    }
    s_song = song;
    s_songPending = true;
    s_musicOn = true;
    s_startMs = startMs;
    s_played = 0;
    xSemaphoreGive(mu());
    if (fresh) xTaskNotifyGive(s_task);
    return true;
}

int sfx(const MusicEngine::SfxTone* tones, int n) {
    if (!BoardIO::hasSpeaker() || tones == nullptr || n <= 0) return 0;
    if (n > MusicEngine::kMaxSfxTones) n = MusicEngine::kMaxSfxTones;
    xSemaphoreTake(mu(), portMAX_DELAY);
    const bool fresh = !s_session;
    if (fresh && !openSessionLocked()) {
        xSemaphoreGive(mu());
        return 0;
    }
    for (int i = 0; i < n; i++) s_sfxBuf[i] = tones[i];
    s_sfxN = n;
    s_sfxPending = true;
    xSemaphoreGive(mu());
    if (fresh) xTaskNotifyGive(s_task);
    return n;
}

void stop() {
    xSemaphoreTake(mu(), portMAX_DELAY);
    s_musicOn = false;  // a task para de renderizar a trilha no proximo bloco
    s_songPending = false;
    xSemaphoreGive(mu());
}

bool playing() { return s_musicOn; }

int32_t posMs() {
    if (!s_musicOn || s_compiled.rate == 0) return -1;
    return (int32_t)(s_played * 1000ULL / s_compiled.rate);
}

bool currentSong(MusicEngine::Song* out) {
    if (out == nullptr) return false;
    xSemaphoreTake(mu(), portMAX_DELAY);
    const bool ok = s_musicOn;
    if (ok) *out = s_song;
    xSemaphoreGive(mu());
    return ok;
}

}  // namespace MusicSynth
