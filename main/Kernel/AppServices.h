#ifndef APP_SERVICES_H
#define APP_SERVICES_H

#include <Arduino.h>
#include <string>

/**
 * @file AppServices.h
 * @brief Host de SERVICOS em segundo plano de apps instalados (API 42).
 *
 * Um app declara `"service": "service.js"` no app.json; o host carrega esse
 * JS num heap Duktape COMPARTILHADO (uma thread por servico, global object
 * proprio) e o bombeia pelo servico "appsvc" da tabela CelerServices (ALWAYS:
 * celerLoop e present()). A superficie do servico e o subconjunto sem UI de
 * JsSvc.cpp; timers disparam no pump do host com orcamento de ms por giro.
 *
 * Politica de RAM: em placas SEM PSRAM o heap do svchost e SUSPENSO enquanto
 * um app esta em foreground (o app e dono da RAM) e volta quando ele sai; em
 * placas com PSRAM o servico segue vivo com app aberto. Fatal do heap (OOM
 * profundo) tem a mesma semantica do app: reinicio com o motivo no log.
 */

#if CONFIG_CELEROS_APP_SERVICES

namespace AppServices {

struct Info {
    int found = 0;      // servicos declarados nos apps instalados
    int running = 0;    // threads vivas no svchost
    bool heapAlive = false;
    bool suspended = false;
};

// Boot (celerSetup, depois do scan do launcher): descobre quem declara
// servico. O heap nasce LAZY no primeiro tick — nunca no caminho critico.
void init();

// Corpo do servico "appsvc" (ALWAYS): cria o heap na 1a vez, carrega
// servicos novos, drena os timers com orcamento de ms e aplica paradas.
void tick(bool inApp);

// Placas sem PSRAM: suspende (destroi o heap) antes de abrir app e tenta
// voltar quando ele sai. Com PSRAM sao no-op.
void suspendForApp();
void resumeAfterApp();

// shell svc <list|stop|start|setup> [pkg]
bool stopService(const std::string& pkg);   // para ate o proximo boot/start
bool startService(const std::string& pkg);  // (re)carrega agora
bool rerunSetup(const std::string& pkg);    // esquece o marcador do install.sh
Info info();

// Watchdog do TimeManager: ms desde o ultimo giro do svchost (o fallback
// nativo das cadencias do tempo volta quando o servico morre e ninguem
// ticka ha tempo demais)
uint32_t lastTickAgoMs();

}  // namespace AppServices

#else  // !CONFIG_CELEROS_APP_SERVICES

namespace AppServices {
inline void init() {}
inline void tick(bool) {}
inline void suspendForApp() {}
inline void resumeAfterApp() {}
inline bool stopService(const std::string&) { return false; }
inline bool startService(const std::string&) { return false; }
inline bool rerunSetup(const std::string&) { return false; }
struct Info { int found = 0; int running = 0; bool heapAlive = false; bool suspended = false; };
inline Info info() { return Info{}; }
inline uint32_t lastTickAgoMs() { return 0; }
}  // namespace AppServices

#endif  // CONFIG_CELEROS_APP_SERVICES

#endif  // APP_SERVICES_H
