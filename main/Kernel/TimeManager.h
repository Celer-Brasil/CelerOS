#ifndef TIME_MANAGER_H
#define TIME_MANAGER_H

#include <Arduino.h>
#include <time.h>
#include <string>

class TimeManager {
public:
    static void init();
    static void syncNTP();
    // Retentativa de SNTP enquanto a hora for invalida (chamar no loop);
    // tambem persiste a hora (a cada 10 min) e dispara o alarme do dia
    static void tick(bool networkUp);
    static bool isTimeValid();
    // false = campos fora da faixa (ano 2020..2099); hora nao muda
    static bool setManualTime(int year, int month, int day, int hour, int minute);
    // Epoch UTC vindo de fora (celular via Phone Link): ajusta o relogio e
    // grava no RTC externo. false = epoch antes de 2020.
    static bool setEpoch(time_t epoch);
    // false = TZ vazio, longo (>48) ou com '|'/controle (o config_time.txt
    // separa campos por '|'); fuso nao muda
    static bool setTimezone(const std::string& tzOffset);
    static void setTimeFormat(bool use24h);
    static void setNTPEnabled(bool enabled);

    // Alarme da API 12 (compat): slot 0 do agendador persistente
    // (Kernel/Alarms, API 15) — dispara uma vez na proxima ocorrencia de
    // hh:mm e se desarma; o toque e a AlarmScreen.
    static bool setAlarm(int hour, int minute, const std::string& msg);
    static void clearAlarm();
    // false = desarmado; senao preenche hora/minuto/mensagem
    static bool getAlarm(int& hour, int& minute, std::string& msg);

    // Getters. O tm local do segundo corrente fica em cache (uma localtime_r
    // por segundo, compartilhada): o present() e o redraw em faixas chamavam
    // isso varias vezes por quadro.
    static void copyLocal(struct tm& out);
    static std::string getFormattedTime();
    static std::string getFormattedDate();
    static int getYear();
    static int getMonth();
    static int getDay();
    static int getSeconds();
    static int getWeekday();   // 0=domingo..6=sabado (API 13: System.getWeekday)

    // Preferences state
    static std::string currentTimezone;
    static bool use24hFormat;
    static bool ntpEnabled;

private:
    static void savePreferences();
    static void loadPreferences();
public:
    static void saveEpoch();
    static void restoreEpoch();
};

#endif // TIME_MANAGER_H
