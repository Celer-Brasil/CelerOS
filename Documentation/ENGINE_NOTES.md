# Engine & runtime — notas técnicas (F4)

Avaliação data-driven dos dois pontos abertos da Fase 4: **ES2015+** e
**acentos nas fontes**. Escrita depois da implementação de permissões /
`FS.appData()` / `System.toast` / `System.beep` / i18n nativo.

## ES2015+: QuickJS vs Duktape

O runtime atual é **Duktape 2.7** (ES5.1 + TypedArrays; `Promise`,
`let`/`const`, arrow functions e template literals não existem e **não há
flag de compile que os habilite** — são limitação da implementação). O
validador do hub (`tools/celerhub.py`) já avisa sobre sintaxe ES6 em `main.js`.

Trocar para **QuickJS** (ES2020: `let`/`const`, arrows, classes, `Promise`,
`async`/`await`, módulos) é viável (port ESP32 maduro) mas muda o contrato
inteiro da camada nativa:

| critério | Duktape 2.7 (hoje) | QuickJS |
|---|---|---|
| binário (estimado) | ~450 KB no link atual | ~600–700 KB (+150–250 KB) |
| heap por app | ~90 KB (custom allocator PSRAM) | precisa re-implementar o alocador com reserva interna |
| bindings | 127 `duk_push_c_function` | reescrita completa (JS_SetPropertyFn / classdefs) |
| CYD (slot 1,75 MB) | folga ~260 KB | folga some ou aperta — exigiria `-Os` agressivo |
| GC p/ `System.delay` | mark-and-sweep dirigido | `JS_ExecutePendingJob` + `JS_RunGC` (modelo diferente) |
| isolamento por app | heap destruído por app (funciona bem) | mesmo desenho é possível (runtime por app) |

**Decisão recomendada:** manter Duktape enquanto o alvo CYD (4 MB) estiver
no conjunto de placas suportadas; reavaliar quando (a) a CYD sair de linha
ou (b) o `main.js` > 48 KB virar gargalo real dos apps. O caminho
intermediário — transpilar ES6→ES5 no publish do hub (sucrase/esbuild no
`celerhub.py`) — entrega ES2015 **para quem escreve app** sem tocar no
firmware; ficou anotado como evolução do hub (repo CelerOS-Server).

## Acentos nas fontes

**Implementado (2026-09):** `tools/make_fonts.py` gera
`main/Assets/Fonts/CelerFonts.{h,cpp}` com as MESMAS fontes da UI (DejaVu
9/12/24/40, FreeSans 9/12, FreeSans Bold 12/18/24) cobrindo Latin-1. O ASCII
é copiado verbatim do LovyanGFX (nenhum texto existente muda um pixel); cada
letra acentuada é a letra base original + só o acento, extraído de um render
FreeType (diferença entre a acentuada e a base). Custo: ~21KB de flash na CYD.
`tools/acentuar.py` restaurou os acentos das strings dos apps de sistema e da
UI nativa (só onde a forma sem acento não é palavra — "e/é", "esta/está"
foram revisados à mão). O texto abaixo é a análise anterior, mantida como
histórico.

As fontes builtin 1/2 do LovyanGFX (compat Adafruit) são ASCII — acentos
saem como glifos vazios. O LGFX já embute a família **u8g2** com Latin
completo (por ex. `lgfx::v1::fonts::lgfx_minifont` / `Wendl610`), pagando
~10–30 KB por fonte. Caminho sem tocar no firmware de cada app:

1. expor uma fonte UTF-8 pequena como `System.setFont(3)` no runtime
   (`JSBindings::js_setTextSize` ganha o caso 3 → `setTextFont(&lgfx_minifont)`);
2. apps escrevem acentuado nela; os docs de app passam a recomendar ASCII
   nas fontes 1/2.

Não foi ligado nesta fase porque as strings de UI dos apps estão em
português sem acentos por convenção (e o custo de binário na CYD); a
infraestrutura (i18n do firmware + `System.toast`) já cobre o caso nativo.

## O que a F4 entregou no fim

- `permissions` no `app.json` filtrando `FS`/`Net`/`System.gpio` e as
  chamadas perigosas de `System` (default: tudo — compat).
- `FS.appData()` — pasta privada por `packageName`.
- `System.toast(msg)` e `System.beep(freq, ms)` (LEDC no `speakerPin` do
  BoardProfile; ambas as placas atuais saem com `-1` até buzzer existir).
- i18n do firmware nativo (`Utils/I18n.h`, `System.setting("lang")`).
- Background/services: adiado deliberadamente — depende da `CELEROS_APP_TASK`
  amadurecer em campo; `System.toast` é a fundação de UI para notificações.

## CYD sem PSRAM: estado atual (2026-09, rodada 3)

