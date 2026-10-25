# Atualização OTA do CelerOS

O CelerOS tem dois mecanismos de atualização de firmware, ambos portados do
conceito do [satisfaction-hub](https://github.com/maikramer) e hoje nativos do
ESP-IDF:

1. **OTA pelo canal de updates** — o dispositivo consulta um `update.json`,
   compara versões e flashea o firmware sozinho com barra de progresso
   (Settings → System Updates → **INSTALL**).
2. **Upload web** — com o servidor web ligado, a página `/update` do file
   manager flashea um `firmware.bin` enviado pelo navegador.

As tabelas de partição (`partitions_16MB.csv` SmartDisplay e
`partitions_4MB.csv` CYD) já têm slots `ota_0`/`ota_1` + `otadata`. O flash é
feito pelo `OtaManager::performUpdate`: a imagem vai para o slot inativo e só é
ativada depois que o `esp_ota_end` valida a imagem inteira — se algo falhar no
meio, o sistema atual continua no ar. Desde a 1.8 o download é **retomável**:
uma conexão que cai é reaberta com `Range: bytes=N-` e continua do byte N
(servidor que ignora Range responde 200 e o aparelho pula os N bytes que já
tem); até 6 falhas seguidas, com espera crescente. A OTA pelo canal também
pega o `OtaGuard` e não colide mais com um `celerctl ota push` ou upload web no
mesmo slot. Credenciais WiFi não se perdem com update: vivem no NVS
(NetworkCredentialStore).

## Esquema do update.json (v2)

```json
{
  "version": "1.1.0",
  "api_version": 2,
  "major_update": true,
  "minor_update": false,
  "security_update": false,
  "changelog": "- Feature A\n- Feature B",
  "guide": "Tap INSTALL to update directly.",
  "firmware_url": "https://.../firmware.bin",
  "firmware_sha256": "64 hex chars",
  "firmware_signature": "128 hex chars (ECDSA P-256 r||s)"
}
```

- Sem `firmware_url`, a tela de update cai no fluxo legado (mostra só o
  changelog + guia manual). Com o campo, aparece o botão **INSTALL**.
- **HTTPS exige `firmware_signature`** (CelerOS 1.11.6+): ECDSA P-256 sobre
  `version`, `api_version`, `firmware_sha256` e `variant`. O aparelho confere
  contra a chave pública embutida em `main/OTA/OtaPublicKey.h` e recusa
  assinatura ausente/inválida antes de baixar. HTTP local (com
  `/local/ota_allow_http.txt`) ainda aceita manifest sem assinatura na
  bancada.
- `firmware_url` relativa (ex.: `"firmware.bin"`) resolve contra o diretório
  do próprio `update.json` — útil para servidores locais.
- Canal por placa: `updates/esp32/update.json` (placa clássica) e
  `updates/smartdisplay_4848S040/update.json` (SmartDisplay 4"). A base está
  em `CELEROS_UPDATE_BASE` em `main/OTA/OtaManager.cpp`.

## Publicar uma versão no CelerOS Hub (canal oficial)

O canal canônico é o hub próprio: `https://os.celer.tec.br/updates` (ver
`CELEROS_UPDATE_BASE` em `main/OTA/OtaManager.cpp`). Repo do servidor:
`~/GitClones/CelerOS-Server` (stack denv `celeros-hub`).

```bash
idf.py -B build-cyd build    # ou build-smartdisplay
python3 ~/GitClones/CelerOS-Server/tools/publish_firmware.py esp32 \
  build-cyd/CelerOS.bin --version 1.3.0 --changelog "- novidade X" \
  --token $CELER_HUB_TOKEN
# SmartDisplay 4": canal smartdisplay_4848S040
```

O publish assina o manifesto automaticamente com a chave privada em
`~/GitClones/CelerOS-Server/env/ota_signing_private.pem` (gitignored; faça
backup — perder a chave exige embutir uma nova pública num release de
firmware). `--signing-key` aponta para outra chave. `tools/ota_sign.py`
assina um `update.json` local (usado no teste de LAN) com o mesmo formato
canônico.

O `update.json` de cada canal (`esp32`, `smartdisplay_4848S040`) é gerado pelo
publish; publicar sem o caminho do `.bin` atualiza só o manifest (o aparelho
mostra as novidades, sem botão INSTALL). Os `updates/*/update.json` deste repo
ficaram como espelho legado do canal antigo no GitHub.

## Testar na LAN (sem o hub)

```bash
idf.py -B build-cyd build
python3 tools/ota_server.py --board smartdisplay
```

Para testar a retomada, `--drop-at BYTES` (repetível) derruba a conexão do
firmware uma vez naquele byte e `--no-range` faz o servidor ignorar `Range`
(200 desde o byte 0). O app de bancada `test/apps/OtaBench` roda a OTA sem
tela a partir da URL em `/local/otabench_url.txt`.

O servidor imprime a URL para gravar em **`/local/ota_url.txt`** no
dispositivo (pelo web file manager ou cartão SD). Enquanto esse arquivo
existir, ele substitui o canal oficial do hub — apague-o para voltar ao
normal.
A versão publicada vem de `CELEROS_VERSION` (`main/CMakeLists.txt`); para o
dispositivo "ver" a atualização, a versão precisa ser maior que a instalada.

Desde a 1.3 o guard de OTA recusa URLs `http://` a menos que o opt-in
**`/local/ota_allow_http.txt`** exista no aparelho (crie um arquivo vazio com
esse nome — `celerctl push`, web file manager ou cartão SD). HTTPS funciona
sem opt-in, por isso o canal de produção não é afetado.

## Testar pelo cabo USB (sem rede e sem esptool)

Com a placa ligada no cabo serial, o `celerctl` grava o firmware direto
na partição OTA inativa e reinicia:

```bash
python3 tools/celerctl.py -b 921600 ota push build/CelerOS.bin
```

Depois do reboot o `celerctl ota push` confere que a placa subiu no slot
gravado (`app_part` no `celerctl info`) e espera a imagem ser confirmada (30 s
de boot são, `app_state` `pending` → `valid`); rollback do bootloader vira
erro. Desde a 1.8 ele também: abre a porta serial em modo exclusivo (um
segundo `celerctl`/monitor na mesma porta falha na hora em vez de corromper o
stream), reenvia a janela quando o parser do aparelho ressincroniza em ruído
da linha (sem abortar em `payload grande demais`) e reenvia o `OTA_END` quando
a resposta se perde (o aparelho confirma de novo um END já aplicado). Um
`HELLO` pela USB não rouba mais a sessão de uma OTA em curso pela WiFi
(`OTA em curso em outro canal`).

Detalhes em [README_USBTOOL.md](README_USBTOOL.md).

## Migração W8 (tabela de partições nova na CYD) — reflash por cabo

O W8 encolheu o core (telas de sistema viraram apps JS no LittleFS) e a
tabela da CYD mudou (`partitions_4MB.csv`): slots OTA de 1,875 MB → 1,75 MB
cada e LittleFS de 128 KB → 384 KB. **OTA em rede não reescreve tabela de
partições** — a migração de um firmware com tabela antiga é uma única vez,
por cabo:

```bash
idf.py -B build-cyd build
python3 -m esptool --chip esp32 -p /dev/ttyUSB0 -b 460800 write-flash \
  0x1000 build-cyd/bootloader/bootloader.bin 0x8000 build-cyd/partition_table/partition-table.bin \
  0xe000 build-cyd/ota_data_initial.bin 0x10000 build-cyd/CelerOS.bin
tools/flash_data.sh cyd /dev/ttyUSB0    # LittleFS: ícones + apps de sistema
```

Depois disso as OTAs normais (rede, web ou `celerctl ota push`) voltam a
funcionar sem cabo. O SmartDisplay 4" (16 MB) não mudou de tabela.

Os apps de sistema (Settings, App Store, Installer, Help, Web Server) agora
vivem no LittleFS e não são afetados por OTA — atualize-os com
`celerctl apps install data/apps/<Nome>` ou pela própria App Store.

> Publicar 1.2.0 no canal: os manifests em `updates/` seguem em 1.1.0 até
> que as placas CYD em campo tenham feito a migração por cabo acima (um
> firmware novo com tabela antiga até caberia no slot, mas o LittleFS de
> 128 KB não comporta os apps de sistema). Quando for publicar, atualize
> `version`/`firmware_url` do manifest do canal da placa.

## Limitações conhecidas

- Downloads HTTPS (manifesto e firmware) validam o certificado do servidor
  contra o bundle de CAs do ESP-IDF; HTTP puro exige o opt-in
  `/local/ota_allow_http.txt` desde a 1.3. Ainda não há assinatura de
  firmware (secure boot / imagens assinadas ficam como evolução futura).
- O bootloader rollback do ESP-IDF não está habilitado, então não há
  rollback automático pós-boot; a proteção é a validação de checksum antes
  da ativação do slot.
- Desde a 1.3 toda rota web — `/update` e o file manager inteiro — exige
  HTTP Basic Auth (usuário `admin`, senha gerada no primeiro boot; veja no
  app Web Server ou `celerctl info`). 5 senhas erradas travam o servidor web
  por 30 s. As rotas de escrita continuam exigindo o cabeçalho
  `X-Celer-Request` por cima (defesa em profundidade), ex.:
  `curl -u admin:<senha> -H 'X-Celer-Request: 1' -F 'update=@CelerOS.bin' http://<ip>/update`.
