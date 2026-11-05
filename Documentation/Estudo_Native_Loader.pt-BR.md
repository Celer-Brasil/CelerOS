# Estudo: código nativo carregável para apps (loader de blob Xtensa)

**Data:** 2026-11-05
**Status:** spike implementado (API 57, `CELEROS_JS_NATIVE`, smartdisplay); bancada pendente
**Pergunta:** um app pode entregar JS **e** código nativo binário (ex.: core de
emulador) vindo do flash/LittleFS?

## Veredito executivo

| Caminho | Viabilidade | Custo | Alcance |
|---|---|---|---|
| Executar o binário **direto do LittleFS** (mmap do arquivo) | **Não** | — | — |
| **Blob copiado para a PSRAM + chamada por ponteiro** (este spike) | **Sim, em S3 com PSRAM** | loader ~1 página de C + formato de blob | 4848, watch, dog, devkit-s3 |
| **Core compilado no firmware** (padrão physics/Kconfig) | **Sim, em toda placa que couber** | flash do slot OTA por core | todas, inclusive CYD |

A resposta curta: **código nativo carregado do app é possível nas 4 placas S3
com PSRAM** (a rota instrução→cache→PSRAM já está exercitada no smartdisplay
pelo `SPIRAM_XIP_FROM_PSRAM=y`); no ESP32 clássico (CYD/cam/devkit) não há
rota de execução. Para emulador **hoje**, o caminho da casa — core no
firmware, app entregando JS + ROM como dado — é o mais barato, e é exatamente
o que o objeto `Nes` (core Anemoia em `main/Nes/`) está construindo nesta
mesma rodada (trabalho paralelo na árvore).

## Por que não "executar direto do LittleFS"

1. **Fragmentação**: o LittleFS espalha os blocos do arquivo pela partição;
   `esp_partition_mmap` exige offsets contíguos alinhados à página de MMU
   (64 KB). Um arquivo de 200 KB pode estar em pedaços não contíguos.
2. **Janela de mmap**: mapear código exige PTEs livres na janela de
   instrução; no ESP32 clássico a janela já está ocupada pela rodata do
   firmware (e a flash de 4 MB não sobra). No S3 a janela é grande, mas o
   problema 1 continua.
3. **Escrita**: a jail do FS nega escrita em `/local/apps` em runtime
   (de propósito) — instalar/atualizar um blob nativo só pela via do
   instalador.

Conclusão: o arquivo é a **fonte** do código, nunca o **local de execução**.
O loader copia para RAM executável.

## A rota provada pelo spike: PSRAM → cache-sync → ponteiro

ESP32-S3 busca instrução da PSRAM pelo mesmo cache do flash (é o que o
`SPIRAM_FETCH_INSTRUCTIONS` faz com o `.text` do firmware). Um blob qualquer
segue a mesma rota com três passos:

1. `heap_caps_aligned_alloc(64, …, MALLOC_CAP_SPIRAM)` — alinhamento 64 B
   (linha de cache 32 B com folga; `esp_cache_msync` exige alinhamento sem
   a flag `UNALIGNED`);
2. `memcpy` do arquivo para o bloco;
3. sincronização em **duas chamadas** (achado de bancada, 2026-11-05: o
   IDF 6.1 **recusa** `DIR_C2M | TYPE_INST` numa chamada só —
   "C2M direction doesn't support instruction type", `esp_cache_msync.c:145`):
   `esp_cache_msync(base, len_round, DIR_C2M)` (writeback da D-cache, onde a
   escrita aconteceu) e depois `esp_cache_msync(base, len_round,
   DIR_M2C | TYPE_INST)` (invalidação da I-cache). Se a segunda devolver
   `NOT_SUPPORTED` (invalidar I-cache em endereço da janela de dados), a
   primeira carga segue correta: o writeback garantiu o conteúdo e o
   I-cache está frio para o endereço — o risco só existe reusando um bloco
   que já executou código velho (o loader loga o aviso). O código é
   chamável imediatamente.

Precedentes na árvore: littlefs mapeia a partição (`DATA`), LovyanGFX faz
writeback C2M para o framebuffer RGB na PSRAM, e o smartdisplay roda
produção-experimento com fetch de instrução da PSRAM (+1,8 KB de custo,
painel RGB estável no gate da rodada XIP). Nenhuma combinação de código
carregado existia antes — este spike é o primeiro.

