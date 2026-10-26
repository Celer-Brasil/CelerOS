#include "ScreenPower.h"
#include "Backlight.h"
#include "Theme.h"
#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"
#include "../Kernel/TimeManager.h"
#include "../Kernel/Alarms.h"
#include "../Kernel/Notifications.h"
#include "../UI/Kui.h"
#include "../Utils/CelerSettings.h"
#include "../Utils/Settings.h"
#include "../Utils/I18n.h"
#if CONFIG_CELEROS_PHONE_LINK
#include "../Bluetooth/PhoneLink.h"
#endif
#if CONFIG_CELEROS_BLUETOOTH
#include "../Bluetooth/CelerNet.h"
#endif
#include "esp_log.h"
#include <Arduino.h>
#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <time.h>
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#include "esp_wifi.h"

// packageName do app JS corrente (JSBindings.cpp; via JsInternal.h para o
// runtime — aqui declaramos direto para nao puxar o Duktape no include).
extern std::string s_appPkg;

namespace {

constexpr uint8_t kBrightDim = 0x40;  // ~25% (valor do firmware Rust)
constexpr uint8_t kBrightAod = 0x18;  // brilho do AOD/glance (Rust)
constexpr uint32_t kDimAfterMs = 8000;
constexpr uint32_t kAodAfterMs = 15000;
constexpr uint32_t kBattPollMs = 60000;

CelerDisplay* s_tft = nullptr;
bool s_active = false;
int s_state = 3;          // 3 pleno, 2 dim, 1 AOD, 0 off
bool s_glance = false;    // AOD vindo de raise (expira para off)
uint32_t s_glanceAt = 0;
bool s_blWasOff = false;  // edge do Backlight::isOff()
uint32_t s_blOffAt = 0;   // quando a tela apagou de verdade (auto deep sleep)
int s_lastAodMin = -1;
bool s_keepAwake = false;
uint32_t s_keepAwakeUntil = 0;  // keepAwakeFor(ms): expira sozinho
uint32_t s_glanceMs = 5000;   // 3/5/8 s
uint32_t s_deepSleepMs = 15 * 60000UL;  // auto deep sleep (0 = nunca)
bool s_raiseWake = true;
bool s_aodOn = true;
volatile bool s_glanceReq = false;  // requestGlance (qualquer task)
volatile bool s_beepReq = false;

// Tela presa acesa: flag latched (jogos) OU prazo corrente (keepAwakeFor)
bool awakeHeld() {
    return s_keepAwake || (s_keepAwakeUntil != 0 && (int32_t)(millis() - s_keepAwakeUntil) < 0);
}

bool watchfaceApp() {
    const char* home = Board::profile().homeApp;
    return home != nullptr && s_appPkg == home;
}

// AOD 1x por minuto com deslocamento anti burn-in (porte do render_aod do
// Rust: shift x = min%9-4, y = (min/9)%9-4 percorre a grade 9x9 em ~81 min).
#if CONFIG_CELEROS_UI
void drawAod() {
    if (s_tft == nullptr) return;
    time_t now;
    time(&now);
    struct tm t;
    localtime_r(&now, &t);
    if (t.tm_min == s_lastAodMin) return;
    s_lastAodMin = t.tm_min;

    // Grade anti burn-in: contador de minutos desde a epoca (nao tm_min, que
    // reinicia a cada hora) percorre as 81 celulas da 9x9 em ~81 min — com
    // (min/9)%9 o Y nunca passava de +2 (min <= 59 => min/9 <= 6) e as
    // linhas +3/+4 da grade ficavam virgens.
    const int aodCell = (int)((now / 60) % 81);
    int shiftX = (aodCell % 9) - 4;
    int shiftY = (aodCell / 9) - 4;
    char buf[16];
    snprintf(buf, sizeof(buf), "%02d:%02d", t.tm_hour, t.tm_min);

    s_tft->fillScreen(0x0000);
    s_tft->setTextColor(0x7BEF);  // cinza medio (metade do branco)
    int w = s_tft->textWidth(buf, 6);
    s_tft->drawString(buf, s_tft->width() / 2 - w / 2 + shiftX,
                      s_tft->height() / 2 - 40 + shiftY, 6);

    // Notificacoes nao lidas: ponto + titulo da mais recente
    const int unread = Notifications::unread();
    if (unread > 0) {
        std::string title;
        for (const auto& n : Notifications::list()) {
            if (!n.read) {
                title = n.title;
                break;
            }
        }
        if (title.size() > 22) {
            title = title.substr(0, 21);
            // recuo UTF-8: nao cortar um acento no meio deixava um byte
            // chumbo pendurado antes do "..."
            while (!title.empty() && ((unsigned char)title.back() & 0xC0) == 0x80) title.pop_back();
            if (!title.empty() && ((unsigned char)title.back() & 0x80) != 0) title.pop_back();  // lead do glifo cortado
            title += "...";
        }
        s_tft->setTextColor(0x4A69);
        int tw = s_tft->textWidth(title.c_str(), 2);
        int cx = s_tft->width() / 2 + shiftX;
        int y = s_tft->height() / 2 + 90 + shiftY;
        s_tft->fillCircle(cx - tw / 2 - 12, y + 7, 4, 0x033F);  // ponto azul escuro
        s_tft->drawString(title.c_str(), cx - tw / 2, y, 2);
    }

    // Data por baixo da hora (cinza bem escuro; so um texto a mais no AOD)
    static const char* const kDow[7] = {"DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SAB"};
    char db[16];
    snprintf(db, sizeof(db), "%s %02d/%02d", kDow[t.tm_wday % 7], t.tm_mday, t.tm_mon + 1);
    s_tft->setTextColor(0x2104);
    int dw = s_tft->textWidth(db, 2);
    s_tft->drawString(db, s_tft->width() / 2 - dw / 2 + shiftX, s_tft->height() / 2 + 22 + shiftY,
                      2);

    int pct = BoardIO::batteryPct();
    if (pct >= 0) {
        const int st = BoardIO::chargeState();
        char b[12];
        snprintf(b, sizeof(b), (st > 0 && (st & 1)) ? "+%d%%" : "%d%%", pct);
        s_tft->setTextColor(pct <= 15 ? 0x6000 : 0x39E7);  // vermelho escuro / cinza escuro
        int bw = s_tft->textWidth(b, 2);
        s_tft->drawString(b, s_tft->width() / 2 - bw / 2 + shiftX,
                          s_tft->height() / 2 + 50 + shiftY, 2);
    }
}
#else
// Sem vidro (CELEROS_UI=n) nao ha AOD: o ScreenPower se resume ao bipe das
// notificacoes e a escada de estados (que ninguem consulta). Nao puxa fontes.
void drawAod() {}
#endif

void enterGlance(uint32_t now) {
    const BoardProfile& bp = Board::profile();
    if (s_state == 0 && bp.screenWake) bp.screenWake();  // painel estava em SLPIN
    Backlight::dim(kBrightAod);
    s_glance = true;
    s_glanceAt = now;
    s_state = 1;
    s_lastAodMin = -1;  // força o desenho
    drawAod();
    ESP_LOGI("celer.screen", "glance (raise)");
}

}  // namespace

