#pragma once

// Motor chiptune do System.playMusic (API 25): a LLM orquestra um "MIDI de
// poucos canais" — ate 4 trilhas de notas [midi, semicolcheias] (0 = pausa)
// misturadas ao vivo no alto-falante I2S. Este header e a PARTE PURA
// (compilacao da musica em eventos + renderizacao por amostra, inteira e
// deterministica): roda no host (test/cpp) e no firmware sem incluir nada
// do ESP — a cola de task/I2S vive em MusicSynth.cpp.
//
// Timbres: onda quadrada 50% (tema), 25% (2o voz, mais suave), triangular
// (baixo) e dente-de-serra (tema brilhante). Percussao (trilha drum:true)
// usa as notas GM: <=36 bumbo (senoide com varredura de afinacao),
// 37..41 caixa (ruido + tom) e >=42 chimbal (ruido curto).
//
// Tudo clampado aqui (o binding nao confia no app): bpm 60..200, loops
// 1..8 com teto total de 120 s, 4 trilhas x 48 notas, midi 0..96,
// duracao 1..64 semicolcheias, volume 0..100.

#include <stdint.h>
#include <stddef.h>
#include <array>

namespace MusicEngine {

constexpr int kMaxTracks = 4;
constexpr int kMaxNotes = 48;      // por trilha
constexpr int kMinBpm = 60, kMaxBpm = 200;
constexpr int kMaxLoops = 8;
constexpr uint32_t kMaxTotalMs = 120000;

enum Wave : uint8_t { kWaveSq = 0, kWaveSq25, kWaveTri, kWaveSaw };

struct Note { uint8_t midi; uint8_t len16; };  // midi 0 = pausa

struct Track {
    bool drum = false;   // notas viram percussao GM (wave ignorada)
    uint8_t wave = kWaveSq;
    uint8_t vol = 80;    // 0..100
    uint8_t count = 0;
    Note notes[kMaxNotes];
};

struct Song {
    uint16_t bpm = 120;
    uint8_t loops = 4;   // repeticoes da volta inteira
    uint8_t nTracks = 0;
    Track tracks[kMaxTracks];
};

// Evento compilado: nota com inicio/fim em AMOSTRAS dentro de UMA volta
// (ordenados; pausas ficam entre eventos). start==end seria nota nula.
struct Ev { uint32_t start, end; uint8_t midi; };

struct TrackEv {
    // 0..256 (vol% escalado). uint16_t de proposito: com uint8_t o volume
    // 100% (100*256/100 = 256) estourava para 0 e a trilha saia MUDA.
    uint16_t vol = 80;
    bool drum = false;
    uint8_t wave = kWaveSq;
    uint16_t count = 0;
    Ev evs[kMaxNotes];
};

struct Compiled {
    uint32_t rate = 0;          // taxa do canal (16k codec / 44,1k amp direto)
    uint32_t loopSamples = 0;   // volta = trilha mais longa
    uint32_t totalSamples = 0;  // loopSamples x loops (teto de 120 s corta loops)
    uint8_t loops = 1;
    uint8_t nTracks = 0;
    TrackEv tracks[kMaxTracks];
};

// Valida/clampa e compila a musica. Retorna false se nao sobrou nenhuma
// trilha com nota (null-music nao acorda o alto-falante).
inline bool compile(const Song& in, uint32_t rate, Compiled& out) {
    if (rate < 8000 || in.nTracks == 0 || in.nTracks > kMaxTracks) return false;
    out = {};
    out.rate = rate;
    uint32_t bpm = in.bpm < kMinBpm ? kMinBpm : (in.bpm > kMaxBpm ? kMaxBpm : in.bpm);
    // semicolcheia em amostras: (60/bpm)/4 * rate, Q8 p/ nao truncar feio
    const uint32_t s16Samples = (uint32_t)(((uint64_t)rate * 60 * 256 / 4) / (bpm * 256));
    if (s16Samples == 0) return false;
    for (int t = 0; t < in.nTracks; t++) {
        const Track& src = in.tracks[t];
        TrackEv& dst = out.tracks[out.nTracks];
        dst.drum = src.drum;
        dst.wave = src.wave > kWaveSaw ? (uint8_t)kWaveSq : src.wave;
        dst.vol = src.vol > 100 ? 100 : src.vol;
        dst.vol = (uint16_t)(dst.vol * 256 / 100);
        uint32_t at = 0;
        for (int i = 0; i < src.count && i < kMaxNotes; i++) {
            uint32_t len = src.notes[i].len16;
            if (len < 1) len = 1;
            if (len > 64) len = 64;
            const uint32_t dur = len * s16Samples;
            if (src.notes[i].midi != 0) {  // pausa so avanca o tempo
                dst.evs[dst.count].start = at;
                dst.evs[dst.count].end = at + dur;
                dst.evs[dst.count].midi = src.notes[i].midi > 96 ? 96 : src.notes[i].midi;
                dst.count++;
            }
            at += dur;
        }
        if (dst.count > 0) {
            if (at > out.loopSamples) out.loopSamples = at;
            out.nTracks++;
        }
    }
    if (out.nTracks == 0 || out.loopSamples == 0) return false;
    uint32_t loops = in.loops < 1 ? 1 : (in.loops > kMaxLoops ? kMaxLoops : in.loops);
    const uint32_t totalMs = (uint32_t)(((uint64_t)out.loopSamples * loops * 1000) / rate);
    if (totalMs > kMaxTotalMs) loops = kMaxTotalMs * rate / 1000 / out.loopSamples;
    if (loops < 1) loops = 1;
    out.loops = (uint8_t)loops;
    out.totalSamples = out.loopSamples * loops;
    return true;
}

// ---------------------------------------------------------------- io/handoff ---
// Serializacao binaria compacta da SONG para o handoff da matilha (Pack,
// API 27): 4 B de cabecalho + 3 B por trilha + 2 B por nota — no maximo
// 403 B, cabe inteiro numa mensagem da malha (MSG_MAX 434). O alvo decoda
// como Song e re-compila com a propria taxa de audio; bpm/loops/vol/notas
// fora da faixa sao re-clampados pelo compile() (o decode nao precisa
// confiar nos bytes).
constexpr uint8_t kSongMagic = 'M';

inline size_t encodeSong(const Song& s, uint8_t* out, size_t cap) {
    uint8_t nTracks = s.nTracks > kMaxTracks ? (uint8_t)kMaxTracks : s.nTracks;
    size_t need = 4;
    for (int t = 0; t < nTracks; t++) {
        uint8_t count = s.tracks[t].count > kMaxNotes ? (uint8_t)kMaxNotes : s.tracks[t].count;
        need += 3 + (size_t)count * 2;
    }
    if (cap < need) return 0;
    size_t at = 0;
    out[at++] = kSongMagic;
    out[at++] = (uint8_t)(s.bpm > 255 ? 255 : s.bpm);
    out[at++] = s.loops;
    out[at++] = nTracks;
    for (int t = 0; t < nTracks; t++) {
        const Track& tr = s.tracks[t];
        uint8_t count = tr.count > kMaxNotes ? (uint8_t)kMaxNotes : tr.count;
        out[at++] = (uint8_t)((tr.drum ? 4 : 0) | (tr.wave > kWaveSaw ? 0 : tr.wave));
        out[at++] = tr.vol > 100 ? 100 : tr.vol;
        out[at++] = count;
        for (int i = 0; i < count; i++) {
            out[at++] = tr.notes[i].midi;
            out[at++] = tr.notes[i].len16;
        }
    }
    return at;
}

inline bool decodeSong(const uint8_t* in, size_t len, Song* out) {
    if (len < 4 || in[0] != kSongMagic) return false;
    *out = Song{};
    out->bpm = in[1];
    out->loops = in[2];
    uint8_t nTracks = in[3];
    if (nTracks > kMaxTracks) nTracks = kMaxTracks;
    size_t at = 4;
    for (int t = 0; t < nTracks; t++) {
        if (at + 3 > len) return false;
        Track& tr = out->tracks[t];
        tr.drum = (in[at] & 4) != 0;
        tr.wave = in[at] & 3;
        tr.vol = in[at + 1];
        uint8_t count = in[at + 2];
        if (count > kMaxNotes) count = kMaxNotes;
        at += 3;
        if (at + (size_t)count * 2 > len) return false;
        for (int i = 0; i < count; i++) {
            tr.notes[i].midi = in[at++];
            tr.notes[i].len16 = in[at++];
        }
        tr.count = count;
    }
    out->nTracks = nTracks;
    return true;
}

// ---------------------------------------------------------------- render ---
// Estado do mixador: uma voz por trilha com acumulador de fase Q32 (1 ciclo
// = 2^32), envelope por nota e LFSR compartilhado da percussao.
struct Renderer {
    const Compiled* c = nullptr;
    int32_t master = 20000;      // vol% x 200: 1 voz ~5000, 4 vozes ~20000
    uint32_t pos = 0;           // amostra absoluta desde o inicio
    uint32_t loopStart = 0;
    uint16_t idx[kMaxTracks] = {};
    uint32_t phase[kMaxTracks] = {};   // oscilador melodicico / fase do bumbo
    uint32_t freqStep[kMaxTracks] = {};  // por amostra (Q32), da nota corrente
    uint32_t noise = 0x12345u;  // LFSR da percussao

