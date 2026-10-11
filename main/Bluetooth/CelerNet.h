#ifndef CELEROS_BT_CELER_NET_H
#define CELEROS_BT_CELER_NET_H

#include <stddef.h>
#include <stdint.h>

#include "NetFrame.h"

// CelerNet: malha BLE entre CelerOS por flood de advertising (API 26; v2 na 27).
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
// Filtro de rede: so entram quadros com o MESMO netId (FNV-1a 16 bits do
// nome da rede, setting "celernet_net", default "celer"). v1 ABERTA: os
// pacotes vai em claro no ar — criptografia com chave compartilhada fica
// para uma v3. Identidade do no: 2 ultimos bytes da MAC BT (zero config).
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
    static constexpr size_t MAX_NAME = netframe::DATA_MAX - 1;  // 15 (BEAT: caps + nome)
    static constexpr int RX_DEPTH = 8;       // mensagens entregues ao JS
    static constexpr int NODES_MAX = 16;     // presenca ouvida
    static constexpr uint8_t TTL_DEFAULT = 4;

    // No ouvido (BEAT recente). lastSeenMs e a idade bruta (millis).
    struct Node {
        uint16_t id;
        char name[MAX_NAME + 1];
        uint8_t caps;                    // CAPS_* do NetFrame.h (papel na matilha)
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
        uint16_t netId;                 // FNV do nome da rede
        char name[MAX_NAME + 1];
        char net[16];                   // nome da rede (setting)
        uint16_t txQueued;              // quadros proprios na fila
        uint32_t txDropped;             // envios recusados (fila cheia/sem ficha)
        uint32_t txStarted;             // bursts que SAIRAM no ar (bench)
        uint32_t txFail;                // adv_start/adv_set_data falhou (bench)
        uint32_t txNoToken;             // bursts devidos esperando ficha (bench)
        uint32_t rxDropped;             // entregas perdidas (fila RX cheia)
        uint32_t relayed;               // quadros de outros repetidos
        uint32_t relayDropped;          // repeticoes descartadas (anel de TX cheio)
        uint16_t heard;                 // nos na tabela de presenca
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

    // Liga o no (name/net nullptr = mantem o setting atual). relay=false:
    // so escuta/anuncia presenca, nao repete (economia). Persiste
    // "celernet"="1" e, dados, "celernet_name"/"celernet_net".
    static bool start(const char* name, const char* net, bool relay);
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
