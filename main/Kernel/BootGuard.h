#pragma once

/**
 * @file BootGuard.h
 * @brief Contador de boots que nao chegaram ao launcher + modo seguro.
 *
 * O caso que isto fecha: um app de casa/autostart que derruba o boot. Sem
 * contador, o aparelho reinicia para sempre no mesmo app. Tres boots
 * consecutivos que nao completam ~15 s de uptime marcam `safeMode()`: o
 * launcher nao reabre a casa/autostart neste boot e avisa na tela.
 *
 * O contador vive em RAM RTC (sobrevive a panic/watchdog/reboot, sem
 * desgaste de NVS) e e zerado quando o sistema fica estavel. Power-on,
 * deep sleep e brownout NAO contam como falha.
 */

namespace BootGuard {

/** Chamar UMA vez no inicio do celerSetup, antes de qualquer coisa que possa
 *  derrubar o boot. Tambem decide o modo seguro deste boot. */
void noteBoot();

/** Este boot entrou em modo seguro (3 boots anteriores sem estabilizar). */
bool safeMode();

/** O boot ANTERIOR nao chegou a estabilizar (crash/watchdog antes de 15 s).
 *  Usado pelo health check de update de app de sistema: um trial pendente
 *  com boot anterior instavel e revertido. */
bool lastBootUnstable();

/** Servico ALWAYS: depois de ~15 s de uptime, zera o contador RTC. */
void tick();

}  // namespace BootGuard
