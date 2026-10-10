#include "Pack.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_random.h"

#include "../Bluetooth/CelerNet.h"
#include "../Bluetooth/NetFrame.h"
#include "../Boards/Board.h"
#include "../Hardware/MusicEngine.h"
#include "../Hardware/MusicSynth.h"
#include "NetworkManager.h"

// Servico de matilha (ver Pack.h). O nome do jogo: o handler do CelerNet
// roda DENTRO do mutex da malha — so copia para slots e seta flags; quem
// age (tocar musica, religar caps) e o tick() daqui, logo depois do
// celernet na tabela kServices.
//
// Envelope: ['P'][kind u8][msgId u16][payload <= 430]
//   KIND_MUSIC: [posMs u32][songLen u16][song <= 403] (encodeSong)

namespace Pack {
namespace {

const char* TAG = "celer.pack";

constexpr uint8_t ENV_MAGIC = 'P';
constexpr size_t ENV_HDR = 4;
constexpr size_t CUSTOM_DEPTH = 4;

struct CustomMsg {
    uint16_t from;
    char fromName[16];
    uint16_t len;
    uint8_t data[MAX_PAYLOAD];
};
CustomMsg s_custom[CUSTOM_DEPTH];
uint8_t s_customHead = 0, s_customCount = 0;

// dedup por msgId (as copias do sendTo chegam com seq novo)
struct Seen { uint16_t from, msgId; };
Seen s_seen[8];
uint8_t s_seenPos = 0;

// handoff pendente (copiado no handler, tocado no tick)
bool s_musicPend = false;
char s_musicFrom[16] = {0};
uint32_t s_musicPosMs = 0;
uint16_t s_musicSongLen = 0;
uint8_t s_musicSong[403];

uint16_t s_msgSeq = 0;
uint8_t s_capsBase = 0;   // do Board::profile (sem o bit HUB, dinamico)
bool s_capsHub = false;
bool s_inited = false;

bool seenBefore(uint16_t from, uint16_t msgId) {
    for (int i = 0; i < 8; i++) {
        if (s_seen[i].from == from && s_seen[i].msgId == msgId) return true;
    }
    s_seen[s_seenPos] = Seen{from, msgId};
    s_seenPos = (uint8_t)((s_seenPos + 1) & 7);
    return false;
}

void memberCb(uint16_t id, const char* name, uint8_t caps, bool joined) {
    // Rodada 1: so o log (os reflexos da proxima rodada escutam aqui).
    ESP_LOGI(TAG, "%s %04X \"%s\" (caps 0x%02X)", joined ? "chegou:" : "saiu:  ", id,
             name != nullptr ? name : "", caps);
}

bool msgHandler(const CelerNet::Msg& m) {
    if (m.len < ENV_HDR || m.data[0] != ENV_MAGIC) return false;  // segue ao JS
    const uint8_t kind = m.data[1];
    const uint16_t msgId = (uint16_t)((m.data[2] << 8) | m.data[3]);
    if (seenBefore(m.from, msgId)) return true;  // copia redundante: consumida

    if (kind == KIND_CUSTOM) {
        const size_t len = m.len - ENV_HDR;
        if (len == 0) return true;
        if (s_customCount >= CUSTOM_DEPTH) {
            s_customHead = (uint8_t)((s_customHead + 1) % CUSTOM_DEPTH);
            s_customCount--;
        }
        CustomMsg* c = &s_custom[(s_customHead + s_customCount) % CUSTOM_DEPTH];
        memset(c, 0, sizeof(*c));
        c->from = m.from;
        snprintf(c->fromName, sizeof(c->fromName), "%s", m.fromName);
        c->len = (uint16_t)len;
        memcpy(c->data, m.data + ENV_HDR, len);
        s_customCount++;
        return true;
    }
    if (kind == KIND_MUSIC) {
        // [posMs u32][songLen u16][song]
        if (m.len < ENV_HDR + 6) {
            ESP_LOGW(TAG, "hop: curto (%u B)", (unsigned)m.len);
            return true;
        }
        const uint32_t pos = ((uint32_t)m.data[4] << 24) | ((uint32_t)m.data[5] << 16) |
                             ((uint32_t)m.data[6] << 8) | m.data[7];
        const uint16_t songLen = (uint16_t)((m.data[8] << 8) | m.data[9]);
        if (songLen == 0 || songLen > sizeof(s_musicSong)) {
            ESP_LOGW(TAG, "hop: songLen %u invalido", (unsigned)songLen);
            return true;
        }
        if ((size_t)ENV_HDR + 4 + 2 + songLen != m.len) {
            ESP_LOGW(TAG, "hop: len %u != 10+%u", (unsigned)m.len, (unsigned)songLen);
            return true;
        }
        if (s_musicPend) return true;  // uma festa por vez
        s_musicPosMs = pos;
        s_musicSongLen = songLen;
        memcpy(s_musicSong, m.data + ENV_HDR + 6, songLen);
        snprintf(s_musicFrom, sizeof(s_musicFrom), "%s", m.fromName[0] ? m.fromName : "");
        s_musicPend = true;
        ESP_LOGI(TAG, "hop rx: festa de \"%s\" pos=%u song=%u B pendente", s_musicFrom,
                 (unsigned)pos, (unsigned)songLen);
        return true;
    }
    return true;  // kind desconhecido (futuro): consumido, nao e do JS
}

uint16_t pickSpeaker() {
    CelerNet::Node list[CelerNet::NODES_MAX];
    int n = CelerNet::nodes(list, CelerNet::NODES_MAX);  // mais forte primeiro
    for (int i = 0; i < n; i++) {
        if (list[i].id != 0 && (list[i].caps & netframe::CAPS_SPEAKER)) return list[i].id;
    }
    return 0;
}

}  // namespace

void init() {
    if (s_inited) return;
    s_inited = true;
    // msgId aleatorio no boot: comecando em 0, as primeiras mensagens depois
    // de um reboot repetiam ids que o dedup do vizinho ainda lembrava e eram
    // descartadas como copias (custom ou o proprio handoff de musica)
    s_msgSeq = (uint16_t)(esp_random() & 0xFFFF);
    const BoardProfile& bp = Board::profile();
    uint8_t caps = 0;
    if (bp.speakerPin >= 0 || bp.i2s.dout >= 0) caps |= netframe::CAPS_SPEAKER;
    if (bp.mic.ws >= 0) caps |= netframe::CAPS_MIC;
    if (!bp.headless) caps |= netframe::CAPS_DISPLAY;
    if (bp.servo.count > 0) caps |= netframe::CAPS_MOTORS;
    if (bp.strips.count > 0 || bp.led.r >= 0) caps |= netframe::CAPS_LEDS;
#if CONFIG_CELEROS_JS_CAMERA
    // so anuncia camera quando a API existe no build (a placa sem o driver
    // nao teria como ler o sensor de qualquer jeito)
    if (bp.camera.present()) caps |= netframe::CAPS_CAMERA;
#endif
    s_capsBase = caps;
    CelerNet::onMemberEvent(memberCb);
    CelerNet::subscribe(msgHandler);
    CelerNet::setCaps(caps);
    ESP_LOGI(TAG, "matilha: caps 0x%02X (%s)", caps, bp.name);
}

int members(Member* out, int max) {
    CelerNet::Node list[CelerNet::NODES_MAX];
    int n = CelerNet::nodes(list, CelerNet::NODES_MAX);
    if (n > max) n = max;
    for (int i = 0; i < n; i++) {
        out[i].id = list[i].id;
        snprintf(out[i].name, sizeof(out[i].name), "%s", list[i].name);
        out[i].caps = list[i].caps;
        out[i].rssi = list[i].rssi;
        out[i].hops = list[i].hops;
        out[i].lastSeenMs = list[i].lastSeenMs;
    }
    return n;
}

uint8_t myCaps() {
    return (uint8_t)(s_capsBase | (s_capsHub ? netframe::CAPS_HUB : 0));
}

bool send(uint16_t to, uint8_t kind, const void* payload, size_t len, bool urgent) {
    if (!CelerNet::active() || payload == nullptr || to == 0) return false;
    if (len == 0 || len > MAX_PAYLOAD) return false;
    uint8_t env[CelerNet::MAX_MSG];
    env[0] = ENV_MAGIC;
    env[1] = kind;
    s_msgSeq++;
    env[2] = (uint8_t)(s_msgSeq >> 8);
    env[3] = (uint8_t)s_msgSeq;
    memcpy(env + ENV_HDR, payload, len);
    // 2 copias: unicast sem ACK, a redundancia e a retransmissao
    return CelerNet::sendTo(to, env, ENV_HDR + len, CelerNet::TTL_DEFAULT, urgent, 2);
}

bool pollCustom(uint16_t* from, char* fromName, size_t nameCap, uint8_t* data, size_t* len) {
    if (s_customCount == 0) return false;
    const CustomMsg* c = &s_custom[s_customHead];
    if (from != nullptr) *from = c->from;
    if (fromName != nullptr && nameCap > 0) snprintf(fromName, nameCap, "%s", c->fromName);
    if (data != nullptr && len != nullptr) {
        size_t n = c->len < *len ? c->len : *len;
        memcpy(data, c->data, n);
        *len = n;
    }
    s_customHead = (uint8_t)((s_customHead + 1) % CUSTOM_DEPTH);
    s_customCount--;
    return true;
}

bool handoffMusic(uint16_t to) {
    MusicEngine::Song song;
    if (!MusicSynth::currentSong(&song)) return false;  // nada tocando aqui
    if (!CelerNet::active()) return false;
    if (to == 0) {
        to = pickSpeaker();
        if (to == 0) return false;
    }
    int32_t pos = MusicSynth::posMs();
    if (pos < 0) pos = 0;
    uint8_t payload[MAX_PAYLOAD];
    size_t songLen = MusicEngine::encodeSong(song, payload + 6, sizeof(payload) - 6);
    if (songLen == 0) return false;
    payload[0] = (uint8_t)((uint32_t)pos >> 24);
    payload[1] = (uint8_t)((uint32_t)pos >> 16);
    payload[2] = (uint8_t)((uint32_t)pos >> 8);
    payload[3] = (uint8_t)pos;
    payload[4] = (uint8_t)(songLen >> 8);
    payload[5] = (uint8_t)songLen;
    if (!send(to, KIND_MUSIC, payload, 6 + songLen, true)) return false;
    MusicSynth::stop();  // passou adiante: aqui silencia
    CelerNet::Info st;
    CelerNet::info(&st);
    ESP_LOGI(TAG, "musica -> %04X (pos %d ms, %u bytes)", to, (int)pos, (unsigned)(6 + songLen));
    return true;
}

void tick() {
    if (!s_inited) init();

    // CAPS_HUB dinamico: rede alcacavel muda o papel na matilha.
    const bool hub = NetworkManager::instance().isConnected();
    if (hub != s_capsHub) {
        s_capsHub = hub;
        CelerNet::setCaps(myCaps());
    }

    // Handoff pendente: a festa chegou — toca do ponto onde parou.
    if (s_musicPend) {
        s_musicPend = false;
        MusicEngine::Song song;
        if (MusicEngine::decodeSong(s_musicSong, s_musicSongLen, &song)) {
            if ((myCaps() & netframe::CAPS_SPEAKER) && !MusicSynth::playing()) {
                const bool ok = MusicSynth::play(song, s_musicPosMs);
                ESP_LOGI(TAG, "festa de \"%s\" %s (pos %u ms)", s_musicFrom,
                         ok ? "continuou aqui" : "nao coube no alto-falante",
                         (unsigned)s_musicPosMs);
            } else {
                ESP_LOGI(TAG, "festa de \"%s\" recusada (sem speaker ou ocupado)", s_musicFrom);
            }
        } else {
            // sem else isto morria em silencio (bancada: a song de 84 B
            // remontava no 4848 e nada acontecia)
            ESP_LOGW(TAG, "festa de \"%s\": song nao decoda (%u B)",
                     s_musicFrom, (unsigned)s_musicSongLen);
        }
    }
}

}  // namespace Pack
