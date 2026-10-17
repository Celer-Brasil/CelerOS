#pragma once

// Player de arquivos de audio (System.playWav, API 13; QOA desde o 1.9.13).
//
// WAV PCM 16-bit mono/stereo de 8 a 48 kHz ou QOA ("qoaf"), lidos do FS em
// streaming (chunks de 1 KB — o arquivo NAO carrega inteiro na RAM). Reusa
// o mesmo ciclo de canal do BoardIO::toneI2s: I2S_NUM_0 (o I2S1 e do
// microfone), codec ES8311/PA do perfil acordados em volta da reproducao,
// volume pela escala digital (System.setVolume). Bloqueante: o watchdog e
// alimentado por chunk. Placa sem I2S de audio (CYD): NoAudio de imediato.
#include "driver/i2s_std.h"

namespace AudioPlayer {

enum class WavError {
    None = 0,
    NoAudio,      // placa sem alto-falante I2S
    OpenFailed,   // arquivo nao abriu
    BadHeader,    // nao e WAV/QOA ou fmt inesperado (codec, bits, canais, rate)
    Busy,         // outra reproducao em curso (fala do AI.speak na worker)
};

// Toca o arquivo inteiro e devolve. Caminho ja validado pelo chamador.
WavError playWav(const char* path);

// Corta a reproducao em curso no proximo chunk (AI.cancel/exit do app no
// meio de uma fala longa do TTS). A proxima playWav limpa o pedido.
void requestStop();

// Posse exclusiva do I2S de saida (a mesma guarda do playWav/PcmFeed) para
// quem toca fora do AudioPlayer — o tom do BoardIO. false = ocupado.
bool acquireOutput();
void releaseOutput();

// true ENQUANTO toca algo (wav/tom/fala do TTS): o detector de wake word
// dorme nesse periodo (nao ouve o proprio falante e nao disputa a CPU com
// o feed do I2S — ver WakeWord.cpp; o mute de eco do app cobre a cauda).
bool active();

// esp_task_wdt_reset so na task INSCRITA no watchdog. A worker do AI.speak
// nao e: o reset cru logava "task not found" a cada chunk (~100/s, 841
// linhas em 45 s de fala na bancada) — inundava logcat, kern.log e a USB.
void feedWatchdog();

// Streaming AO VIVO (AI.speak) com PLAYER PROPRIO: o download so ENFILEIRA
// (fila circular de amostras na PSRAM) e uma task de prioridade alta drena
// para o I2S. Antes a mesma task baixava e tocava: enquanto o colchao
// escoava no I2S (segundos bloqueada) ninguem lia o TCP, a janela enchia,
// o servidor parava e o fim da fala engasgava. Quem chama decide QUANDO
// tocar (start) — o colchao certo depende da taxa da rede, que so ele mede.
// Falta de dado no meio (rede mais lenta que a voz) vira UMA pausa com
// retomada sobre 200 ms de reserva, nunca cliques picados; o numero e a
// duracao dessas pausas saem em starves()/starveMs() (telemetria do log).
// Mesma guarda do playWav (uma reproducao por vez) e o mesmo requestStop.
class PcmFeed {
public:
    ~PcmFeed() { end(); }
    // Abre o canal, a fila (capBytes de PCM, PSRAM) e o player (parado).
    // false = alto-falante ocupado, sem audio na placa, gravacao em curso
    // (codec) ou sem RAM — quem chama cai no arquivo. Um requestStop velho
    // e limpo aqui, como no playWav.
    bool begin(uint32_t sampleRate, size_t capBytes);
    // Enfileira BYTES de PCM16 mono LE como chegam da rede (byte impar fica
    // para o proximo write). So bloqueia com a fila cheia (fala maior que a
    // capacidade). false = corte pedido ou feed fechado.
    bool write(const void* le16, size_t bytes);
    // Libera o player (idempotente).
    void start();
    bool started() const { return _go; }
    // Fim do download: toca o que falta e espera drenar. true = tocou ate o
    // fim (false = corte). Chama start() se ninguem chamou.
    bool finish();
    // Para o player, fecha o canal e solta a guarda (idempotente).
    // Sem finish() previo (AudioRes::playStop), DRENA a fila antes de parar
    // (ate ~1,2 s): o corte seco comia o PCM ja recebido. Cancelamento
    // (requestStop) e o fim normal (finish) saem na hora.
    void end();
    // Audio enfileirado ainda nao tocado (ms) e telemetria de engasgo.
    uint32_t bufferedMs() const;
    uint32_t starves() const { return _starves; }
    uint32_t starveMs() const { return _starveMs; }

private:
    static void playerTask(void* arg);
    i2s_chan_handle_t _tx = nullptr;
    bool _keep = false;   // canal persistente (sem codec): fica no silencio
    bool _held = false;   // posse da guarda s_playing (end() so solta o que pegou)
    int _vol = 100;
    uint32_t _rate = 0;
    bool _hasCarry = false;   // byte baixo de uma amostra partida entre chunks
    uint8_t _carry = 0;
    int16_t* _ring = nullptr; // fila de amostras mono (PSRAM)
    size_t _cap = 0;          // capacidade em amostras
    volatile size_t _w = 0;   // contadores monotonicos (produtor/consumidor)
    volatile size_t _r = 0;
    volatile bool _go = false, _eof = false, _quit = false, _done = false;
    volatile bool _err = false;  // player saiu por falha do I2S (finish honesto)
    bool _stuck = false;      // end() anterior nao conseguiu parar o player:
                              // nada e liberado sob ele (nem na 2a chamada)
    void* _task = nullptr;    // TaskHandle_t do player
    volatile uint32_t _starves = 0, _starveMs = 0;
};

}  // namespace AudioPlayer