namespace ScreenPower {

void reloadSettings() {
    if (!s_active) return;
    int offMin = Settings::getInt("screen_off_min", 3);
    if (offMin < 1) offMin = 1;
    if (offMin > 5) offMin = 5;
    int glance = Settings::getInt("glance_sec", 5);
    if (glance != 3 && glance != 8) glance = 5;
    s_glanceMs = glance * 1000UL;
    int dsMin = Settings::getInt("deep_sleep_min", 15);
    if (dsMin < 0) dsMin = 0;
    if (dsMin > 120) dsMin = 120;
    s_deepSleepMs = (uint32_t)dsMin * 60000UL;
    s_raiseWake = Settings::getBool("raise_wake");
    s_aodOn = Settings::getBool("aod");

    // OFF logico continua no Backlight (timeout + wake consumido no touch)
    Backlight::setIdleTimeout((uint32_t)offMin * 60000UL, false);
    ESP_LOGI("celer.screen", "estados de tela (off %d min, glance %d s, raise %d, aod %d, deep %d min)",
             offMin, glance, (int)s_raiseWake, (int)s_aodOn, dsMin);
}

void init() {
    const BoardProfile& bp = Board::profile();
    if (bp.screenSleep == nullptr) return;  // placa sem estados de tela
    s_tft = &Board::display();
    s_active = true;
    reloadSettings();
}

void tick(bool inApp) {
    if (s_beepReq) {  // vale em toda placa (notificacao nova)
        s_beepReq = false;
        BoardIO::toneAsync(1700, 60, 60);  // fora do tick da UI
        BoardIO::toneAsync(1200, 80);
    }
    if (!s_active) {
        s_glanceReq = false;
        return;
    }
    const BoardProfile& bp = Board::profile();
    uint32_t now = millis();

    // Primeiro tick pos-boot: motivo do wake pela sentinela ULP (watch).
    // PEK (tecla PWR), raise e cabo plugado (4) acendem a tela — sem isso
    // so o BOOT acordava.
    static bool s_ulpChecked = false;
    if (!s_ulpChecked) {
        s_ulpChecked = true;
        if (bp.ulpWake != nullptr) {
            const int r = bp.ulpWake();
            if (r == 1 || r == 2 || r == 4) {
                Backlight::noteActivity();
            } else if (r == 3) {
                ESP_LOGW("celer.screen", "wake do ULP: bateria fraca");
#if CONFIG_CELEROS_UI
                kui::Navigator::toast(i18n::TR("Bateria fraca", "Low battery"), THEME_WARN, 4000);
#endif
            }
        }
    }

    if (s_glanceReq) {
        s_glanceReq = false;
        if (Backlight::isOff() || s_state <= 1) {
            enterGlance(now);
        } else {
            s_lastAodMin = -1;  // AOD redesenha com o aviso
        }
    }
    uint32_t idle = now - Backlight::lastActivity();

    // Edges do Backlight (OFF logico): dormir/acordar o painel de verdade
    bool blOff = Backlight::isOff();
    if (blOff && !s_blWasOff) {
        s_blWasOff = true;
        s_blOffAt = now;
        if (!s_glance && s_state != 0) {
            if (bp.screenSleep) bp.screenSleep();
            s_state = 0;
            ESP_LOGI("celer.screen", "tela off (painel em SLPIN)");
        }
    } else if (!blOff && s_blWasOff) {
        s_blWasOff = false;
        if (s_state <= 1) {
            // acordou por toque/config: painel em SLPIN engoliu o brilho que
            // o noteActivity re-aplicou — acorda e re-aplica de verdade
            if (bp.screenWake) bp.screenWake();
            Backlight::undim();
            s_state = 3;
            s_glance = false;
            ESP_LOGI("celer.screen", "tela acordou");
        }
    }

    // Raise -> acorda de verdade (brilho pleno, conta como atividade). Antes
    // virava "glance", que e o proprio AOD: com o AOD na tela (estado normal
    // no watchface) levantar o pulso nao mudava nada. O glance fica para as
    // notificacoes (requestGlance). As arestas acima / o case 1 abaixo
    // acordam o painel e tiram o dim no proximo tick.
    if (s_raiseWake && bp.raisePoll && bp.raisePoll()) {
        if (Backlight::isOff() || s_state <= 2) {
            ESP_LOGI("celer.screen", "raise: acordando (estado %d)", s_state);
            s_glance = false;
            Backlight::noteActivity();
        }
    }

    // Tecla de power do PMU (watch: PEK do AXP2101): curto acorda a tela,
    // segurar dorme de verdade. Poll ~10 Hz (1 leitura I2C barata).
    if (bp.pmuKeyPoll != nullptr) {
        static uint32_t s_pkAt = 0;
        if (now - s_pkAt >= 100) {
            s_pkAt = now;
            int ev = bp.pmuKeyPoll();
            if (ev == 1) {
                Backlight::noteActivity();  // acorda/des-dima
            } else if (ev == 2) {
                deepSleepNow();
            }
        }
    }

    switch (s_state) {
        case 3:
            if (awakeHeld()) break;  // jogo/prazo segurando a tela
            if (idle >= kDimAfterMs) {
                Backlight::dim(kBrightDim);
                s_state = 2;
            }
            break;
        case 2:
            if (awakeHeld() || idle < kDimAfterMs) {
                Backlight::undim();
                s_state = 3;
            } else if (idle >= kAodAfterMs && inApp && s_aodOn && watchfaceApp()) {
                // AOD so sobre o Watchface (ele redesenha a tela inteira por
                // segundo; qualquer outro app segue dim ate o timeout)
                Backlight::dim(kBrightAod);
                s_state = 1;
                s_glance = false;
                s_lastAodMin = -1;
                drawAod();
                ESP_LOGI("celer.screen", "AOD");
            }
            break;
        case 1:
            if (idle < kDimAfterMs) {
                // atividade com AOD normal: acende tudo
                Backlight::undim();
                s_state = 3;
                s_glance = false;
                break;
            }
            if (s_glance && now - s_glanceAt >= s_glanceMs) {
                ScreenPower::sleepNow();  // glance expirou: dorme de verdade
                break;
            }
            drawAod();  // no-op ate o minuto virar
            break;
        default:
            break;
    }

    // Deep sleep automatico (watch): tela apagada de verdade por
    // deep_sleep_min, sem cabo (VBUS segura o USB/celerctl) e sem o celular
    // conectado (Phone Link morre no sono profundo — as notificacoes do
    // Gadgetbridge ficam para o light sleep). A sentinela ULP assume o PWR,
    // o raise filtrado e o alarme por timer.
    if (s_deepSleepMs > 0 && s_state == 0 && s_blWasOff && now - s_blOffAt >= s_deepSleepMs) {
        const int cs = BoardIO::chargeState();
        if (cs >= 0 && (cs & 2)) return;  // na USB/carregando
#if CONFIG_CELEROS_PHONE_LINK
        static bool s_plLogged = false;
        if (PhoneLink::connected()) {
            if (!s_plLogged) {
                s_plLogged = true;
                ESP_LOGI("celer.screen", "deep sleep adiado: celular conectado");
            }
            return;
        }
        s_plLogged = false;
#endif
#if CONFIG_CELEROS_BLUETOOTH
        // No da malha CelerNet ligado: deep sleep derruba a rede do device
        // ate para os vizinhos que o escutam como repetidor.
        static bool s_meshLogged = false;
        if (CelerNet::active()) {
            if (!s_meshLogged) {
                s_meshLogged = true;
                ESP_LOGI("celer.screen", "deep sleep adiado: malha CelerNet ativa");
            }
            return;
        }
        s_meshLogged = false;
#endif
        ESP_LOGI("celer.screen", "tela apagada ha %u min: deep sleep com sentinela ULP",
                 (unsigned)(s_deepSleepMs / 60000UL));
        deepSleepNow();
    }
}

bool suppressAppFrame() { return s_active && s_state <= 1; }

void requestGlance(bool beep) {
    if (beep) s_beepReq = true;
    s_glanceReq = true;
}

void beep() { s_beepReq = true; }

bool active() { return s_active; }

void sleepNow() {
    if (!s_active) return;
    Backlight::forceOff();
    if (Board::profile().screenSleep) Board::profile().screenSleep();
    s_state = 0;
    s_glance = false;
    ESP_LOGI("celer.screen", "tela off (painel em SLPIN)");
}

void setRaiseWake(bool on) {
    s_raiseWake = on;
    Settings::setBool("raise_wake", on);
}

bool raiseWake() { return s_raiseWake; }

void setAodEnabled(bool on) {
    s_aodOn = on;
    Settings::setBool("aod", on);
}

bool aodEnabled() { return s_aodOn; }

int state() { return s_active ? s_state : 3; }

void keepAwake(bool on) { s_keepAwake = on && s_active; }

void keepAwakeFor(uint32_t ms) {
    if (!s_active) return;
    s_keepAwakeUntil = millis() + ms;
}

void deepSleepNow() {
    const BoardProfile& bp = Board::profile();
    ESP_LOGI("celer.power", "deep sleep (EXT1 nos botoes)");

    // Ajustes pendentes do debounce (brilho/volume) antes de hibernar.
    Settings::flush();

    // Painel: dorme mesmo se a tela ainda estava acesa (brilho 0 + SLPIN)
    if (bp.screenSleep && s_state != 0) bp.screenSleep();

    // Ritual da placa: passos no NVS, IMU fora, perifericos da board
    if (bp.sleepPrep) bp.sleepPrep();

    // Canal TX do amp (placa sem codec): dorme com os pinos em nivel baixo
    BoardIO::speakerChannelDown();

    // Radio fora (desconecta limpo; ao acordar e reboot, tudo re-sobe)
    esp_wifi_stop();

    // Sentinela ULP (watch): o coprocessador vigia a tecla PWR do AXP2101,
    // o raise (INT1 filtrada) e a bateria durante o sono. bit1 = o ULP
    // cuida do wake por movimento, e a INT1 sai do EXT1 (o cru acordava em
    // qualquer esbarrão).
    const int ulp = bp.ulpArm != nullptr ? bp.ulpArm() : 0;

    // Wake: EXT1 nivel BAIXO nos botoes do perfil (BOOT do watch; o PWR
    // fala com o AXP2101, sem IRQ ligado a GPIO — quem o acorda e o ULP)
    uint64_t mask = 0;
    // INT do IMU (opt-in "imu_wake": cada movimento forte acorda = boot
    // inteiro, entao fica desligado por padrao). Com o ULP no comando do
    // raise (bit1 acima) a INT fica com ele — filtro melhor que o EXT1 cru.
    const int imuPin = (!(ulp & 2) && Settings::getBool("imu_wake", false)) ? bp.imuWakePin : -1;
    int pins[3] = {bp.buttonPin, bp.buttonPin2, imuPin};
    for (int p : pins) {
        if (p < 0) continue;
        if (rtc_gpio_is_valid_gpio((gpio_num_t)p)) {
            rtc_gpio_init((gpio_num_t)p);
            rtc_gpio_set_direction((gpio_num_t)p, RTC_GPIO_MODE_INPUT_ONLY);
            rtc_gpio_pulldown_dis((gpio_num_t)p);
            rtc_gpio_pullup_en((gpio_num_t)p);
            mask |= 1ULL << p;
        }
    }
    if (mask != 0) {
        // ESP32 classico so tem ALL_LOW/ANY_HIGH no EXT1 (sem ANY_LOW, que e
        // do S2/S3/C3+). Caminho morto nele hoje (placas com botao = S3), mas
        // o firmware compartilhado tem que compilar em todos os alvos.
#if CONFIG_IDF_TARGET_ESP32
        esp_sleep_enable_ext1_wakeup_io(mask, ESP_EXT1_WAKEUP_ALL_LOW);
#else
        esp_sleep_enable_ext1_wakeup_io(mask, ESP_EXT1_WAKEUP_ANY_LOW);
#endif
    }

    // Proximo alarme/timer/soneca acorda o aparelho (reboot -> o Alarms
    // confere 90 s para tras no boot e a AlarmScreen toca)
    time_t next = Alarms::nextEvent();
    if (next != 0) {
        time_t now;
        time(&now);
        if (next > now) {
            esp_sleep_enable_timer_wakeup((uint64_t)(next - now) * 1000000ULL);
            ESP_LOGI("celer.power", "acorda por timer em %lld s (alarme)", (long long)(next - now));
        }
    }

    // RTC externo segura a hora (PCF85063 no proprio oscilador) — nada a fazer
    esp_deep_sleep_start();
}

}  // namespace ScreenPower
