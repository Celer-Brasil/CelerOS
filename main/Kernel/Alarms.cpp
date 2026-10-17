#include "Alarms.h"
#include "TimeManager.h"
#include "../Utils/CelerSettings.h"
#include "esp_log.h"
#include <mutex>
#include <stdio.h>
#include <stdlib.h>

using celer::AlarmSpec;

namespace {

// Estado tocado pela UI (celerLoop) e pelos apps (present / bindings, na
// task "celerapp" com CELEROS_APP_TASK): um mutex para tudo.
std::mutex s_mux;
bool s_loaded = false;
bool s_used[Alarms::MAX] = {};
AlarmSpec s_alarms[Alarms::MAX];
time_t s_timerAt = 0;
std::string s_timerLabel;
time_t s_snoozeAt = 0;
int s_snoozeId = -1;
std::string s_snoozeLabel;
time_t s_lastCheck = 0;  // eventos em (s_lastCheck, agora] disparam
bool s_ringing = false;
time_t s_prevNow = 0;    // amostra do relogio do tick anterior
bool s_prevValid = false;
Alarms::Ring s_ring;

void keyFor(int id, char* buf, size_t n) { snprintf(buf, n, "alarm%d", id); }

void persistSlot(int id) {
    char key[12];
    keyFor(id, key, sizeof(key));
    if (s_used[id]) {
        CelerSettings::set(key, celer::formatAlarm(s_alarms[id]).c_str());
    } else {
        CelerSettings::erase(key);
    }
}

void persistTimer() {
    if (s_timerAt == 0) {
        CelerSettings::erase("timer_at");
        CelerSettings::erase("timer_lbl");
        return;
    }
    char v[24];
    snprintf(v, sizeof(v), "%lld", (long long)s_timerAt);
    CelerSettings::set("timer_at", v);
    CelerSettings::set("timer_lbl", celer::alarmCleanLabel(s_timerLabel).c_str());
}

void persistSnooze() {
    if (s_snoozeAt == 0) {
        CelerSettings::erase("snooze_at");
        return;
    }
    char v[64];
    snprintf(v, sizeof(v), "%lld|%d|%s", (long long)s_snoozeAt, s_snoozeId,
             celer::alarmCleanLabel(s_snoozeLabel).substr(0, 30).c_str());
    CelerSettings::set("snooze_at", v);
}

void loadLocked() {
    if (s_loaded) return;
    s_loaded = true;
    for (int i = 0; i < Alarms::MAX; i++) {
        char key[12];
        keyFor(i, key, sizeof(key));
        std::string v = CelerSettings::get(key, "");
        s_used[i] = !v.empty() && celer::parseAlarm(v, s_alarms[i]);
    }
    std::string t = CelerSettings::get("timer_at", "");
    s_timerAt = t.empty() ? 0 : (time_t)atoll(t.c_str());
    s_timerLabel = CelerSettings::get("timer_lbl", "");
    std::string sn = CelerSettings::get("snooze_at", "");
    if (!sn.empty()) {
        s_snoozeAt = (time_t)atoll(sn.c_str());
        size_t p1 = sn.find('|');
        size_t p2 = p1 == std::string::npos ? p1 : sn.find('|', p1 + 1);
        if (p2 != std::string::npos) {
            s_snoozeId = atoi(sn.c_str() + p1 + 1);
            s_snoozeLabel = sn.substr(p2 + 1);
        }
    }
}

void startRingLocked(Alarms::Kind kind, int id, const std::string& label) {
    s_ringing = true;
    s_ring.kind = kind;
    s_ring.id = id;
    s_ring.label = label.empty() ? (kind == Alarms::Kind::Timer ? "Timer" : "Alarme") : label;
    ESP_LOGI("celer.alarm", "tocando: %s", s_ring.label.c_str());
}

}  // namespace