    void reset(const Compiled* song, int volPct) {
        c = song;
        pos = loopStart = 0;
        for (int i = 0; i < kMaxTracks; i++) { idx[i] = 0; phase[i] = 0; freqStep[i] = 0; }
        noise = 0x12345u;
        if (volPct < 0) volPct = 0;
        if (volPct > 100) volPct = 100;
        master = volPct * 200;   // mesmo territory de amplitude do playTone
    }

    // Pula para uma posicao absoluta em amostras (handoff da matilha: a
    // musica continua de onde parou no vizinho). O while do render avanca
    // idx ate a nota em curso e o guard freqStep==0 do render calcula a
    // afinacao da nota que ja comecou.
    void seek(uint32_t samples) {
        if (c == nullptr) return;
        if (samples > c->totalSamples) samples = c->totalSamples;
        pos = samples;
        loopStart = c->loopSamples ? (samples / c->loopSamples) * c->loopSamples : 0;
        for (int i = 0; i < kMaxTracks; i++) { idx[i] = 0; phase[i] = 0; freqStep[i] = 0; }
        noise = 0x12345u;
    }

    static uint32_t midiStep(uint8_t midi, uint32_t rate) {  // Q32 por amostra
        // 440 Hz x 2^((m-69)/12): multiplicacao iterativa (sem pow — so na
        // troca de nota, mas mantem o header livre de math.h)
        double f = 440.0;
        int m = midi - 69;
        while (m > 0) { f *= 1.0594630943592953; m--; }
        while (m < 0) { f /= 1.0594630943592953; m++; }
        return (uint32_t)((uint64_t)(f * 4294967296.0) / rate);
    }

