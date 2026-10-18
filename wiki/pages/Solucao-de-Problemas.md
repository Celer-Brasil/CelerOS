# Solução de problemas

[English](/maikramer/CelerOS/wiki/Troubleshooting) | **Português (BR)**

Problemas comuns, em ordem aproximada de "você vai bater nisso".

## Build e flash

* **Uma mudança no `sdkconfig.defaults` não fez efeito.** Um diretório de
  build existente guarda o `sdkconfig` em cache; apague
  `build*/sdkconfig` (ou o diretório inteiro) e reconfigure com a linha
  completa de `-DSDKCONFIG_DEFAULTS=...` + `-DCELEROS_BOARD=...` da página
  [Compilando e gravando](/maikramer/CelerOS/wiki/Compilando-e-Gravando).
* **LovyanGFX faltando / erros esquisitos de include.** É um submodule do
  git: `git submodule update --init`.
* **`flash_data.sh` falha.** Ele precisa do ambiente IDF exportado
  (`IDF_PATH`) porque usa o `mklittlefs` e o `parttool` do IDF.
* **Porta ocupada (`could not open port`).** Só um programa por porta:
  feche o `idf.py monitor` (e qualquer console serial) antes de rodar o
  `celerctl` ou gravar. Nesta mesa a SmartDisplay costuma estar em
  `/dev/ttyUSB0` e a CYD em `/dev/ttyUSB1`, mas confira com
  `python3 tools/celerctl.py devices`.

## Primeiro boot e toque

* **O aparelho pede para tocar em alvos em cruz.** É a calibração do toque
  resistivo (família CYD) — roda quando não há calibração salva e guarda
  em `/local/touch_cal_p.bin`.
* **Toque desalinhado / quero recalibrar.** Apague a calibração e
  reinicie:

  ```bash
  python3 tools/celerctl.py rm /local/touch_cal_p.bin
  python3 tools/celerctl.py reboot
  ```
* **O toque pede pressão.** Painel resistivo funciona assim: pressione um
  pouco mais forte que num celular, ou opere o aparelho pelo navegador
  ([tela ao vivo](/maikramer/CelerOS/wiki/Interface-Web)).

## Tela do SmartDisplay

* **A imagem inteira treme alguns pixels (só dentro de jogos/apps JS).**
  Corrigido no firmware com nível de API 32: o painel RGB recomeça a
  varredura a cada quadro por uma interrupção, e essa interrupção dividia
  um núcleo da CPU com o motor JavaScript — qualquer atraso deslocava a
  imagem (~12 px por microssegundo). Atualize o firmware (OTA ou flash).
  Para conferir um aparelho, rode `lcddma 300 isr` no shell serial
  (`celerctl shell "lcddma 300 isr"`): o `LCD_CAM` tem que aparecer em
  `CPU 1`, e a contagem de underflow deve ser 0 (diferente de zero = o
  painel está sem banda de memória).
* **A interface inteira embaralha depois de um build próprio.** Não ligue
  `CONFIG_ESP32S3_DATA_CACHE_LINE_64B` no SmartDisplay: o painel lê o
  framebuffer direto da PSRAM e a linha de cache de 64 bytes o estrangula.

## Wi-Fi e relógio

* **Sem credenciais salvas.** O aparelho abre o access point
  `CelerOS-Setup-XXXX` com portal cativo — configure pelo celular. O Wi-Fi
  reconecta sozinho se o roteador cair.
* **Relógio com hora errada.** A hora vem do NTP (`pool.ntp.org`) e
  precisa de internet; o fuso é configurado em Settings → Hora e fuso (o
  relógio do launcher fica em UTC num flash limpo). A configuração mora em
  `/local/config_time.txt` na forma `UTC3|1|1` (sinal POSIX invertido:
  `UTC3` = UTC-3).
* **Hub/OTA falha com erro de TLS.** Hub e Google ficam atrás da Cloudflare
  e exigem
  `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY=y` (já vem nos
  defaults — veja acima se o seu `sdkconfig` está velho).

