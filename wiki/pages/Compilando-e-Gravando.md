# Compilando e gravando

[English](/Celer-Brasil/CelerOS/wiki/Building-and-Flashing) | **Português (BR)**

O CelerOS 1.2+ usa **ESP-IDF 6.1 puro** (sem camada Arduino/PlatformIO).

## Só quer gravar numa placa? (release de fábrica, sem toolchain)

Cada tag `v*` no GitHub publica um **pacote de fábrica**: um zip por placa
(firmware + partição de dados + `flash.json` + `README.txt`) e o
**CelerOS Flasher** para linux e windows (esptool embutido). É o caminho
recomendado para a primeira instalação — sem ESP-IDF, sem build:

1. Baixe o **CelerOS_Flasher** do seu sistema e o **zip da sua placa** em
   [releases](https://github.com/Celer-Brasil/CelerOS/releases).
2. Extraia os dois na mesma pasta e execute o flasher.
3. Escolha a **placa** e a **porta USB** em que ela está.
4. Responda **"apagar tudo" = sim** (a 1ª gravação limpa uma NVS antiga),
   dê ENTER — as imagens são gravadas com verificação e a placa boota
   direto no CelerOS.

Porta não aparece? Instale o driver USB-serial do seu adaptador (CP210x ou
CH34x) e reconecte a placa. Prefere o caminho manual? O `README.txt` de
cada zip traz a linha `esptool write-flash` exata, com todos os offsets.

Depois disso as atualizações chegam por OTA (Ajustes > Atualizacao no
aparelho) — releases são para o primeiro flash.

## Pré-requisitos

```bash
git clone https://github.com/Celer-Brasil/CelerOS.git && cd CelerOS
git submodule update --init          # LovyanGFX
source ~/esp/v6.1/esp-idf/export.sh  # ESP-IDF v6.1 instalado
```

Os componentes de terceiros (ArduinoJson, esp_littlefs, nlohmann/json) são
baixados pelo component manager do ESP-IDF; o LovyanGFX é um submodule —
clone com `--recurse-submodules` ou rode o `git submodule update --init`.

## Build e flash por placa

O alvo é escolhido com `-DCELEROS_BOARD=` (`smartdisplay` é o default):

```bash
# SmartDisplay 4" (ESP32-S3)
idf.py -B build -DSDKCONFIG=build/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/smartdisplay/sdkconfig.defaults" \
  -DCELEROS_BOARD=smartdisplay set-target esp32s3
idf.py -B build build flash -p /dev/ttyUSB0 monitor

# CYD (ESP32 clássico)
idf.py -B build-cyd -DSDKCONFIG=build-cyd/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/cyd/sdkconfig.defaults" \
  -DCELEROS_BOARD=cyd set-target esp32
idf.py -B build-cyd build flash -p /dev/ttyUSB0 monitor

# Watch Waveshare AMOLED 2.06 (ESP32-S3, USB-Serial/JTAG)
idf.py -B build-watch -DSDKCONFIG=build-watch/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/waveshare-watch/sdkconfig.defaults" \
  -DCELEROS_BOARD=waveshare-watch set-target esp32s3
idf.py -B build-watch build flash -p /dev/ttyACM0 monitor

# Cão robô SpotPear (ESP32-S3, USB-Serial/JTAG)
idf.py -B build-dog -DSDKCONFIG=build-dog/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/spotpear-dog/sdkconfig.defaults" \
  -DCELEROS_BOARD=spotpear-dog set-target esp32s3
idf.py -B build-dog build flash -p /dev/ttyACM0 monitor

# Devkit barebone (ESP32 headless)
idf.py -B build-devkit -DSDKCONFIG=build-devkit/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/devkit/sdkconfig.defaults" \
  -DCELEROS_BOARD=devkit set-target esp32
idf.py -B build-devkit build flash -p /dev/ttyUSB0 monitor
```

Cada placa usa um diretório de build próprio (`build/`, `build-cyd/`,
`build-watch/`, `build-dog/`, `build-devkit/`) com o seu `sdkconfig` em
cache — assim dá para alternar alvos sem reconfigurar.

## Partição de dados (LittleFS)

`data/` (apps de sistema, ícones e demos) vira a imagem da partição
`littlefs`, montada em `/local`:

```bash
tools/flash_data.sh smartdisplay /dev/ttyUSB0   # ou: cyd|spotpear-dog|waveshare-watch|devkit <porta>
```

O script precisa do ambiente IDF exportado (`IDF_PATH`) e usa o
`bin/mklittlefs.bin` + o `parttool.py` do IDF. O tamanho da partição é lido
dos `partitions_{4,16,32}MB.csv` — fonte única de verdade — e o overlay
`boards/<placa>/data/` soma por cima de `data/` quando existe (é assim que
o Dog Face entra no cachorro).

Dica: para empurrar um app único sem regravar a partição inteira,

```bash
python3 tools/celerctl.py apps install "data/apps/Settings"
```

## Testes sem hardware (harness desktop)

O harness Node cobre os apps pré-instalados (Terminal, Snake, App Store e
os hub_apps) com as APIs do dispositivo stubadas:

```bash
node test/js_harness/run.js
```

## Servidor OTA local de testes

Para testar o fluxo de OTA sem o hub:

```bash
python3 tools/ota_server.py --board smartdisplay
```

O dispositivo o descobre pelo `/local/ota_url.txt` (ou apontando o
`ota_url` para `http://<seu-ip>:10234`). Detalhes em
[Atualização OTA](/Celer-Brasil/CelerOS/wiki/Atualizacao-OTA).

## Cuidados de sdkconfig

* O projeto exige `CONFIG_COMPILER_CXX_EXCEPTIONS=y` (JsonModels/OtaManager
  usam try/catch) — já vem nos defaults.
* Hub/Google via Cloudflare precisam de
  `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_CROSS_SIGNED_VERIFY=y`.
* `CONFIG_CELEROS_USB_NATIVE` (S3, TinyUSB CDC dupla) **nunca** na
  SmartDisplay 4848S040 — conflito de GPIO. Veja
  [Placas suportadas](/Celer-Brasil/CelerOS/wiki/Placas-Suportadas).
