#ifndef CELEROS_BT_CELER_NET_H
#define CELEROS_BT_CELER_NET_H

#include <stddef.h>
#include <stdint.h>

#include "NetFrame.h"

// CelerNet: malha BLE entre CelerOS por flood de advertising (API 26; v2 na 27;
// v3 segura na 37).
//
// CelerOS proximos formam UMA rede: cada no anuncia quadros ADV_NONCONN de
// 31 bytes (NetFrame.h) e escuta o ar; quem ouve um quadro novo entrega ao
// app e REPETE com ttl-1 apos um jitter — os dados cruzam a area por
// saltos, sem nenhuma conexao GATT. O Celer Link par-a-par (pareamento,
// selos, 240 B por pacote) segue intocado para sessoes de alta vazao.
//
// v2 (API 27): o quadro tem CAMPO DST — sendTo() e unicast (so o
// destinatario entrega; o repetidor segue flooding do mesmo jeito), o BEAT
// carrega as CAPACIDADES do no (alto-falante, mic, tela, motores, leds,
// rede — o papel na matilha, ver CAPS_* no NetFrame.h), mensagens urgentes
// (handoff) furam a fila do TX e o kernel pode assinar presenca
// (onMemberEvent) e mensagens (subscribe) sem passar pelo JS.
//
// A malha e INFRAESTRUTURA, nao sessao de app: sobrevive a troca de app
// (nao passa pelo appReset do CelerLink) e o liga/desliga persiste no
// setting "celernet" (CelerSettings). O servico ALWAYS (Services.cpp)
// bombeia o tick nos dois contextos (launcher e app).
//
// v3 (API 37): todo quadro e cifrado e autenticado (AES-CCM) com a chave da
// rede (NetKeys.h): a matilha privada (nome + senha, "mesh join" ou o
// provisionamento) ou a aberta "celer" dos aparelhos nao configurados.
// Quadro que nao autentica e descartado sem entrega nem repeticao; o RPL
// descarta seq repetido (dup de relay e replay). A rede NAO e mais escolha
// do app: o net do start() e ignorado. Identidade do no: 2 ultimos bytes
// da MAC BT (zero config).
//
// Bancada (A/B sem recompilar): /local/celernet_tune.txt, lido em cada
// start(), uma linha "adv=<ms 20..400> defer=<0|1> suppress=<0|1> coex=<0|1|2>"
// — duracao do adv de cada quadro, relay de FRAG esperando a rajada
// silenciar, supressao de relay ja feito por vizinho e bits de malha BLE no
// agendador WiFi x BLE (0 nada, 1 standby = padrao, 2 traffic; na bancada de
// 2026-10-08 as tres variantes ficaram dentro do ruido). Sem o arquivo
// valem os padroes.
// O app test/apps/MeshLab mede as variantes (RTT, entrega por tamanho).
//
// Concorrencia: os callbacks rodam na task do host NimBLE (so enfileiram
// adv reports); todo o resto (dedup, relay, presenca, bursts) roda no
// tick sob mutex — o tick e chamado pelos DOIS pumps (celerLoop e
// present()), que sao tasks diferentes. Os handlers de onMemberEvent /
// subscribe rodam DENTRO desse mutex: so copiam valores e setam flags
// (contrato do components/Utility/Event.h).
class CelerNet {
public:
    static constexpr size_t MAX_MSG = netframe::MSG_MAX;  // 434 (31 frag x 14 B)
    static constexpr size_t MAX_NAME = netframe::DATA_MAX - 2;  // 14 (BEAT: caps + flags + nome)
    static constexpr int RX_DEPTH = 8;       // mensagens entregues ao JS
    static constexpr int NODES_MAX = 16;     // presenca ouvida
    static constexpr uint8_t TTL_DEFAULT = 4;

    // No ouvido (BEAT recente). lastSeenMs e a idade bruta (millis).
    struct Node {
        uint16_t id;
        char name[MAX_NAME + 1];
        uint8_t caps;                    // CAPS_* do NetFrame.h (papel na matilha)
        uint8_t flags;                   // BFLAG_* (v3: nao configurado, admin)
        int8_t rssi;
        uint8_t hops;
        uint32_t lastSeenMs;
    };

    struct Msg {
        uint16_t from;                  // id do no de ORIGEM (nao do repetidor)
        char fromName[MAX_NAME + 1];    // "" se ainda nao ouvido o BEAT dele
        uint16_t dst;                   // DST_BROADCAST ou o nosso id (unicast)
        uint8_t hops;
        int8_t rssi;                    // do ULTIMO salto ouvido
        uint16_t len;
        uint8_t data[MAX_MSG];
    };

