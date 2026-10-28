#pragma once

// Logica pura dos alarmes (API 15): formato de persistencia e calculo da
// proxima ocorrencia com mascara de dias da semana. Header-only, sem ESP-IDF:
// testado no host (test/cpp/run_tests.cpp).
//
// Persistencia (uma key NVS por alarme, valor <= 63 chars):
//   "hh:mm|dias|ativo|rotulo"   ex.: "07:30|62|1|Trabalho"
// dias = mascara bit0 domingo .. bit6 sabado; 0 = uma vez (desarma ao tocar).

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <time.h>

namespace celer {

struct AlarmSpec {
    int hour = 0;
    int minute = 0;
    uint8_t days = 0;      // 0 = uma vez
    bool enabled = true;
    std::string label;
};

constexpr size_t kAlarmLabelMax = 40;

// Rotulo seguro para o formato: sem '|' nem controle, ate kAlarmLabelMax.
inline std::string alarmCleanLabel(const std::string& in) {
    std::string out;
    for (char ch : in) {
        if (out.size() >= kAlarmLabelMax) break;
        unsigned char u = (unsigned char)ch;
        if (u < 0x20 || ch == '|' || u == 0x7F) continue;
        out += ch;
    }
    return out;
}

inline bool alarmValid(const AlarmSpec& a) {
    return a.hour >= 0 && a.hour <= 23 && a.minute >= 0 && a.minute <= 59 && a.days < 0x80;
}

inline std::string formatAlarm(const AlarmSpec& a) {
    char head[24];
    snprintf(head, sizeof(head), "%02d:%02d|%u|%d|", a.hour, a.minute, (unsigned)a.days,
             a.enabled ? 1 : 0);
    return std::string(head) + alarmCleanLabel(a.label);
}

inline bool parseAlarm(const std::string& s, AlarmSpec& out) {
    // hh:mm|dias|ativo|rotulo — rotulo pode faltar (vazio)
    if (s.size() < 9 || s[2] != ':' || s[5] != '|') return false;
    // hh:mm so com digitos: atoi("aa") = 0 transformava registro corrompido
    // num alarme valido da meia-noite
    for (int k = 0; k < 5; k++) {
        if (k == 2) continue;
        if (s[(size_t)k] < '0' || s[(size_t)k] > '9') return false;
    }
    AlarmSpec a;
    a.hour = atoi(s.substr(0, 2).c_str());
    a.minute = atoi(s.substr(3, 2).c_str());
    size_t p1 = s.find('|', 6);
    if (p1 == std::string::npos) return false;
    // mascara antes do cast: atoi("300") truncado para uint8 virava 44 (uma
    // mascara valida) e o alarme tocava nos dias errados
    const long days = atol(s.substr(6, p1 - 6).c_str());
    if (days < 0 || days > 0x7F) return false;
    a.days = (uint8_t)days;
    size_t p2 = s.find('|', p1 + 1);
    std::string en = s.substr(p1 + 1, p2 == std::string::npos ? std::string::npos : p2 - p1 - 1);
    a.enabled = en == "1";
    if (p2 != std::string::npos) a.label = alarmCleanLabel(s.substr(p2 + 1));
    if (!alarmValid(a)) return false;
    out = a;
    return true;
}

// Primeira ocorrencia local de hh:mm ESTRITAMENTE depois de `after`,
// respeitando a mascara de dias (0 = qualquer dia). mktime normaliza
// virada de mes/ano e DST. 0 = alarme invalido.
inline time_t nextAlarmAfter(const AlarmSpec& a, time_t after) {
    if (!alarmValid(a)) return 0;
    struct tm base;
    localtime_r(&after, &base);
    for (int d = 0; d <= 7; d++) {
        struct tm t = base;
        t.tm_mday += d;
        t.tm_hour = a.hour;
        t.tm_min = a.minute;
        t.tm_sec = 0;
        t.tm_isdst = -1;
        time_t at = mktime(&t);
        if (at <= after) continue;
        if (a.days != 0 && (a.days & (1u << t.tm_wday)) == 0) continue;
        return at;
    }
    return 0;
}

}  // namespace celer
