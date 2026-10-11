#ifndef CELEROS_PACK_CAM_RES_H
#define CELEROS_PACK_CAM_RES_H

#include <stddef.h>
#include <stdint.h>

// Camera dos recursos da matilha (API 36, R3): fotos JPEG pelo ESP-NOW em
// transferencia CONFIAVEL (bulk) e video de baixa taxa (stream de JPEGs).
//
// Bulk sobre o DataLink (KIND_BULK / KIND_BULK_ACK):
//   BULK      srv->cli [xfer u8][total u32][off u32][dados <= CHUNK]
//   BULK_ACK  cli->srv [xfer u8][n u16][bitmap ceil(n/8)]  bit i = bloco i ok
// O servidor manda a imagem inteira; o cliente responde com o bitmap ao
// completar ou quando a rajada para (250 ms sem bloco novo); o servidor
// reenvia SO os que faltam (ate 4 rodadas). No video (fps > 0) nao ha
// reenvio: quadro incompleto e trocado pelo proximo.
//
// Lados:
//   provedor (no da camera) — task propria por sessao: tira o JPEG
//     (CameraCore::snapJpeg, do modo vigente) e envia; foto unica ou video.
//   cliente — monta a imagem na PSRAM; foto: o tick grava no arquivo pedido
//     (escrita de flash fora da task res_rx); video: o app desenha o ultimo
//     quadro completo (Pack.drawFrame).
// Tudo chamado sob o mutex do Resources, menos o que a task do provedor faz.
namespace CamRes {

static constexpr size_t CHUNK = 1400;
static constexpr size_t MAX_CHUNKS = 256;          // 358 KB: VGA JPEG sobra
static constexpr size_t MAX_IMAGE = CHUNK * MAX_CHUNKS;

bool available();

// ---- provedor ----
// fps = 0: uma foto (confiavel); 1..10: video ate a sessao fechar.
bool serveStart(const uint8_t mac[6], uint16_t sid, uint32_t token, int quality, int fps);
void serveStop(uint16_t sid);
bool serving(uint16_t sid);  // a task desta sessao esta no ar
void onAck(uint16_t sid, const uint8_t* p, size_t len);  // BULK_ACK do cliente

// ---- cliente (um montador por handle) ----
static constexpr int SLOTS = 8;  // = Resources::HANDLES_MAX
void clientBegin(int slot, bool video);
void clientEnd(int slot);
// BULK recebido; devolve true se a imagem completou agora
bool clientChunk(int slot, const uint8_t* p, size_t len);
// temporizador (res_rx, 100 ms): ACK de rajada parada; mac/sid/token do par
void clientTimers(int slot, const uint8_t mac[6], uint16_t sid, uint32_t token);
// progresso da imagem em curso / ultima completa
void clientProgress(int slot, uint32_t* bytes, uint32_t* total, uint32_t* frames);
// Foto completa pendente de gravacao? Entrega o buffer (o chamador libera
// com free) e zera o pendente.
bool clientTakeImage(int slot, uint8_t** buf, size_t* len);
// Video: copia o ultimo quadro completo NOVO (desde a ultima chamada)
bool clientLatest(int slot, uint8_t** buf, size_t* len);

}  // namespace CamRes

#endif  // CELEROS_PACK_CAM_RES_H
