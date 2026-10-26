#include "Backlight.h"
#include <string>
#include <Arduino.h>
#include "../Utils/CelerSettings.h"
#include "../Utils/Settings.h"
#include "../Utils/StrUtils.h"
#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"

static CelerDisplay* blTft = nullptr;

static int currentLevel = 100;   // nivel escolhido pelo usuario (persistido)
static int appliedLevel = -1;    // nivel no vidro (auto: fracao do escolhido)
static bool autoOn = false;
static float luxAvg = -1;        // media movel do sensor (0..100)
static uint32_t lastTickMs = 0;

// Timeout de tela: sem toque por X ms o backlight apaga; o primeiro toque
// depois disso acorda (e e consumido pelo readTouch).
static uint32_t idleTimeoutMs = 0;   // 0 = desligado
static uint32_t lastActivityMs = 0;
static bool screenOff = false;

bool Backlight::isSupported() { return Board::profile().backlightPwm; }

int Backlight::get() { return currentLevel; }

static void apply(int level) {
    if (level < 5) level = 5;
    if (level > 100) level = 100;
    if (level == appliedLevel) return;
    appliedLevel = level;
    if (blTft && Board::profile().backlightPwm) {
        blTft->setBrightness((uint8_t)(level * 255 / 100));
    }
}

// Auto: o nivel do usuario e o MAXIMO; no escuro cai ate 30% dele
static int autoTarget() {
    float f = 0.3f + 0.7f * (luxAvg < 0 ? 100 : luxAvg) / 100.0f;
    return (int)(currentLevel * f + 0.5f);
}

void Backlight::set(int level, bool persist) {
    if (level < 5) level = 5;
    if (level > 100) level = 100;
    currentLevel = level;
    apply(autoOn ? autoTarget() : level);
    if (persist) {
        // Debounce: apps JS podem chamar System.setBrightness por passo do
        // slider; o servico "settings" grava 2 s depois (flush no sono).
        Settings::setIntDebounced("brightness", level);
    }
}

bool Backlight::autoSupported() { return isSupported() && BoardIO::hasLightSensor(); }

bool Backlight::isAuto() { return autoOn; }

void Backlight::setAuto(bool on, bool persist) {
    autoOn = on && autoSupported();
    luxAvg = -1;
    lastTickMs = 0;
    if (persist) Settings::setBool("auto_brightness", autoOn);
    if (autoOn) {
        tick();  // aplica ja, sem esperar o proximo segundo
    } else {
        apply(currentLevel);
    }
}

void Backlight::tick() {
    // Timeout de tela: apaga SEM chamar apply() (o nivel escolhido segue
    // valido para o despertar); sem PWM nao ha o que apagar. O nivel
    // aplicado e invalidado para o despertar reescrever de verdade (no
    // watch o painel pode estar em SLPIN e a escrita se perder).
    if (idleTimeoutMs > 0 && !screenOff && isSupported() &&
        millis() - lastActivityMs >= idleTimeoutMs) {
        screenOff = true;
        appliedLevel = -1;
        if (blTft) blTft->setBrightness(0);
    }
    if (screenOff) return;  // apagado: nada de auto-brilho rodando
    if (!autoOn) return;
    uint32_t now = millis();
    if (lastTickMs != 0 && now - lastTickMs < 1000) return;  // 1x/s: ADC barato
    lastTickMs = now;
    int lux = BoardIO::lightLevel();
    if (lux < 0) return;
    // media movel: sombra passageira (mao sobre a tela) nao faz a tela piscar
    luxAvg = luxAvg < 0 ? lux : luxAvg * 0.7f + lux * 0.3f;
    int target = autoTarget();
    // histerese: so muda com diferenca perceptivel
    if (appliedLevel < 0 || abs(target - appliedLevel) >= 4) apply(target);
}

void Backlight::setIdleTimeout(uint32_t ms, bool persist) {
    // valores saneados: 0 (nunca) ou 10s..4h
    if (ms != 0) {
        if (ms < 10000) ms = 10000;
        if (ms > 14400000UL) ms = 14400000UL;
    }
    idleTimeoutMs = ms;
    if (screenOff && ms == 0) {
        // religou por config: acorda na hora
        screenOff = false;
        apply(autoOn ? autoTarget() : currentLevel);
    }
    if (persist) Settings::setInt("screen_timeout", (int)ms);
}

uint32_t Backlight::idleTimeout() { return idleTimeoutMs; }
bool Backlight::isOff() { return screenOff; }

bool Backlight::noteActivity() {
    lastActivityMs = millis();
    if (!screenOff) return false;
    screenOff = false;
    apply(autoOn ? autoTarget() : currentLevel);
    return true;  // este toque so acordou: quem leu deve engolir
}

// ---- brilho temporario (dim/AOD) --------------------------------------------

static bool tempDim = false;

void Backlight::dim(int raw255) {
    if (!blTft || !isSupported()) return;
    tempDim = true;
    appliedLevel = -1;  // o apply() do despertar tem que reescrever
    blTft->setBrightness((uint8_t)raw255);
}

void Backlight::undim() {
    if (!tempDim) return;
    tempDim = false;
    appliedLevel = -1;
    apply(autoOn ? autoTarget() : currentLevel);
}

uint32_t Backlight::lastActivity() { return lastActivityMs; }

void Backlight::forceOff() {
    if (screenOff || !blTft) return;
    screenOff = true;
    tempDim = false;
    appliedLevel = -1;
    blTft->setBrightness(0);
}

void Backlight::init(CelerDisplay* tft) {
    blTft = tft;
    int lvl = Settings::getInt("brightness", 100);
    if (lvl < 5 || lvl > 100) lvl = 100;
    set(lvl, false);
    setAuto(Settings::getBool("auto_brightness"), false);
    setIdleTimeout((uint32_t)Settings::getInt("screen_timeout"), false);
    lastActivityMs = millis();
}
