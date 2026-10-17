#ifndef CELER_HARDWARE_POWERPOLICY_H
#define CELER_HARDWARE_POWERPOLICY_H

// Politica de energia (API 15, watch): DFS + light sleep automatico do
// ESP-IDF (CONFIG_PM_ENABLE + tickless idle) guiados pelo estado da tela.
//
//   tela plena/dim -> locks CPU_FREQ_MAX + NO_LIGHT_SLEEP (UI fluida);
//   AOD/off        -> sem lock: CPU cai a 40 MHz e dorme entre ticks;
//   USB presente   -> lock NO_LIGHT_SLEEP (TinyUSB/celerctl morrem em light
//                     sleep; no cabo a bateria nao importa).
//
// WiFi ocioso com a tela apagada desliga depois de "wifi_sleep_min" (NVS;
// padrao BoardProfile::wifiSleepMin, 0 = nunca) e volta ao acender.
// Sem CONFIG_PM_ENABLE (demais placas) tudo vira no-op.
//
// Interacao com o svchost (API 42, servicos JS de apps): a decisao de
// dormencia NAO precisa saber deles. O pump (CelerServices, appsvc inclusive)
// roda a cada volta do loop e o loop continua a 5/20/50 ms mesmo dormindo —
// o tickless idle acorda a cada delay, entao timer JS de 1 s toca normalmente
// com a tela apagada/AOD. Quem o WiFi idle-off atinge e servico JS de REDE
// (o radio cai apos wifi_sleep_min com a tela apagada): wifi_sleep_min=0
// desativa a politica e o servico de rede nao e afetado.

namespace PowerPolicy {

void init();  // depois do ScreenPower::init
void tick();  // celerLoop + present() (barato: decide 1x/s)
void reloadSettings();  // rele wifi_sleep_min (System.setting)

// Intervalo do loop da UI: curto com a tela acesa, longo apagada/AOD
// (deixa o tickless idle dormir de verdade).
int loopDelayMs();

}  // namespace PowerPolicy

#endif  // CELER_HARDWARE_POWERPOLICY_H