### Formato do blob ("CLRN", `tools/native/build_core.py`)

```
96 B de cabeçalho: magic "CLRN" | headerSize | blobSize | chip | api |
                   entryCount | entries[8] (offsets) | pad | sha256[32]
seguido do código plano (objcopy -O binary, base 0)
```

Gates do builder (o blob é **autocontido** por construção):

- `-mno-longcalls` (o toolchain defaulta longcalls = literal com endereço
  absoluto → inexecutável em base arbitrária; com call8 direto PC-relative
  um blob < 256 KB não precisa);
- **zero `l32r` e zero `callx`** no desassembly final (endereço absoluto ou
  chamada indireta = não autocontido);
- **`.data`/`.bss` vazios** (sem globais: estado morre em buffers que o
  loader aloca — o scratch);
- assinatura única de entrada: `uint32_t fn(void* scratch, int32_t a0, int32_t a1)`.

O `chip` no cabeçalho recusa blob de outro alvo (LX6 ≠ LX7: o binário é por
chip); o `api` recusa blob mais novo que o firmware.

### Superfície JS (`main/Runtime/JsNative.cpp`)

`System.nativeLoad(path[, scratchKB])` → handle | -1; `System.nativeCall(h,
fnIdx[, a0, a1])` → uint32; `System.nativeRead(h[, off, maxLen])` → string
(teto 256 B/chamada); `System.nativeFree(h)`; dois blobs por app; blobs
morrem no `init()` do app seguinte (molde `jsPhysicsReset`);
`System.getInfo().hasNative` para feature-detect. Marshalling sem
ArrayBuffer (Duktape tem bufferobject desligado): o handle é dono da
memória, o scratch fica **após o código no mesmo bloco**, e o blit de
quadros reais (futuro) segue o molde `js_packDrawFrame`/`drawSprite` — o
quadro nunca passa pelo heap Duktape.

## Placas

| Placa | Flash | PSRAM | Blob nativo |
|---|---|---|---|
| smartdisplay_4848S040 | 16 MB | 8 MB octal | **sim** (flag ligada; rota XIP provada) |
| waveshare-watch | 32 MB | 8 MB octal | sim (ligar flag; rota igual, gate de bench próprio) |
| spotpear-dog | 16 MB | 8 MB octal | sim (idem) |
| devkit-s3 | 16 MB | 8 MB octal | sim (idem) |
| esp32-cam | 4 MB | 4 MB quad | **não** (ESP32 clássico não busca instrução da PSRAM) |
| cyd / cyd-vspi / devkit | 4 MB | — | **não** |

## Riscos e armadilhas (medidos no desenho, não na bancada)

1. **Exec-timeout não vê código nativo** — o hook `cel_exec_timeout_check`
   só dispara entre opcodes Duktape; chamada nativa longa é invisível e o
   TWDT reboota em ~5 s. Contrato da API: **tick curto** (um quadro por
   `nativeCall`, como o step do verlet); o binding renova a janela
   (`noteAppYield`) antes de cada chamada.
2. **Ring-0**: código nativo quebra o sandbox Duktape inteiro (acesso a
   tudo: rádio, NVS, flash). O spike só existe com flag de build ligada —
   **não** é um caminho público ainda. O caminho de produção precisa de:
   permissão nova (`native`) com o diálogo de consentimento existente,
   **assinatura ECDSA P-256 do blob** (mesma infra do OTA:
   `main/OTA/OtaPublicKey.h`, chave privada no server) e gates de catálogo.
3. **ABI do ponteiro**: Xtensa windowed codifica a janela nos 2 bits baixos
   do ponteiro de função; o loader marca `|1` (call8) porque o endereço
   nasce de aritmética, não de `&funcao`. Validado na bancada.
4. **Painel RGB do 4848** é sensível a cache (a linha de 64 B fez a UI
   tremer; 32 B é o padrão da casa). O writeback de um blob grande é o
   mesmo caminho do framebuffer em DMA — medir no bench (soak + `lcddma`).
5. **Core grande** (>128 KB) é barrado pelos tetos atuais de asset do hub
   (`MAX_ASSET_FILE` 128 KB, total 256 KB; device: 272 KB/arquivo,
   448 KB/app). Um core NES real (~50–100 KB `-Os`) cabe; um SNES/Genesis
   não — ou fatia em 2 blobs, ou sobe os tetos (decisão de produto), ou
   vai para o firmware.