Substitui as duas secoes historicas abaixo. Todos os apps de sistema rodam
na CYD classica, inclusive os com rede (Settings, App Store), com o radio
WiFi LIGADO. O que mudou, medido no device:

| alavanca | onde | ganho |
|---|---|---|
| builtins do Duktape em ROM (`DUK_USE_ROM_OBJECTS/STRINGS`, global herdado) + nomes da API forcados na ROM (`tools/duk_rom_strings.py`) | `components/duktape` | heap base ~50KB -> 7,6KB (base + API inteira) |
| bindings como lightfunc (`putFns`) | `JSBindings.cpp` | ~130 objetos funcao a menos por app |
| fonte enxuto em streaming (`Utils/JsStrip.h`: sem comentarios/indentacao, linhas preservadas; AST identico, testado no host) em bloco exato, lido ANTES do heap JS | `CelerKernel::runFile` | App Store 44KB -> 31KB contiguos; sem abort de `std::string` |
| unicore + `ESP32_IRAM_AS_8BIT_ACCESSIBLE_MEMORY`: fonte do compile e buffers TLS (>=4KB) na IRAM livre | `boards/cyd` | ~30KB fora do pico do compile; ~20KB de TLS fora do heap 8-bit |
| buffer do Canvas e cache de icones devolvidos ao abrir app | `runFile` | +16KB +~46KB |
| WiFi RX 10->4 estaticos, sem AMPDU; stacks sys_evt/esp_timer pelo uso | `boards/cyd` | ~15KB |

Numeros (CYD): heap 8-bit livre no inicio de um app ~100KB; App Store
compilado ocupa ~62KB (fica ~40KB para o app + TLS). O orcamento do create
(`dukHeapNeed`) e: folga 20KB + base 8KB + 0,75x o fonte enxuto (temporarios
do compile). `System.getInfo().appRAM` expoe o heap livre no inicio do app;
a loja usa `(appRAM - 28000) * 0,55` como teto de main.js sem PSRAM.

Nao existe mais "radio desligado durante o app" (rendia ~3KB e quebrava apps
que usam `Net` sem declarar). Limite pratico: main.js de ~45KB sem PSRAM
(~60KB apos a rodada 4).
O proximo degrau, se preciso: `DUK_USE_PC2LINE` off so na CYD (-9% no
residente, perde numero de linha nos erros).

## CYD classica: heap para apps JS (historico, 2026-09)

A CYD classica (sem PSRAM) tem ~70KB de RAM interna livre no boot; com o
canvas do Kui em bandas (16KB) e o WiFi, sobram ~51KB. O heap base do
Duktape (criacao dos objetos builtin) neste build pede ~50KB — o create
OOMa no meio, e o antigo `my_fatal` alocava `std::string` para desenhar a
tela de erro: abort() dentro do proprio handler, device rebootando sem
mostrar nada (riscos no vidro = tela de erro pela metade).

Estado atual: `dukHeapBudgetOk()` exige ~60KB livres para ABRIR app — na
CYD os apps JS sao recusados com tela "Sem memoria" limpa (sem reboot). O
`my_fatal` desenha tela estatica sem alocar. `my_alloc` nao nega alocacao
durante o run (o caminho de erro do Duktape com alloc parcial derrubava o
spinlock do multi_heap — LoadStoreError medido).

Caminhos futuros (em ordem de custo/beneficio):
1. Config low-memory do Duktape (refcount16, strtable menor): -20~30%.
2. Desligar WiFi durante apps sem permissao "net" (+~35KB).
3. Heap Duktape em buffer estatico unico (sem fragmentar o heap do sistema).
A SmartDisplay (8MB PSRAM) nao e afetada.

## Niveis de hardware (historico, 2026-09, rodada 2 — substituido pela rodada 3)

Apps JS agora rodam na CYD (sem PSRAM) por nivel:
- **Nivel 1 (basico)**: ate ~20KB de main.js e sem a capability "net" — o
  launcher DESLIGA o radio WiFi durante o app (WebManager::suspendRadio,
  ~35KB de heap de volta) e o heap base do Duktape (~50KB) cabe nos ~87KB
  livres. Terminal/Help/Installer/Snake/2048/etc rodam.
- **Nivel 2 (PSRAM)**: >20KB ou com "net" declarado (Settings, App Store,
  Web Server) — o radio precisa ficar de pe (ou o script e grande demais);
  so em hardware com PSRAM. A loja marca "Requer PSRAM" e recusa install
  em placas sem (stateInfo code "hw", gate no installApp).
- Apps sem campo permissions sao tratados como nivel 1 (radio off em placas
  sem PSRAM); um app que use Net sem declarar ve "WiFi is not connected"
  (nao rodaria de qualquer forma com o radio ligado).

## CYD sem PSRAM: rodada 4 (2026-09) — mais RAM para apps

