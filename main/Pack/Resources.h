#ifndef CELEROS_PACK_RESOURCES_H
#define CELEROS_PACK_RESOURCES_H

#include <stddef.h>
#include <stdint.h>

#include "ResProto.h"

// Recursos da matilha (API 36): cada no EXPOE o que tem (mic, speaker,
// camera e canais de dados criados por apps) e qualquer membro ABRE o
// recurso de outro. Protocolo de controle e leases em ResProto.h; o
// transporte e o envelope KIND_RES do Pack (unicast com dedup).
//
// Lados:
//   servidor — registro local (nativos do Board::profile + canais do app),
//     arbitragem (exclusivo x compartilhado), politica do dono (settings
//     res_share_mic/cam/spk, padrao "1") e leases: cliente que some devolve
//     o recurso sozinho.
//   cliente — cache dos LIST dos vizinhos (DESCRIBE sob demanda), handles
//     abertos com retry do OPEN, KEEP urgente a cada lease/4, reabertura
//     automatica quando o servidor esqueceu a sessao ("expired") e estado
//     visivel ao JS.
//
// Plano de dados (R2): a sessao vai pelo ESP-NOW (DataLink.h, ate 1458 B por
// mensagem) quando os dois nos o tem num canal comum; senao o DATA viaja no
// envelope da malha (ate resproto::MAX_DATA B, taxa baixa). Os provedores
// nativos de mic/speaker/camera aparecem no LIST sem FLAG_READY (OPEN =
// "unsupported") ate a R3.
//
// Concorrencia: onEnvelope() roda no handler do CelerNet (dentro do mutex
// da malha) e so copia para a caixa de entrada; tudo o mais roda sob o
// mutex proprio daqui — o tick (servico ALWAYS, via Pack::tick) e as
// chamadas do JS vem de tasks diferentes.
namespace Resources {

static constexpr int HANDLES_MAX = 8;

enum State : uint8_t {
    ST_FREE = 0,
    ST_OPENING,   // OPEN enviado, sem resposta ainda
    ST_OPEN,      // ACCEPT recebido: lease vivo
    ST_REFUSED,   // REFUSE (reason diz o porque)
    ST_REVOKED,   // o servidor tomou de volta (reason)
    ST_LOST,      // sem resposta / servidor sumiu da malha
    ST_CLOSED,    // fechado por nos
    ST_DONE,      // foto entregue e gravada (MODE_SNAP)
};

// O que o cliente faz com a sessao (o servidor nao sabe: so o provedor dele
// importa la). Audio so com ESP-NOW; sem canal comum = "noLink".
enum Mode : uint8_t {
    MODE_DATA = 0,   // mensagens para o JS (read/write)
    MODE_PLAY = 1,   // mic remoto -> speaker local (Pack.listen)
    MODE_REC = 2,    // mic remoto -> WAV local (Mic.start({node}))
    MODE_SPEAK = 3,  // mic local -> speaker remoto (Pack.speak)
    MODE_SNAP = 4,   // uma foto da camera remota -> arquivo (Pack.snap)
    MODE_VIEW = 5,   // video da camera remota -> Pack.drawFrame
};

struct Remote {
    uint16_t node;
    char nodeName[16];
    resproto::Entry e;
};

struct HandleInfo {
    State state;
    uint8_t reason;
    uint16_t node;
    bool espnow;    // dados pelo ESP-NOW (false = pela malha)
    uint32_t bytes, total, frames;  // camera: progresso / quadros completos
    char name[resproto::RES_NAME_MAX + 1];
};

// Servico (Pack::init/tick). Idempotente.
void init();
void tick();

// Do handler do Pack (mutex da malha): payload do envelope KIND_RES.
void onEnvelope(uint16_t from, const char* fromName, const uint8_t* payload, size_t len);
// Vizinho saiu da malha: handles com ele viram ST_LOST.
void onMemberLeft(uint16_t id);

// ---- cliente ----
// Recursos conhecidos dos vizinhos (cache). Dispara DESCRIBE para quem nao
// tem cache fresco (resposta chega em ~1 s; o app consulta de novo).
int remotes(Remote* out, int max);
// Destino por id "A1B2" ou nome: malha BLE ou HELLO do ESP-NOW (no ouvido so
// pelo plano de dados, como a esp32-cam com o BLE abafado pelo coex).
bool resolve(const char* to, uint16_t* out);
// Abre (nao bloqueia): handle >= 0 ou -1 (sem slot/malha fora/nome vazio).
int open(uint16_t node, const char* name, const uint8_t* params, size_t plen,
         Mode mode = MODE_DATA, uint32_t maxMs = 0);
// Camera remota: foto (video=false, grava em path e vira ST_DONE) ou video
// (fps 1..10; o app pega o ultimo quadro com takeFrame). quality 5..63.
int openCamera(uint16_t node, bool video, int fps, int quality, const char* path);
// Ultimo quadro completo NOVO do video (o chamador libera com free).
bool takeFrame(int h, uint8_t** buf, size_t* len);
// MODE_REC: gravando (abrindo conta)? / nivel 0..100 / encerra e colhe o WAV
bool recording(int h);
int recLevel();
char* recStop(int h, bool base64, size_t* lenOut, uint32_t* msOut);
bool info(int h, HandleInfo* out);
// O app LOCAL pediu o hardware (Mic.start, playWav...): a sessao remota do
// recurso nativo desse tipo (resproto::TYPE_*) e revogada com "local".
void localClaim(uint8_t type);
// Teto de um DATA (write/publish): 1458 com ESP-NOW (placas com PSRAM).
size_t dataCap();
// Proxima mensagem DATA do handle; false = nada.
bool read(int h, uint8_t* buf, size_t cap, size_t* len);
bool write(int h, const void* data, size_t len);
void close(int h);

// ---- servidor (canais de dados do app) ----
// Canal de dados do app corrente: shared = varias sessoes ao mesmo tempo.
bool expose(const char* name, bool shared);
bool unexpose(const char* name);
// DATA para todas as sessoes do canal; devolve quantas receberam.
int publish(const char* name, const void* data, size_t len);
// Sessoes vivas no canal (-1 = canal inexistente).
int sessions(const char* name);
// Escrita de um cliente num canal nosso.
bool pollWrite(char* res, size_t resCap, uint16_t* from, char* fromName, size_t nameCap,
               uint8_t* data, size_t* len);

// Diagnostico (shell "res"): enlace ESP-NOW, recursos locais, cache dos
// vizinhos, leases e handles, contadores do DataLink/audio.
typedef void (*PrintFn)(void* ctx, const char* fmt, ...);
void dump(PrintFn print, void* ctx);

// Troca de app (JSBindings::init): canais do app saem (REVOKE "gone" para
// os clientes) e os handles abertos pelo app fecham (CLOSE ao servidor).
void appReset();
// Rede da malha mudou (mesh join/leave): derruba sessoes, HELLOs e pares.
void netChanged();

}  // namespace Resources

#endif  // CELEROS_PACK_RESOURCES_H
