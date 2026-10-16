#ifndef HOST_LINK_H
#define HOST_LINK_H

#include <stdint.h>
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"

#include "HostFrame.h"

// Protocolo HostLink: canal binario da ferramenta celerctl sobre a CDC1
// nativa, a UART do CH340 (multiplexada com o console) ou o Celer Debug
// Bridge TCP/WiFi (DebugBridge.h — banner/AUTH por token antes dos frames).
//
// Frame (little-endian) — ver HostFrame.h (framer puro, testado no host):
//   proto 1: [0x43 'C'][cmd u8][len u16][payload]
//   proto 2: [0x43 'C'][cmd u8][len u16][crc32 u32][payload]  (crc no fio)
// O formato e da sessao, negociado no HELLO: payload "CELERCTL2" ativa o
// proto 2 (resposta do HELLO anuncia "proto 2|chunk W|win K"); qualquer
// outro payload mantem proto 1 — celerctl novo e firmware velho (e o
// contrario) conversam em proto 1 sem nada a fazer.
//
// Resposta reusa o opcode do pedido; o payload de resposta comeca com
// u8 status (0 = OK, 1 = erro; no erro o resto do payload e a mensagem).
//
// ESTE ARQUIVO E A FONTE UNICA DOS OPCODES: tools/celerctl.py extrai os
// valores por regex para manter os dois lados em sincronia.
//
// Cada transporte (UART0 do SerialLink, CDC1 do USBDevice, TCP do
// DebugBridge) cria a SUA instancia — a maquina de frames e por canal. A
// sessao de comandos e unica no device: o frame HELLO define o canal ativo
// (o ultimo ganha) e respostas, logs (KL_LOG_DATA) e demais frames de saida
// seguem sempre pelo canal que abriu a sessao. Comandos por canal inativo
// recebem erro.

class HostLink {
public:
    // Funcao de escrita no canal (CDC nativo, UART do CH340, ...)
    typedef bool (*WriteFn)(const uint8_t* data, size_t len);
    // Hook de troca de baud (so faz sentido em canais com baud, ex. UART)
    typedef void (*BaudFn)(uint32_t baud);

    // window: chunks em voo que o canal aceita (anunciado no HELLO proto 2).
    // silenceUs: resync do parser por silencio no meio de um frame — UART
    // usa 250ms (ruido corta frame); canais com retransmissao propria (TCP
    // do DebugBridge) passam 0: uma perda de segmento WiFi volta apos o RTO
    // (300ms+) e o silencio nao pode derrubar o frame no meio.
    HostLink(WriteFn writer, BaudFn baudHook = nullptr, uint8_t window = 4,
             uint32_t silenceUs = 250000);

    // Loop da task do canal CDC (USB nativo): consome o stream buffer e
    // alimenta a maquina de frames. Nunca retorna.
    void run(StreamBufferHandle_t rx);

    // Maquina de estados alimentada byte a byte (UART e outros canais).
    // Ao completar um frame, executa e responde.
    void feed(uint8_t byte);

    // Encerra a sessao se ela pertence a esta instancia (timeout de idle
    // do canal UART, por exemplo). Retorna true se havia sessao.
    bool endSession();

    // Canal da sessao vigente (nullptr = nenhuma).
    static HostLink* active();

    // Envia um frame KL_LOG_DATA pelo canal ativo (false se nao ha
    // sessao). Thread-safe: chamado pelo LogSink a partir de tasks
    // arbitrarias; nao passa pelos locks do dispatch (sem deadlock).
    static bool sendLogFrame(const char* line, size_t n);

    // Envia um frame KL_DEBUG_DATA (binario puro, sem byte de status) pelo
    // canal ativo: a saida do debugger Duktape. Mesma rota thread-safe do
    // logcat — chamado pela task do app dentro do write callback.
    static bool sendDebugFrame(const uint8_t* data, size_t n);

    // Envia um frame KL_RES_DATA (device->host nao-solicitado) pelo canal
    // ativo: o DATA de sessao do gateway USB (Onda B, UsbRes.h) — resposta
    // de READ do gpio, amostra de sensor, publish. Mesma rota thread-safe
    // do logcat/debug (mutex proprio); a saida e o registrador
    // Resources::usbSetSend.
    static bool sendResFrame(uint16_t sid, uint16_t seq, const uint8_t* data, size_t n);

    // Parametros anunciados no HELLO proto 2.
    uint8_t window() const { return m_window; }
    bool v2() const { return m_parser.v2(); }
    // Troca o formato dos frames da SESSAO (handleHello negocia; a resposta
    // do proprio HELLO sai no formato anterior — ver HostFrame.h).
    void enableV2(bool on) { m_parser.setV2(on); }

    // Maior payload aceitado: o S3 (CDC/UART com RAM de sobra) trabalha
    // com chunks de 8 KB; o ESP32 classico da CYD mantem 4 KB (heap).
#if CONFIG_IDF_TARGET_ESP32S3
    static constexpr uint16_t MAX_PAYLOAD = 8192;
#else
    static constexpr uint16_t MAX_PAYLOAD = 4096;
#endif

private:
    // Valida o canal, abre/troca a sessao no HELLO e despacha o comando.
    void process(uint8_t cmd, const uint8_t* payload, uint16_t len);
    static void trampoline(void* ctx, uint8_t cmd, const uint8_t* payload, uint16_t len);

    WriteFn m_writer;
    BaudFn m_baudHook;
    uint8_t m_window;

