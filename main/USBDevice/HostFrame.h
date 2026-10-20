#ifndef HOST_FRAME_H
#define HOST_FRAME_H

// Framer do protocolo HostLink — C++ puro, sem dependencias do ESP-IDF,
// para rodar igual no firmware e nos testes host (test/cpp/run_tests.cpp).
//
// Frame (little-endian), dois formatos:
//   proto 1: [0x43 'C'][cmd u8][len u16][payload de len bytes]
//   proto 2: [0x43 'C'][cmd u8][len u16][crc32 u32][payload de len bytes]
//            crc32 sobre os bytes (cmd, len_lo, len_hi, payload...)
//
// O formato e da SESSAO, decidido no HELLO: payload "CELERCTL2" negocia
// proto 2 (parser passa a exigir o CRC); qualquer outro fica no proto 1.
// A resposta do proprio HELLO sai no formato vigente ANTES da troca — o
// host ve "proto 2" na resposta e so entao passa a falar v2.
//
// Recuperacao de sessao: um frame v1 de host antigo numa sessao v2 e
// lido como "crc = CELE..." — o parser detecta o padrao no HELLO e cai
// de volta para proto 1 na hora (sem timeout, sem replug).

#include <cstdint>
#include <cstddef>
#include <cstring>
#include <array>

namespace hostframe {

constexpr uint8_t MAGIC = 0x43;

// ------------------------------------------------------------------- CRC32
// Polinomio 0xEDB88320 — mesmo resultado do zlib.crc32 (verificado nos
// testes host), para o celerctl validar com a stdlib do Python.

namespace detail {

constexpr std::array<uint32_t, 256> makeCrcTable() {
    std::array<uint32_t, 256> t{};
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        t[i] = c;
    }
    return t;
}

// inline: uma copia so no binario (sem inline cada TU que inclui o header
// ganhava a SUA tabela de 1 KB no flash — o CYD carregava duas)
inline constexpr auto kCrcTable = makeCrcTable();

}  // namespace detail

// crc=0 inicia; o retorno alimenta a proxima chamada (crc32(a||b))
inline uint32_t crc32(const uint8_t* d, size_t n, uint32_t crc = 0) {
    crc ^= 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) crc = detail::kCrcTable[(crc ^ d[i]) & 0xFFu] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFu;
}

// ------------------------------------------------------------------ montagem
// Monta o frame completo em `out` (cap bytes). O payload pode viver no
// proprio `out` a partir do offset 8 (montagem in-place: usa memmove).
// Retorna o total do frame, ou 0 se nao couber.
inline size_t build(uint8_t* out, size_t cap, bool v2, uint8_t cmd, const uint8_t* payload, uint16_t len) {
    const size_t hdr = v2 ? 8 : 4;
    if (cap < hdr + len) return 0;
    out[0] = MAGIC;
    out[1] = cmd;
    out[2] = (uint8_t)len;
    out[3] = (uint8_t)(len >> 8);
    if (payload != nullptr && len > 0) memmove(out + hdr, payload, len);
    if (v2) {
        uint32_t c = crc32(&out[1], 3);  // cmd + len LE
        c = crc32(out + hdr, len, c);
        out[4] = (uint8_t)c;
        out[5] = (uint8_t)(c >> 8);
        out[6] = (uint8_t)(c >> 16);
        out[7] = (uint8_t)(c >> 24);
    }
    return hdr + len;
}

// -------------------------------------------------------------------- parser

class FrameParser {
public:
    enum Reject { REJ_NONE = 0, REJ_TOO_BIG, REJ_CRC };
    typedef void (*FrameFn)(void* ctx, uint8_t cmd, const uint8_t* payload, uint16_t len);

    // payloadBuf: buffer do caller com espaco para maxPayload bytes
    FrameParser(uint8_t* payloadBuf, uint16_t maxPayload) : m_buf(payloadBuf), m_max(maxPayload) {}

    // Troca o buffer de payload (HostLink: buffer pequeno fora de sessao, o
    // de MAX_PAYLOAD so durante ela). Seguro dentro do callback de entrega:
    // deliver() ja voltou ao WANT_MAGIC e nao toca mais o buffer antigo.
    void setBuffer(uint8_t* payloadBuf, uint16_t maxPayload) {
        m_buf = payloadBuf;
        m_max = maxPayload;
        m_state = WANT_MAGIC;
        m_got = 0;
    }