    // Amostra crua -256..256 de uma voz melodica
    inline int32_t waveSample(uint8_t wave, uint32_t ph) const {
        switch (wave) {
            case kWaveSq25: return (int32_t)((ph >> 30) == 0 ? 256 : -256);
            case kWaveTri: {
                const uint32_t t = ph >> 24;   // 0..255
                return (int32_t)(t < 128 ? t * 4 - 256 : 768 - (int32_t)t * 4);
            }
            case kWaveSaw: return (int32_t)((ph >> 24) * 2) - 256;
            default: return (int32_t)(ph & 0x80000000u ? -256 : 256);
        }
    }

    inline int32_t nextNoise() {
        // LFSR xorshift de 32 bits: ruido bruto da percussao
        uint32_t x = noise;
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        noise = x;
        return (int32_t)(x >> 24) - 128;   // -128..127
    }

    inline static int32_t sinTbl(uint32_t ph) {  // fase Q32 -> -256..255
        // Tabela de seno em flash (rodata): antes era um static int16_t[257]
        // em DRAM preenchido no primeiro uso. O MESMO loop, agora avaliado
        // em tempo de compilacao (constexpr) — 257/257 valores conferidos
        // identicos contra a tabela runtime no host, e os bytes do objeto
        // xtensa sao iguais aos do host (GCC 15 nas duas pontas).
        static constexpr std::array<int16_t, 257> tbl = [] {
            std::array<int16_t, 257> t{};
            for (int i = 0; i <= 256; i++)
                t[i] = (int16_t)(__builtin_sin(i * 6.283185307179586 / 256.0) * 256.0);
            return t;
        }();
        return tbl[ph >> 24];
    }

