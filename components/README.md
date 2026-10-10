# Componentes do CelerOS

Tudo que esta em `components/` entra no build e e codigo do CelerOS: nasceu
da lib compartilhada `esp_components` (satisfaction-hub) e ganhou patches
proprios (lista abaixo). As sobras nao adotadas sairam do tree em out/2026;
estao arquivadas na tag `archive/esp_components` (ou no repo upstream).
Os `idf_component.yml` declaram apenas dependencias de registry; dependencias
entre irmaos ficam nos `REQUIRES` dos CMakeLists, sem `path:`.

## Mapa (quem usa o que no main/)

| Componente | Usado por | Como |
|---|---|---|
| `Network` | `WebManager`, `WifiSetupPortal` | **NetworkManager** e o dono do radio (boot, reconnect/roaming pela background task, scans); **WifiConnection** (STA, via NM); **WifiAP** + **CaptivePortal** (portal de configuracao); **NetworkCredentialStore** (credenciais em NVS, import one-shot do `wifi.txt` legado). Junta os antigos `Connection` + `Wifi`, que se exigiam em ciclo |
| `Http` | `OTA`, `JSBindings Net.*` | `HttpClient` para GET/POST/downloads com progresso |
| `System` | `JSBindings System.getInfo` | `SystemInfo` (chip/heap/PSRAM/uptime/reset reason/MAC) |
| `Storage` | `Network` (credential store) | So a classe `NVS` (wrapper tipado sobre `nvs_flash`) |
| `Utility` | (transitivo) | `Event<>` pub/sub (handlers rodam sob mutex: so tocam flags), `Singleton<>` |
| `ErrorCodes` | (transitivo) | `ErrorCode`/`CommonErrorCodes` |
| `duktape` | `Kernel`, `Runtime` | Duktape 2.7.0 regerado com `celeros_duk_config.yaml` (ES5 enxuto) |
| `LovyanGFX` | tudo que desenha | submodulo upstream |
| `esp_littlefs` | `FileSystem` | vendorada full-source (v1.22.3 upstream, sem patch) |
| `quirc` | `Runtime` (`Camera.scanQR`) | vendorada full-source do upstream (ISC) — ver patch abaixo |

O flash de OTA nao depende de componente: `main/OTA/OtaManager` chama o
`esp_https_ota` direto (HTTPS com bundle de CAs; HTTP so com o opt-in
`/local/ota_allow_http.txt`). O driver da camera (`esp32-camera` v2.1.8,
Apache-2.0) NAO e vendor: entra como managed component com regra
`target esp32 + sdkconfig CELEROS_JS_CAMERA` (`main/idf_component.yml`).

## Patches CelerOS (divergem do esp_components)

- **`Network/CaptivePortal`**: `PortalConnState` + `reportConnectionState()` e
  a rota `GET /status` com polling na pagina — o `/connect` so entrega as
  credenciais via evento; quem conecta e o hospedeiro (`WifiSetupPortal`, no
  loop do modal — nunca no handler httpd).
- **`Network/WifiAP`**: `start()` promove para `WIFI_MODE_APSTA` quando o STA
  esta ativo e o `stop()` preserva o STA em vez de parar o radio inteiro.
- **`Network/WifiConnection`**: nao herda mais `BaseConnection` (sem
  `WifiClient`/`sendRawData`/eventos legados `onConnect`/`onDisconnect`).
- **`Network/NetworkCredentialStore`**: leitura do formato legado sem
  excecoes (`strtol` validado).
- **`Network/NetworkManager`**: o scan de fundo (roaming) so roda com mais
  de uma rede salva — com uma so ele apenas derrubava pacotes de
  requisicoes em curso a cada 30s.
- **`Utility`**: sem `nlohmann/json` (`ListJsonKeys` removido).
- **`Storage`**: so `NVS.cpp` compila (o resto foi arquivado).

## Patches em codigo de terceiros (vendored)

- **`quirc/lib/quirc.c`** (snapshot master 2026, tag v1.2): o buffer de
  imagem (w*h bytes: QVGA 76,8KB / VGA 300KB) sai do `calloc` e passa a
  preferir a PSRAM (`heap_caps_calloc SPIRAM|8BIT`) com fallback para o heap
  padrao — mesma regra da casa para buffers de video. A struct, os capstones
  e a pilha de flood-fill seguem na RAM interna (acesso mais rapido pelo
  classificador). Referencia do truque: ESP32QRCodeReader (alvarowolfx).

## Arquivo (tag archive/esp_components)

As sobras da lib (`BluetoothServer`, `Drivers`, `IoUtility`, `SafeContainers`,
`Supabase`, `UI` LVGL, `UserManaging`, `Time`, `JsonModels`, `config`, restos
de `Connection`/`Wifi`/`Storage`) sairam do tree em out/2026: o repo nao
carrega mais codigo dormente. Para reaver algo: `git show
archive/esp_components:extras/esp_components/<nome>` (ou o repo upstream);
para reviver: copiar para `components/`, garantir as dependencias do
`idf_component.yml` dele e, se precisar de try/catch, reabilitar
`CONFIG_COMPILER_CXX_EXCEPTIONS`.

**Atencao:** o config dessa lib tinha a service_role key do Supabase
commitada — trate como vazada e rotacione. A copia local
(`extras/esp_components/config/config/`, gitignored) foi destruida junto com
a exclusao; a chave nunca esteve no git do CelerOS (historico purgado).

## Requisitos no projeto raiz

```
# CONFIG_COMPILER_CXX_EXCEPTIONS is not set   # nada no build usa try/catch
CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y             # OTA dev via HTTP na LAN — e ainda exige
                                              # /local/ota_allow_http.txt (guard no OtaManager)
```

Particoes com `nvs` (credential store) + `ota_0`/`ota_1` + `otadata` — ver
`partitions_16MB.csv` / `partitions_4MB.csv`.