    void setV2(bool on) {
        m_v2 = on;
        m_state = WANT_MAGIC;
        m_got = 0;
    }
    bool v2() const { return m_v2; }

    Reject takeReject() {
        Reject r = m_reject;
        m_reject = REJ_NONE;
        return r;
    }
    uint8_t rejectedCmd() const { return m_cmd; }

    // nowUs: relogio monotonico em microssegundos do caller (no device,
    // esp_timer_get_time) — usado no resync de silencio (>250ms no meio
    // de um frame = frame cortado). Canais com retransmissao propria (TCP:
    // uma perda de segmento volta apos o RTO, 300ms+) desligam com
    // setSilenceUs(0) — la o silencio e normal e o CRC protege a integridade.
    void setSilenceUs(int64_t us) { m_silenceUs = us; }

    void feed(uint8_t b, int64_t nowUs, FrameFn fn, void* ctx) {
        if (m_silenceUs > 0 && m_state != WANT_MAGIC && nowUs - m_lastUs > m_silenceUs) {
            m_state = WANT_MAGIC;
            m_got = 0;
        }
        m_lastUs = nowUs;

        switch (m_state) {
            case WANT_MAGIC:
                if (b == MAGIC) m_state = WANT_CMD;
                break;
            case WANT_CMD:
                m_cmd = b;
                m_state = WANT_LEN_LO;
                break;
            case WANT_LEN_LO:
                m_need = b;
                m_state = WANT_LEN_HI;
                break;
            case WANT_LEN_HI:
                m_need |= (uint16_t)b << 8;
                m_got = 0;
                if (m_need > m_max) {
                    m_reject = REJ_TOO_BIG;
                    m_state = WANT_MAGIC;
                } else if (m_v2) {
                    m_state = WANT_CRC;  // le o crc antes de entregar (len 0 incluido)
                } else if (m_need == 0) {
                    deliver(fn, ctx);
                } else {
                    m_state = WANT_PAYLOAD;
                }
                break;
            case WANT_CRC:
                ((uint8_t*)&m_crcRx)[m_got++] = b;  // LE direto
                if (m_got >= 4) {
                    m_got = 0;
                    // host proto-1 numa sessao proto-2: o HELLO dele
                    // ("CELERCTL1") chega com os 4 primeiros bytes do
                    // payload no lugar do crc. Devolve os bytes ao payload
                    // e derruba a sessao para proto 1 — recuperacao sem
                    // replug ( hosts v1 sempre abrem com HELLO).
                    if (m_cmd == 0x01 && memcmp((const uint8_t*)&m_crcRx, "CELE", 4) == 0) {
                        memcpy(m_buf, (const uint8_t*)&m_crcRx, 4);
                        m_got = 4;
                        m_v2 = false;
                        if (m_got >= m_need) deliver(fn, ctx);
                        else m_state = WANT_PAYLOAD;
                        break;
                    }
                    if (m_need == 0) deliver(fn, ctx);
                    else m_state = WANT_PAYLOAD;
                }
                break;
            case WANT_PAYLOAD:
                m_buf[m_got++] = b;
                if (m_got >= m_need) deliver(fn, ctx);
                break;
        }
    }

private:
    void deliver(FrameFn fn, void* ctx) {
        m_state = WANT_MAGIC;
        m_got = 0;
        if (m_v2) {
            uint8_t head[3] = {m_cmd, (uint8_t)m_need, (uint8_t)(m_need >> 8)};
            uint32_t calc = crc32(m_buf, m_need, crc32(head, 3));
            if (calc != m_crcRx) {
                m_reject = REJ_CRC;
                return;  // host reenvia (resync no proximo 0x43)
            }
        }
        fn(ctx, m_cmd, m_buf, m_need);
    }

    enum State { WANT_MAGIC, WANT_CMD, WANT_LEN_LO, WANT_LEN_HI, WANT_CRC, WANT_PAYLOAD };

    uint8_t* m_buf;
    uint16_t m_max;
    State m_state = WANT_MAGIC;
    bool m_v2 = false;
    uint8_t m_cmd = 0;
    uint16_t m_need = 0, m_got = 0;
    uint32_t m_crcRx = 0;
    int64_t m_lastUs = 0;
    int64_t m_silenceUs = 250000;
    Reject m_reject = REJ_NONE;
};

}  // namespace hostframe

#endif  // HOST_FRAME_H
