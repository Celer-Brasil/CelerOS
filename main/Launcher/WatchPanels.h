#ifndef CELEROS_WATCH_PANELS_H
#define CELEROS_WATCH_PANELS_H

// Paineis de sistema (API 15), ativos com BoardProfile::watchGestures
// (watch + placas com touch: smartdisplay, cyd):
//   - borda de cima, arrastar para baixo, em tercos horizontais:
//       1/3 esquerdo -> Ajustes rapidos (brilho, volume, WiFi, Nao perturbe,
//          levantar p/ acordar*, AOD*, lanterna, Ajustes)
//          [* so no watch, com a maquina de estados de tela];
//       1/3 central  -> Central de notificacoes;
//       1/3 direito  -> fica com o app: e o gesto que revela a topbar
//          retratil (jogos); tela nativa nao abre painel nele;
//   - borda de baixo, arrastar para cima  -> Central de notificacoes;
//   - borda esquerda, arrastar p/ direita -> sai do app JS (telas nativas ja
//     tinham o voltar).
//
// Telas nativas recebem os gestos pelo hook do Navigator (edgeGesture). Com
// app JS aberto (sincrono, dono do loop) o runtime detecta a borda no
// pollAppChrome, pede o painel (request) e encerra o app pelo caminho limpo
// do X; service() no loop da UI empilha o painel. Fechar um painel aberto a
// partir do app casa (watchface) volta direto para ele.

#include "../UI/Kui.h"
#include <stdint.h>

namespace WatchPanels {

enum class Panel : uint8_t { None, Quick, Notifications };

void init();  // registra o hook de gestos (no-op sem watchGestures)
bool enabled();

// Qualquer task. returnHome = ao fechar, relanca o app casa.
void request(Panel p, bool returnHome);
void service();  // loop da UI

// Borda tocada (coordenadas fisicas): 1 cima, 2 baixo, 3 esquerda, 0 nada.
int edgeAt(int x, int y);

// Terco horizontal da borda de cima (coordenadas fisicas): 0 esquerda,
// 1 centro, 2 direita.
int topThirdAt(int x);

}  // namespace WatchPanels

#endif  // CELEROS_WATCH_PANELS_H
