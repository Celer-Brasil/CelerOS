#pragma once

/**
 * @file UpdateService.h
 * @brief Politica de atualizacao de firmware como servico NATIVO.
 *
 * Antes o "quando" vivia em `data/apps/Nucleo/service.js` (a cada 1 s no
 * svchost): grace de 60 s pos-conexao, intervalo de 24 h por sessao, gates de
 * WiFi/app/shell/OTA e notificacao 1x por versao. O OTA de firmware nao toca
 * a LittleFS, entao um firmware novo nao consertava essa politica — o
 * caminho de reparo dependia de um app. Aqui o dono e o SO; o Nucleo vira
 * painel.
 *
 * Compatibilidade na transicao: o servico escreve `last_check`/`noted_ver` na
 * Storage do pacote `celeros.nucleo` (as chaves que o painel ja le) e o
 * `OtaManager` cacheia o check por 5 min para o Nucleo antigo nao duplicar a
 * rede. O `service.js` do Nucleo pode ser limpo numa proxima publicacao.
 *
 * NAO instala: baixar/aplicar firmware continua sendo acao do usuario
 * (Settings) ou do agente de frota. O servico so descobre e avisa.
 */

namespace UpdateService {

/** Servico ALWAYS: tick de 1 s; o gate interno decide quando checar. */
void tick();

}  // namespace UpdateService