Objetivo: folga para apps JS maiores sem mexer na aparencia (fontes, icones
48px e as faixas do Canvas ficam como estao). Medido na CYD:

| alavanca | ganho |
|---|---|
| codigo do WiFi que so estava na IRAM por throughput (`ESP_WIFI_IRAM_OPT`, `ESP_WIFI_RX_IRAM_OPT`) e do heap para a flash | IRAM de codigo 85,6KB -> 50,7KB: ~+35KB de IRAM livre (vira heap: transbordo do JS, fonte do compile, TLS) |
| link serial (celerctl): READ e screencap escrevem direto no frame de resposta; tabela do `ps` so durante o comando | .bss 51,4KB -> 43,2KB (+8KB de DRAM) e screencap sem 4KB de heap |
| scan de fundo do WiFi (roaming) so com mais de uma rede salva | sem scan a cada 30s derrubando pacotes/alocando resultados |

Resultado: no launcher, DRAM livre 53 -> 64KB e IRAM livre ~75 -> ~109KB;
App Store rodando com 29KB de DRAM livre (antes ~19KB). Teste com apps
sinteticos (funcoes + strings no estilo dos apps reais): 61KB de main.js
roda (52KB enxuto, 128 funcoes); 82KB nao compila (tela "Sem memoria" limpa).
`appRAM` passa a contar DRAM + IRAM (~225KB na CYD) e a loja usa
`(appRAM - 60000) * 0,4` (~66KB).

Consequencia dessas medicoes (2026-10): teto do hub em 2 niveis — 48KB para
qualquer placa; `"psram"` em `requires` no app.json sobe para 1MB (as
placas S3 com PSRAM compilam sem limite runtime; subido de 128KB em
2026-10-09 junto com o servidor, hub 0.9.0+ — cliente e hub sobem juntos).
A loja passou a privilegiar a declaracao (badge "Requer PSRAM" + bloqueio)
e mantem a formula acima so como fallback para entradas antigas do
catalogo sem o campo. Cartao SD nao entra na conta: o gargalo e RAM de
compilacao, nao armazenamento. Com a familia CelerGame modular o core sozinho ja
passa dos 48KB da CYD (51KB enxutos na 1.5.0): jogo com a engine declara
`requires: ["psram"]`, e nenhum jogo do catalogo roda na CYD.

Descartado por render pouco: opcoes de objeto do Duktape (`FUNC_NAME_PROPERTY`
off: -2% e perde nomes nos erros; `HSTRING_CLEN`/`HASH_PART`: ~0) e `-O2` no
duktape (+54KB de flash, compile igual).

Diagnostico novo: o fatal do Duktape (que reinicia sem coredump) grava o
motivo em RAM RTC e o boot loga `reset: motivo N` + a mensagem do fatal, com
toast. `reset: motivo 1` (POWERON) na CYD costuma ser o host mexendo nas
linhas DTR/RTS da serial, nao crash.

## Duktape no S3 com PSRAM: custo de chamada (2026-10-09)

Microbenchmark no SmartDisplay (240 MHz, heap Duktape na PSRAM), antes ->
depois das mudancas do dia:

| Operacao | Antes | Depois |
|---|---|---|
| chamada de funcao JS | 16,7 us | 7,4 us |
| chamada nativa (`System.millis`) | 23 us | 15 us |
| varrer 195 celulas com `charCodeAt` | 9 ms | 4,5 ms |
| `for-in` + `parseInt` + `slice` (2 chaves) | 1,7 ms | 0,3 ms |
| laco `for` puro (100k) | 301 ms | 301 ms |

O que mudou: `DUK_USE_CACHE_ACTIVATION`/`CATCHER` religados nas placas com
PSRAM (`components/duktape/celeros_fixup.h`; o yaml os desliga pela RAM da
CYD) — sem eles TODA chamada fazia malloc+free do registro de activation
no `heap_caps` (lock TLSF) — e cache de instrucao de 32 KB no SmartDisplay
(o executor do Duktape nao cabia em 16 KB e buscava codigo na flash pelo
mesmo MSPI da PSRAM). Resultado no Detona: 16 -> 28 fps.

Regras para codigo de jogo que saem disso: chamada (JS ou nativa) custa
~7-15 us — orcamente por quadro em centenas, nao milhares; nada de varrer a
grade inteira por quadro (o Detona passou a receber as celulas alteradas
por evento: 7 ms -> 0); evite `for-in`/`parseInt`/concatenacao de string
no caminho quente (cada string nova e alocacao + GC).

Nao confundir com o tremor de imagem do SmartDisplay (era latencia da ISR
de VSYNC no nucleo do Duktape, nao velocidade de JS): ver
`boards/AGENTS.md` "SMARTDISPLAY RGB PANEL".