    struct Info {
        bool active;
        bool relay;                     // repete quadros de outros (roteador)
        uint16_t node;                  // nosso id (fim da MAC BT)
        uint8_t nid;                    // 8 bits da chave da rede primaria
        bool secure;                    // matilha privada (false = "celer" aberta)
        char name[MAX_NAME + 1];
        char net[16];                   // nome da rede primaria (NetKeys)
        uint16_t txQueued;              // quadros proprios na fila
        uint32_t txDropped;             // envios recusados (fila cheia/sem ficha)
        uint32_t txStarted;             // bursts que SAIRAM no ar (bench)
        uint32_t txFail;                // adv_start/adv_set_data falhou (bench)
        uint32_t txNoToken;             // bursts devidos esperando ficha (bench)
        uint32_t rxDropped;             // entregas perdidas (fila RX cheia)
        uint32_t relayed;               // quadros de outros repetidos
        uint32_t relayDropped;          // repeticoes descartadas (anel de TX cheio)
        uint16_t heard;                 // nos na tabela de presenca
        uint32_t rxAuthFail;            // quadros v3 que nao autenticaram (outra rede)
        uint32_t rxReplay;              // seq ja visto: dup de relay ou replay
        uint32_t rxOther;               // autenticados na rede secundaria (aberta)
    };

    // Evento de presenca (join/leave) e mensagens para o KERNEL (o servico
    // Pack). 1 slot cada; registrados antes do start. Handlers rodam no tick
    // sob mutex: copiar e setar flag, nada mais.
    using MemberEvent = void (*)(uint16_t id, const char* name, uint8_t caps, bool joined);
    using MsgHandler = bool (*)(const Msg& msg);  // true = consumida (nao vai ao JS)
    static void onMemberEvent(MemberEvent cb);
    static void subscribe(MsgHandler h);

    // Capacidades proprias (bits CAPS_*): viajam no BEAT. O servico Pack
    // deriva do Board::profile() + estado da rede; 0 = sem papel.
    static void setCaps(uint8_t caps);
    static uint8_t ourCaps();

    // Liga o no (name nullptr = mantem o setting atual). relay=false: so
    // escuta/anuncia presenca, nao repete (economia). Persiste "celernet"="1"
    // e, dado, "celernet_name". net: ignorado na v3 (so loga se diferente).
    static bool start(const char* name, const char* net, bool relay);
    // A rede primaria do NetKeys mudou (join/leave): zera presenca, RPL,
    // remontagem e fila (o que estava cifrado na rede velha nao serve).
    static void netChanged();
    // Bancada: reinjeta o ultimo quadro autenticado na fila crua (o RPL tem
    // que conta-lo em rxReplay e nao entregar de novo).
    static bool replayLast();
    // Desliga e persiste "celernet"="0".
    static bool stop();
    static bool active();

    // Mensagem para TODA a rede (flood com ttl saltos; clamp 1..8). Entra na
    // fila do TX (nao bloqueia); false = malha desligada/fila cheia.
    static bool broadcast(const void* data, size_t len, uint8_t ttl);

    // Unicast: so o dst entrega (o flood segue inteiro). urgent=true fura a
    // fila do TX (handoff na frente do BEAT). copies>1 reenvia a mensagem
    // com seq novo (redundancia para unicast sem ACK — a ENTREGA pode
    // duplicar; o consumidor trata idempotencia, ex.: msgId no envelope).
    static bool sendTo(uint16_t dst, const void* data, size_t len, uint8_t ttl, bool urgent,
                       uint8_t copies);

    // Unicast EM NOME de src: o nosso id ou o do no virtual (setProxy).
    static bool sendFrom(uint16_t src, uint16_t dst, const void* data, size_t len, uint8_t ttl,
                         bool urgent, uint8_t copies);

    // No virtual (API 41, gateway USB): o PC ligado no cabo vira MEMBRO da
    // matilha com id proprio (packid::pcNodeOf). node 0 desliga. Com proxy:
    // BEAT extra com src=node e BFLAG_PROXY (os vizinhos listam o PC com o
    // nome dado), unicast para node e entregue AQUI (o Pack desvia ao cabo)
    // e sendFrom(node, ...) fala por ele. resolveDest("pc") = o proxy.
    static void setProxy(uint16_t node, const char* name, uint8_t caps);
    static uint16_t proxyNode();

    // Resolve um destino de unicast: id "A1B2" (4 hex) ou NOME do no ouvido
    // (match case-insensitive; nomes duplicados pegam o vizinho mais forte).
    static bool resolveDest(const char* to, uint16_t* out);

    // Mensagem recebida (fila RX_DEPTH, cheia descarta a mais antiga).
    static bool poll(Msg* out);

    // Presenca: nos ouvidos nos ultimos 15 s (mais forte primeiro).
    static int nodes(Node* out, int max);

    static void info(Info* out);

    // Servico ALWAYS (Services.cpp): scanner, bursts, dedup, presenca.
    static void tick();
    static void tickBody();  // o tick ativo (tick() mede o custo dele)

    // Adv report cru da task do host (CelerLink::onGapEvent e o scanner da
    // malha): barato — testa o magic e enfileira; quase tudo volta no 1o if.
    static void onAdvReport(const uint8_t* data, size_t len, int8_t rssi);

    // O setting pede malha ligada no boot? ("celernet" == "1")
    static bool enabledSetting();
};

#endif  // CELEROS_BT_CELER_NET_H