    // Abre os buffers grandes da sessao (payload desta instancia + frame de
    // resposta global). false = sem memoria (HELLO recusado).
    bool openBuffers();
    // Resposta curta montada na stack: erros sem frame de resposta alocado
    void sendShortError(uint8_t cmd, const char* msg);

    // Parser de frames (estado por instancia). Fora de sessao ele usa o
    // buffer pequeno (cabe o HELLO); o de MAX_PAYLOAD so existe da sessao
    // aberta ate o endSession — eram 4 KB (CYD) / 8 KB (S3) de RAM interna
    // fixos por canal so para o celerctl.
    hostframe::FrameParser m_parser;
    static constexpr uint16_t SMALL_PAYLOAD = 64;
    uint8_t m_small[SMALL_PAYLOAD];
    uint8_t* m_big = nullptr;
};

// --- opcodes host -> device ---
constexpr uint8_t KL_HELLO = 0x01;        // payload "CELERCTL1" -> identificacao do device
constexpr uint8_t KL_INFO = 0x02;         // -> JSON versao/board/heap/fs
constexpr uint8_t KL_STAT = 0x04;         // path -> exists,isDir,u32 size,u32 mtime
constexpr uint8_t KL_READ = 0x05;         // path\0 + u32 offset + u32 len -> dados
constexpr uint8_t KL_WRITE_BEGIN = 0x06;  // path -> abre escrita (cria diretorios pais)
constexpr uint8_t KL_WRITE_CHUNK = 0x07;  // dados brutos -> append
constexpr uint8_t KL_WRITE_END = 0x08;    // -> fecha + u32 total escrito
constexpr uint8_t KL_WRITE_ABORT = 0x1C;  // descarta a escrita em curso (remove o parcial)
constexpr uint8_t KL_DELETE = 0x09;       // path\0 [u8 flags: 1=recursivo em diretorios]
constexpr uint8_t KL_MKDIR = 0x0A;        // path
constexpr uint8_t KL_RENAME = 0x0B;       // from\0 + to\0
constexpr uint8_t KL_EXEC = 0x0C;         // cmdline -> u8 exitCode + u32 len + saida
constexpr uint8_t KL_REBOOT = 0x0D;       // ack e reinicia
constexpr uint8_t KL_SET_BAUD = 0x0F;     // u32 baud -> troca o baud do canal (UART)
constexpr uint8_t KL_LOG_ON = 0x10;       // liga o stream de logs (logcat)
constexpr uint8_t KL_LOG_OFF = 0x11;      // desliga o stream de logs
constexpr uint8_t KL_OTA_BEGIN = 0x13;    // -> abre escrita na proxima particao OTA
constexpr uint8_t KL_OTA_CHUNK = 0x14;    // payload -> esp_ota_write
constexpr uint8_t KL_OTA_END = 0x15;      // -> fecha, valida e marca boot (sem reiniciar)
constexpr uint8_t KL_OTA_ABORT = 0x16;    // cancela escrita OTA
constexpr uint8_t KL_SCREENSHOT = 0x17;   // [u8 fmt: 1=RLE] -> u16 w + u16 h + u8 fmt, depois chunks KL_SCR_DATA
constexpr uint8_t KL_TOUCH = 0x19;        // u8 n + n × {u8 down,u16 x,u16 y,u16 delayMs}
constexpr uint8_t KL_COREDUMP = 0x1A;     // [u8 flags: 1=nao apagar] -> u32 size, depois chunks KL_COREDUMP_DATA
constexpr uint8_t KL_LS = 0x03;           // path\0 [u32 cursor] -> [u32 next] u16 n + entradas {isDir,size,mtime,name}
constexpr uint8_t KL_LOG_DUMP = 0x1D;     // -> u32 total; conteudo do ring em seguida, em frames KL_LOG_DATA
constexpr uint8_t KL_DEBUG_CTL = 0x1E;    // u8 1=on 0=off -> u8 estado (arma o attach do proximo app)
constexpr uint8_t KL_DEBUG_DATA = 0x1F;   // payload binario do debugger Duktape (dmsg; sem resposta)
constexpr uint8_t KL_STATS = 0x20;        // -> JSON de profiling (celerctl top/stats): heap, tasks com
                                          //    watermark/runtime acumulado e carga do loop/present. Taxas
                                          //    (CPU%, fps) sao calculadas pelo host por delta de 2 fotos
constexpr uint8_t KL_RES_CTL = 0x21;      // tunel ResProto do gateway USB (Onda B; formatos no
                                          //    UsbRes.h): req [subop][reqId][len u16][corpo] ->
                                          //    resp [status][reqId][len u16][corpo]
constexpr uint8_t KL_RES_DATA = 0x22;     // DATA de sessao do gateway USB (device->host, nao-
                                          //    solicitado, como o LOG_DATA): [sid u16][seq u16][bytes]

// --- opcodes device -> host ---
constexpr uint8_t KL_EXEC_CONT = 0x0E;    // continuacao da saida do EXEC (dados puros)
constexpr uint8_t KL_LOG_DATA = 0x12;     // linha de log (texto, com \n)
constexpr uint8_t KL_SCR_DATA = 0x18;     // continuacao do screenshot (RGB565 cru)
constexpr uint8_t KL_COREDUMP_DATA = 0x1B; // continuacao do coredump (binario ELF)

#endif // HOST_LINK_H
