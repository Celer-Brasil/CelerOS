#pragma once

#include <stddef.h>

// Logs PERSISTENTES no padrao /var/log do Linux:
//   /local/log/kern.log  — firmware (ESP_LOG I/W/E + celer_log_*)
//   /local/log/apps.log  — prints de apps JS (System.print), com o pacote
//                          na frente (programname do syslog)
// Com cartao SD montado a casa muda para /sd/log/ e os tetos sobem (a
// littlefs das boards sem SD e pequena: 8 KB por arquivo). Rotacao estilo
// logrotate: <nome>.log.1 guarda a geracao anterior.
// Puxar na bancada: "celerctl cat /local/log/kern.log" (ou dmesg/appslog no
// app Terminal). O ring RAM do logcat segue como sempre (buffer rapido).
namespace LogPersist {

// Cria o mutex do staging (boot, junto do SerialLink).
void init();

// Linha do firmware (ja normalizada com '\n') — vai pro kern.log.
// Chamado pelo roteador do LogSink sob o mutex DELE: o take aqui e sem
// espera (janela de copia do flush descarta a linha do ARQUIVO, o ring
// RAM continua com ela).
void kern(const char* line, size_t n);

// Print de app JS (msg SEM '\n') — vai pro apps.log como "[pkg] msg".
void app(const char* pkg, const char* msg);

// Servico "logpersist" (CelerServices, ALWAYS): flush do staging para o
// arquivo de 3 em 3 s QUANDO a janela abre — sem audio tocando, sem
// varredura do SD e com o vidro APAGADO (escrever na flash suspende o
// cache e estaciona o nucleo: o DMA do painel RGB embaralha o quadro, o
// I2S engasga). Tela acesa o arquivo em disco ATRASA — o ring RAM do
// logcat segue como sempre (buffer rapido).
void tick();

}  // namespace LogPersist
