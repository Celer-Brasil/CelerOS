#ifndef CELEROS_PACK_H
#define CELEROS_PACK_H

#include <stddef.h>
#include <stdint.h>

// Matilha (Pack, API 27): o SEMANTICA da malha — quem e o bando e o que os
// membros fazem uns pelos outros. O CelerNet (Bluetooth/CelerNet.h) e o
// transporte (flood, presenca, unicast); o Pack mora acima dele:
//
//   - CAPACIDADES: deriva do Board::profile() o papel do no (speaker, mic,
//     tela, motores, leds, rede) e publica no BEAT; os membros aparecem
//     com o papel deles via members().
//   - ENVELOPES: mensagens tipadas do OS por unicast confiavel —
//     ['P'][kind][msgId u16][payload] com dedup por msgId (o sendTo da
//     malha repete com seq novo; quem deduplica e o envelope). Mensagens
//     SEM o magic 'P' seguem direto para os apps (CelerNet.poll, como
//     sempre foi).
//   - HANDOFF DE MUSICA: a festa chiptune em curso viaja inteira numa
//     mensagem da malha (encodeSong compacto) e o vizinho com alto-falante
//     retoma do MESMO ponto (MusicSynth play com startMs).
//
// E infraestrutura de servico ALWAYS (tabela kServices): sobrevive a troca
// de app. Os callbacks do CelerNet rodam no tick DELE sob mutex — aqui so
// copiam para slots internos e o tick() do Pack consome (nao toca radio
// nem alto-falante de dentro do lock do CelerNet).
namespace Pack {

// payload maximo de um envelope (msg da malha 434 - 4 de cabecalho)
static constexpr size_t MAX_PAYLOAD = 430;

// Kinds do envelope (KIND_RULE e o canal dos reflexos da proxima rodada).
// KIND_RES (API 36): controle dos recursos da matilha (Pack/Resources.h).
enum Kind : uint8_t { KIND_CUSTOM = 0, KIND_MUSIC = 1, KIND_RULE = 2, KIND_RES = 3 };

struct Member {
    uint16_t id;
    char name[16];
    uint8_t caps;   // bits CAPS_* do NetFrame.h
    int8_t rssi;
    uint8_t hops;
    uint32_t lastSeenMs;
};

// Registra no CelerNet (callbacks + caps do Board) — idempotente, chamado
// pelo tick do servico desde o boot (bem antes do auto-start da malha).
void init();

// Membros ouvidos (mais forte primeiro; espelho do CelerNet::nodes com o
// cabecalho do Pack).
int members(Member* out, int max);

// Nossas capacidades publicadas no BEAT (bits CAPS_*).
uint8_t myCaps();

// Envelope unicast (msgId deduplica as copias no destino). Nao bloqueia.
bool send(uint16_t to, uint8_t kind, const void* payload, size_t len, bool urgent);

// Envelope EM NOME de src (0 = nos; o no virtual do PC no cabo, API 41).
// to == o proprio no ou o PC daqui: entrega local, sem radio.
bool sendAs(uint16_t src, uint16_t to, uint8_t kind, const void* payload, size_t len, bool urgent);

// Envelope custom pendente para o JS (fila 4, cheia descarta a antiga).
bool pollCustom(uint16_t* from, char* fromName, size_t nameCap, uint8_t* data, size_t* len);

// Passa a musica em curso para um vizinho (to=0: mais forte com alto-falante).
// false = nada tocando / ninguem para receber / malha fora do ar.
bool handoffMusic(uint16_t to);

// Servico ALWAYS: consome o handoff pendente e atualiza o bit CAPS_HUB.
void tick();

}  // namespace Pack

#endif  // CELEROS_PACK_H