namespace Alarms {

void init() {
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
}

int add(const AlarmSpec& a) {
    if (!celer::alarmValid(a)) return -1;
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    // slot 0 fica por ultimo: e o do compat (setAlarm da API 12)
    for (int i = 1; i <= MAX; i++) {
        int id = i % MAX;
        if (s_used[id]) continue;
        s_used[id] = true;
        s_alarms[id] = a;
        s_alarms[id].label = celer::alarmCleanLabel(a.label);
        persistSlot(id);
        return id;
    }
    return -1;
}

bool set(int id, const AlarmSpec& a) {
    if (id < 0 || id >= MAX || !celer::alarmValid(a)) return false;
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    s_used[id] = true;
    s_alarms[id] = a;
    s_alarms[id].label = celer::alarmCleanLabel(a.label);
    persistSlot(id);
    return true;
}

bool remove(int id) {
    if (id < 0 || id >= MAX) return false;
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    if (!s_used[id]) return false;
    s_used[id] = false;
    persistSlot(id);
    if (s_snoozeId == id) {
        s_snoozeAt = 0;
        s_snoozeId = -1;
        persistSnooze();
    }
    return true;
}

bool get(int id, AlarmSpec& out) {
    if (id < 0 || id >= MAX) return false;
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    if (!s_used[id]) return false;
    out = s_alarms[id];
    return true;
}

bool setTimer(uint32_t seconds, const std::string& label) {
    if (seconds < 1 || seconds > 86400) return false;
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    time_t now;
    time(&now);
    s_timerAt = now + (time_t)seconds;
    s_timerLabel = celer::alarmCleanLabel(label);
    persistTimer();
    return true;
}

void cancelTimer() {
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    s_timerAt = 0;
    s_timerLabel.clear();
    persistTimer();
}

int32_t timerRemaining(std::string* label) {
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    if (s_timerAt == 0) return -1;
    time_t now;
    time(&now);
    if (label) *label = s_timerLabel;
    return s_timerAt > now ? (int32_t)(s_timerAt - now) : 0;
}

bool tick() {
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    time_t now;
    time(&now);
    // Transicao relogio invalido -> valido (NTP/celular chegando; o SNTP seta
    // a hora sem passar pelo clockChanged): um timer ou soneca marcados com
    // o epoch do boot disparariam na hora do salto. Sao contagens
    // regressivas — o salto nao consome o que falta: rebaseia preservando o
    // tempo restante (o descarte da soneca velha em clockChanged cobre so os
    // caminhos manuais, que avisam).
    bool validNow = TimeManager::isTimeValid();
    if (validNow && !s_prevValid && s_prevNow != 0) {
        if (s_timerAt != 0 && s_timerAt > s_prevNow) {
            s_timerAt = now + (s_timerAt - s_prevNow);
            persistTimer();
            ESP_LOGI("celer.alarm", "relogio valido chegou: timer rebaseado");
        }
        if (s_snoozeAt != 0 && s_snoozeAt > s_prevNow) {
            s_snoozeAt = now + (s_snoozeAt - s_prevNow);
            persistSnooze();
            ESP_LOGI("celer.alarm", "relogio valido chegou: soneca rebaseada");
        }
    }
    s_prevNow = now;
    s_prevValid = validNow;
    if (s_ringing) return true;
    // O timer e relativo: vale mesmo com a hora de parede ainda invalida
    // (o epoch corre do boot). Alarmes de hh:mm exigem hora valida.
    if (s_timerAt != 0 && now >= s_timerAt) {
        std::string lbl = s_timerLabel;
        s_timerAt = 0;
        s_timerLabel.clear();
        persistTimer();
        startRingLocked(Kind::Timer, -1, lbl);
        return true;
    }
    if (!TimeManager::isTimeValid()) return false;
    if (s_lastCheck == 0 || now < s_lastCheck || now - s_lastCheck > 86400) {
        // primeira conferencia (boot / wake por timer do deep sleep) ou o
        // relogio pulou: olha 90 s para tras para nao perder o disparo que
        // acordou o aparelho
        s_lastCheck = now - 90;
    }
    if (s_snoozeAt != 0 && now >= s_snoozeAt) {
        int id = s_snoozeId;
        std::string lbl = s_snoozeLabel;
        s_snoozeAt = 0;
        s_snoozeId = -1;
        persistSnooze();
        s_lastCheck = now;
        startRingLocked(Kind::Snooze, id, lbl);
        return true;
    }
    for (int i = 0; i < MAX; i++) {
        if (!s_used[i] || !s_alarms[i].enabled) continue;
        time_t at = celer::nextAlarmAfter(s_alarms[i], s_lastCheck);
        if (at == 0 || at > now) continue;
        if (s_alarms[i].days == 0) {  // uma vez: desarma
            s_alarms[i].enabled = false;
            persistSlot(i);
        }
        s_lastCheck = now;
        startRingLocked(Kind::Alarm, i, s_alarms[i].label);
        return true;
    }
    s_lastCheck = now;
    return false;
}

bool ringing(Ring* out) {
    std::lock_guard<std::mutex> lock(s_mux);
    if (s_ringing && out) *out = s_ring;
    return s_ringing;
}

void dismiss() {
    std::lock_guard<std::mutex> lock(s_mux);
    s_ringing = false;
}

void snooze() {
    std::lock_guard<std::mutex> lock(s_mux);
    if (!s_ringing) return;
    s_ringing = false;
    time_t now;
    time(&now);
    s_snoozeAt = now + SNOOZE_MIN * 60;
    s_snoozeId = s_ring.id;
    s_snoozeLabel = s_ring.label;
    persistSnooze();
}

void clockChanged() {
    std::lock_guard<std::mutex> lock(s_mux);
    time_t now;
    time(&now);
    // Timer e contagem regressiva: o salto de relogio (ajuste manual, epoch
    // do celular) NAO consome o que falta — sem o rebase, acertar o relogio
    // para frente disparava o timer na hora do salto. O restante vem da
    // amostra do ultimo tick ANTES do salto (s_prevNow, ~1 s de atras);
    // sem amostra ainda (boot) nao ha de onde tirar o restante: segue como
    // esta. Mesma regra do rebase invalido->valido do tick.
    if (s_timerAt != 0 && s_prevNow != 0) {
        time_t rest = s_timerAt - s_prevNow;
        if (rest < 0) rest = 0;
        if (rest > 86400) rest = 86400;  // teto do setTimer
        s_timerAt = now + rest;
        persistTimer();
        ESP_LOGI("celer.alarm", "relogio trocado: timer rebaseado (%lld s restantes)",
                 (long long)rest);
    }
    s_lastCheck = now;
    // Soneca marcada com o relogio ainda invalido (epoch do boot): quando a
    // hora real chega por NTP/celular, o resto absurdamente atrasado
    // dispararia no proximo tick. Soneca legitima nasce a SNOOZE_MIN minutos
    // no FUTURO — mais que um periodo inteiro atras do relogio novo e lixo
    // do relogio antigo: descarta.
    if (s_snoozeAt != 0 && s_snoozeAt < now - SNOOZE_MIN * 60) {
        s_snoozeAt = 0;
        s_snoozeId = -1;
        persistSnooze();
    }
}

time_t nextEvent() {
    std::lock_guard<std::mutex> lock(s_mux);
    loadLocked();
    time_t now;
    time(&now);
    time_t best = 0;
    auto take = [&best](time_t t) {
        if (t != 0 && (best == 0 || t < best)) best = t;
    };
    take(s_timerAt);
    take(s_snoozeAt);
    if (TimeManager::isTimeValid()) {
        for (int i = 0; i < MAX; i++) {
            if (s_used[i] && s_alarms[i].enabled) take(celer::nextAlarmAfter(s_alarms[i], now));
        }
    }
    return best;
}

}  // namespace Alarms