6. **ESP32 clássico**: sem writeback de cache (`C2M` é no-op) e sem fetch
   de instrução da PSRAM — não há caminho; qualquer "nativo" nessas placas
   é core no firmware.

## Caminho de produção (pós-spike, se o bench provar)

1. **Assinatura**: campo `sig[64]` no cabeçalho (ECDSA P-256 sobre
   `sha256(blob) + chip + api`), verificação com a chave pública de OTA —
   blobs sem assinatura válida só carregam com `/local/native_allow_unsigned.txt`
   (padrão do `ota_allow_http.txt` da bancada).
2. **Permissão `native`** em `AppPerms.h` (9ª capability) + diálogo do
   launcher (o texto tem que dizer "código nativo tem acesso total ao
   aparelho").
3. **Gates**: `MAX_ASSET_FILE` no lint/celerhub para `.bin` com magic
   "CLRN" (ex.: 512 KB), regra nova no `app_lint` (blob sem magic em
   `native/` = erro).
4. **Real core**: converter o core Anemoia para o formato CLRN (sem
   globais: estado em struct alocada pelo loader; provar zero-reloc) OU
   manter o core no firmware (caminho `Nes` desta rodada) e deixar o
   loader para cores de terceiros no futuro.
5. **Watch (32 MB)**: partição raw dedicada + `esp_partition_write` +
   `esp_mmu_map`/`ESP_PARTITION_MMAP_CODE` dispensa a cópia para PSRAM
   (executa direto do flash mapeado) — só vale se a PSRAM apertar.

## Resultados do spike

| Verificação | Resultado |
|---|---|
| Gates do builder (reloc/l32r/bss) | passam; blob = 103 B código + 96 B cabeçalho |
| Entradas (offsets) | add=0, fib=8, fill=44 |
| Harness (stub espelho JS) | fib(20)=6765, fib(50)=3996334433 (wrap uint32), checksum fill 320×320 = 2863311530 nat = js, leitura do scratch ok |
| `celer.js check` / `js_harness` / lint do app | verdes (API 57 nos quatro lugares) |
| Build smartdisplay (flag ON) | rc=0; `JsNative.cpp.obj` = 2.615 B text + 96 B bss (>512 B: **ledger precisa do update no commit**); slot OTA 59% livre |
| Build CYD (flag OFF) | rc=0; `CELEROS_JS_NATIVE` fora do binário |
| **Bancada 4848 (parcial)** | OTA 1.15.0/API 57 no ar e confirmada (app0); **`hasNative=true` confirmado no device**; app instalado e lança; o loader validou cabeçalho/PSRAM e a instrumentação expôs o bug real do cache-sync (item 3 acima), já corrigido; **captura final do fib/checksum pendente** — a bancada ficou contida pela sessão paralela (OTA em loop na UART) e o bridge WiFi da 4848 engasgou |

Roteiro para fechar a bancada (imagem corrigida já está no device, slot
app0 confirmado): `celerctl apps run celeros.benchnativo` e
`celerctl logcat --dump | grep -E "Native|bench"` → espera-se fib ok,
checksum nat = js, leitura do scratch ok, `load+sync` em µs, ganho do fill
nativo × JS; depois sair/entrar no app 3× (`freePSRAM` volta ao valor de
antes do primeiro load — prova do reset entre apps) e soak de 10 min sem
reboot (TWDT). Lição de bancada: o celerctl instala a pasta em
`/local/apps/<basename da pasta local>` (não no `name` do app.json) — o
app resolve o blob por esse caminho.

## Decisão que fica aberta

- **Core no firmware** (molde physics; o `Nes` desta rodada): atualiza com
  OTA, custo de flash por core, serve TODAS as placas, sem superfície nova
  de segurança. É o caminho para o emulador "oficial".
- **Blob carregável** (este spike): o app carrega o próprio core, atualiza
  pela Loja sem OTA, mas ring-0 exige assinatura + permissão e só S3 com
  PSRAM. É o caminho para cores de terceiros / experimentos rápidos.

Os dois convivem: firmware para os cores estratégicos, loader para a cauda.
