#pragma once

#include <string>

// Execucao de app JS em task propria (opcao de build CELEROS_APP_TASK, F3).
// Com a flag ligada, o AppHostScreen inicia o app na task "celerapp" e a
// main task segue no celerLoop: relogio do launcher, WebManager (OTA web) e
// TimeManager nao param mais enquanto um app roda. A UI abre mao do touch
// (o app e dono do I2C) e do redraw (o app e dono do vidro) ate o app sair.
//
// O caminho sincrono historico continua sendo o default (flag OFF) — a
// concorrencia nova (touch/display entre tasks) so existe com a flag.
namespace AppRunner {

// true quando o build tem CELEROS_APP_TASK
bool supported();

// Inicia o app em task propria. Retorna false se nao suportado/ocupado
// (o chamador deve cair no caminho sincrono).
bool start(const std::string& filePath, const std::string& title, bool topbarFixed,
            const std::string& appPkg = "", uint32_t perms = 0xFFFFFFFFu);

// false quando nao ha app rodando (ou ja terminou — o chamador faz o pop)
bool running();

}  // namespace AppRunner