    // Envelope 0..256 da nota melodica: ataque 2 ms, release 4 ms no fim.
    inline int32_t noteEnv(uint32_t relStart, uint32_t relNow, uint32_t relEnd) const {
        const uint32_t atk = c->rate / 500;      // 2 ms
        const uint32_t rel = c->rate / 250;      // 4 ms
        int32_t e = 256;
        if (relNow - relStart < atk) e = (int32_t)((relNow - relStart) * 256 / (atk ? atk : 1));
        else if (relEnd - relNow < rel) e = (int32_t)((relEnd - relNow) * 256 / (rel ? rel : 1));
        return e < 0 ? 0 : e;
    }

    // Percussao GM relativa ao inicio da nota (dt em amostras).
    inline int32_t drumSample(uint8_t midi, uint32_t dt, uint32_t& ph) {
        const uint32_t rate = c->rate;
        if (midi <= 36) {  // bumbo: senoide 110->40 Hz com decaimento quadratico
            const uint32_t dur = rate / 5;                     // 200 ms
            if (dt >= dur) return 0;
            const uint32_t x = dt * 256 / dur;                 // 0..256
            const int32_t env = (int32_t)((256 - x) * (256 - x) / 256);
            const double f = 40.0 + 70.0 * (256 - x) / 256;
            ph += (uint32_t)(f * 4294967296.0 / rate);
            return sinTbl(ph) * env / 256;
        }
        if (midi <= 41) {  // caixa: ruido + tom de 190 Hz, decaimento longo
            const uint32_t dur = rate * 9 / 50;                // 180 ms
            if (dt >= dur) return 0;
            const uint32_t x = dt * 256 / dur;
            const int32_t env = (256 - x);
            ph += (uint32_t)(190.0 * 4294967296.0 / rate);
            return (nextNoise() * env / 128 + sinTbl(ph) * env / 256) / 2;
        }
        // chimbal: ruido curto e agudo
        const uint32_t dur = rate / 20;                        // 50 ms
        if (dt >= dur) return 0;
        const uint32_t x = dt * 256 / dur;
        return nextNoise() * (256 - x) / 64;                   // brilhante
    }

    // Renderiza n amostras MONO s16 (o chamador duplica p/ estereo do I2S).
    void render(int16_t* out, size_t n) {
        for (size_t i = 0; i < n; i++) {
            if (c->nTracks == 0 || pos >= c->totalSamples) { out[i] = 0; continue; }
            const uint32_t rel = pos - loopStart;
            if (rel >= c->loopSamples) {  // volta seguinte: bobina as trilhas
                loopStart += c->loopSamples;
                for (int t = 0; t < c->nTracks; t++) idx[t] = 0;
            }
            const uint32_t r = pos - loopStart;
            int32_t sum = 0;
            for (int t = 0; t < c->nTracks; t++) {
                const TrackEv& tr = c->tracks[t];
                // avanca ponteiro: pula eventos que ja acabaram
                while (idx[t] < tr.count && r >= tr.evs[idx[t]].end) idx[t]++;
                if (idx[t] >= tr.count) continue;  // silencio ate a proxima volta
                const Ev& e = tr.evs[idx[t]];
                if (r < e.start) continue;         // pausa antes da nota
                const uint32_t dt = r - e.start;
                int32_t s;
                if (tr.drum) {
                    s = drumSample(e.midi, dt, phase[t]);
                } else {
                    if (dt == 0 || freqStep[t] == 0) freqStep[t] = midiStep(e.midi, c->rate);
                    phase[t] += freqStep[t];
                    s = waveSample(tr.wave, phase[t]) *
                        noteEnv(e.start, r, e.end) / 256;
                }
                sum += s * (int32_t)tr.vol / 256;
            }
            pos++;
            int32_t v = sum * master / 1024;
            if (v > 24000) v = 24000;
            if (v < -24000) v = -24000;
            out[i] = (int16_t)v;
        }
    }
};

// ------------------------------------------------------------------ sfx ---
// Voz de efeito do System.sfx (API 32): melodia curta [freq Hz, ms] numa
// onda quadrada propria, MISTURADA por cima da trilha no mesmo bloco do
// sintetizador — o loop do jogo nao para (o playTone bloqueia a thread JS
// por nota) e a musica nao precisa sair do ar (adeus ao "duck" que parava
// a trilha). freq 0 = pausa que avanca o tempo. Um efeito por vez: o mais
// novo substitui o que esta tocando (o feedback do toque mais recente
// vence, como num console). Tudo clampado aqui: 24 tons, 1..1000 ms por
// tom, 3 s no total, 20..20000 Hz.
constexpr int kMaxSfxTones = 24;
constexpr uint32_t kMaxSfxMs = 3000;

struct SfxTone { uint16_t freq; uint16_t ms; };  // freq 0 = pausa

struct SfxVoice {
    SfxTone tones[kMaxSfxTones];
    uint8_t count = 0;
    uint8_t idx = 0;
    uint32_t rate = 0;
    uint32_t len = 0;    // amostras do tom corrente
    uint32_t left = 0;   // amostras restantes dele
    uint32_t phase = 0;  // Q32
    uint32_t step = 0;   // 0 = pausa

