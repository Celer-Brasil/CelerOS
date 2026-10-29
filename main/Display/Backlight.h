#ifndef CELEROS_BACKLIGHT_H
#define CELEROS_BACKLIGHT_H

#include "Boards/Board.h"

// Controle de brilho do backlight (porte do BrightnessScreen do
// satisfaction-hub, adaptado ao CelerOS). Nivel 5-100 persistido no NVS
// ("brightness", via Settings; o comentario de /local/brightness.txt era do
// porte original).
//
//   SmartDisplay 4" (S3): tft.setBrightness() do LovyanGFX, que aciona o
//   Light_PWM do GPIO38 — sem tocar em canal LEDC na mao.
//   Placa sem PWM no backlight: no-op; isSupported() = false
class Backlight {
public:
    static void init(CelerDisplay* tft);       // aplica o valor salvo no boot
    static void set(int level, bool persist = true);
    static int get();
    static bool isSupported();

    // Brilho automatico pelo sensor de luz (placa com LDR, ex.: CYD): o nivel
    // do usuario vira o maximo e cai ate 30% no escuro. Persistido em
    // "auto_brightness". tick() e barato (le o sensor 1x/s): celerLoop e
    // present() dos apps chamam.
    static bool autoSupported();
    static bool isAuto();
    static void setAuto(bool on, bool persist = true);
    static void tick();

    // Timeout de tela (API 12): sem toque por X ms o backlight desliga; o
    // proximo toque acorda (e e CONSUMIDO — nao clica em nada as cegas).
    // 0 = desligado (default). Persistido em "screen_timeout". Placa sem
    // backlight PWM: no-op. noteActivity() alimenta a qualquer toque REAL
    // ou injetado (kui::readTouch); devolve true se este toque ACORDOU a
    // tela (quem chamou deve engolir o evento).
    static void setIdleTimeout(uint32_t ms, bool persist = true);
    static uint32_t idleTimeout();
    static bool isOff();
    static bool noteActivity();

    // Brilho temporario ABAIXO do fluxo normal (estagios dim/AOD do
    // ScreenPower do watch): escreve direto no vidro e invalida o nivel
    // aplicado, para que o proximo apply()/wake() restaure de verdade.
    // undim() volta ao nivel escolhido; lastActivity() expoe o hub de
    // atividade (toques reais e injetados); forceOff() derruba a tela como
    // se o timeout tivesse batido (glance que expira).
    static void dim(int raw255);
    static void undim();
    static uint32_t lastActivity();
    static void forceOff();
};

#endif // CELEROS_BACKLIGHT_H