## Apps

* **Um app da loja não instala/abre na CYD.** Apps maiores aparecem como
  "Requer PSRAM": a CYD não tem PSRAM e entrega ~220 KB de heap JS, com
  teto prático de um `main.js` de ~60 KB.
* **App crasha ou volta ao launcher.** Acompanhe ao vivo com
  `python3 tools/celerctl.py logcat` e, depois do crash, baixe o coredump
  com `celerctl coredump` (ELF para o GDB/ferramentas xtensa). O último
  erro de app também fica persistido em `/local/lastcrash.txt` (versão do
  OS, data, uptime, app + stack completa; sobrevive a reboot) — o
  `lasterror` do shell serial mostra tamanho e horário da gravação, e o
  file manager web consegue ler o arquivo. Em builds com debugger, o
  `celerctl debug MyApp` pausa no ponto do throw para inspecionar o estado.
* **`SyntaxError` no aparelho mas funciona no Node.** A engine é Duktape:
  **só ES5** — sem arrow functions, `let`/`const`, `class` ou template
  literals. Teste os apps embutidos no host com
  `node test/js_harness/run.js`.
* **Notificação "install.sh falhou" em todo boot.** Um app traz um
  `install.sh` (setup do serviço em segundo plano, API 42) que falhou —
  a falha não grava o marcador de versão, então o script é reexecutado e
  re-notificado em TODO boot até passar. Ele roda no `sh` restrito do
  device: dialeto `if COND` / `else` / `end` (não é o Bourne — não
  existe `then`/`fi`), sem aspas, e só caminhos absolutos dentro da
  pasta do app e de `/local/data/<pkg>`. O corpo da notificação nomeia o
  app; a linha de erro do shell está nas entradas `[setup]` de
  `celerctl shell "cat /local/log/kern.log"` (atenção: o log em disco só
  é descarregado com a tela apagada — prefira `celerctl logcat --dump`).
  Depois de corrigir, rode `celerctl shell "svc setup <pkg>"`; silêncio
  significa que o marcador fechou.
* **`CelerLink is not defined`.** A placa foi compilada sem Bluetooth
  (`CONFIG_CELEROS_BLUETOOTH`; maduro na SmartDisplay, experimental na
  CYD). Apps detectam com `typeof CelerLink !== "undefined"`.
* **O Celer Link não acha/conecta no outro aparelho.** O `scan()` bloqueia
  ~2,5 s e só vê aparelhos rodando `CelerLink.start()` (anunciam como
  `Celer-XXXX`); uma conexão por vez, mensagens de até 240 bytes.

## Interface web

* **`401 Unauthorized`.** Basic Auth: usuário `admin`, senha exibida no
  app Web Server ou no `celerctl info` (campo `web_pass`).
* **`429 Too Many Requests`.** Vários logins falhos travam o servidor por
  30 s — espere e tente com a senha certa.
* **Espelho lento.** ~1–2 fps é normal na CYD (quadros RLE via HTTP num
  painel SPI de 40 MHz); a SmartDisplay é mais rápida. Ler a tela nunca
  congela o aparelho — os quadros são pego bloco de linhas por bloco.
* **O IP mudou.** Ele aparece no aparelho (app Web Server) e no
  `celerctl info`; prefira uma reserva de DHCP no roteador.

## celerctl

* **`devices` não lista nada.** Confira cabo e porta (`/dev/ttyUSB*`) e se
  nenhum monitor segura a porta. A ferramenta só fala HostLink — uma placa
  com firmware ESP-IDF cru não responde.
* **Push/pull lento.** Negocie um baud maior: `celerctl -b 921600
  push ...`.
* **Frames truncados/esquisitos depois de uma desconexão.** O parser
  ressincroniza depois de um frame cortado; com o proto 2 o CRC32 também
  descarta quadros corrompidos e a transferência tenta de novo sozinha.
  Uma sessão deixada em baud alto (há menos de 8 s) é achada
  automaticamente na próxima abertura — sem desconectar/reconectar o USB.