    bool active() const { return idx < count; }
    void stop() { count = idx = 0; }

    // Copia/clampa a melodia e comeca do 1o tom. Devolve os tons aceitos
    // (0 = nada a tocar: lista vazia ou taxa invalida).
    int load(const SfxTone* in, int n, uint32_t sampleRate) {
        count = idx = 0;
        phase = 0;
        rate = sampleRate;
        if (rate < 8000 || in == nullptr) return 0;
        uint32_t total = 0;
        for (int i = 0; i < n && count < kMaxSfxTones; i++) {
            uint32_t f = in[i].freq, ms = in[i].ms;
            if (f != 0 && (f < 20 || f > 20000)) continue;  // fora da faixa: pula
            if (ms < 1) continue;
            if (ms > 1000) ms = 1000;
            if (total + ms > kMaxSfxMs) ms = kMaxSfxMs - total;
            if (ms == 0) break;
            tones[count].freq = (uint16_t)f;
            tones[count].ms = (uint16_t)ms;
            count++;
            total += ms;
        }
        begin();
        return count;
    }

    // Proxima amostra crua -256..256 (envelope de 1 ms de ataque e 3 ms de
    // release por tom: sem estalo entre notas).
    inline int32_t next() {
        if (idx >= count) return 0;
        int32_t s = 0;
        if (step != 0) {
            phase += step;
            s = (phase & 0x80000000u) ? -256 : 256;
            const uint32_t done = len - left;
            const uint32_t atk = rate / 1000, rel = rate * 3 / 1000;
            if (done < atk) s = s * (int32_t)done / (int32_t)(atk ? atk : 1);
            else if (left < rel) s = s * (int32_t)left / (int32_t)(rel ? rel : 1);
        }
        if (--left == 0) {
            idx++;
            begin();
        }
        return s;
    }

    // Mistura n amostras do efeito sobre out (a trilha ja renderizada): a
    // trilha abaixa para ~55% enquanto o efeito soa (sidechain — o efeito
    // fica legivel sem calar a musica). master = mesmo ganho do Renderer.
    void mix(int16_t* out, size_t n, int32_t master) {
        for (size_t i = 0; i < n; i++) {
            if (idx >= count) return;
            int32_t v = (int32_t)out[i] * 140 / 256 + next() * master * 5 / 4096;
            if (v > 24000) v = 24000;
            if (v < -24000) v = -24000;
            out[i] = (int16_t)v;
        }
    }

private:
    void begin() {
        while (idx < count) {
            len = (uint32_t)((uint64_t)tones[idx].ms * rate / 1000);
            if (len == 0) { idx++; continue; }
            left = len;
            step = tones[idx].freq ? (uint32_t)(((uint64_t)tones[idx].freq << 32) / rate) : 0;
            return;
        }
    }
};

}  // namespace MusicEngine
