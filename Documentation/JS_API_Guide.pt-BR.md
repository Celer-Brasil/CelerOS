# Motor JavaScript do CelerOS - Manual de Referência Completo

[English](JS_API_Guide.md) | **Português (BR)**

Bem-vindo à **Referência da API JavaScript do CelerOS**. Este documento traz
os detalhes técnicos da especificação do motor JavaScript, características
de desempenho e toda API nativa exposta pelo kernel C++ para interagir com o
hardware do ESP32.

---
## Versão do Runtime JS do CelerOS
### Runtime JS: v1.0.0
### Nível de API: 49
---

## 1. Especificações do Motor e Compatibilidade ECMAScript

**O runtime JavaScript do CelerOS** usa o **Duktape 2.x**

### 1.1 Compatibilidade ECMAScript
- **Conforme ES5 / ES5.1:** o motor é totalmente compatível com a
  especificação ECMAScript 5.1.
- **Suporte parcial a ES6 (ES2015):** suporta built-ins modernos como
  `TypedArrays` (Uint8Array, Int32Array, etc.), `Proxy` e `Reflect`.
- **Sintaxe moderna NÃO suportada:** por priorizar memória ultra baixa, os
  açúcares sintáticos modernos não estão disponíveis. Você não pode usar:
  - Arrow functions `() => {}`
  - `let` e `const` (use `var`)
  - `class` do ES6 (use herança prototipal tradicional)
  - Template literals `` `string ${var}` ``
  - `Promise` (o built-in foi removido da compilação para poupar flash — use
    as chamadas bloqueantes, ex.: `Net.get`)

### 1.2 Limites de Memória e Desempenho
- **Estratégia de execução:** bytecode compilado nativamente e executado por
  uma máquina virtual de pilha.
- **Coleta de lixo (GC):** contagem de referências libera a maioria dos
  objetos imediatamente; um mark-and-sweep completo (para ciclos) roda a
  partir do `System.delay(ms)` no máximo uma vez por segundo, ou na hora
  quando o heap está apertado. O tempo gasto coletando é descontado do delay
  pedido.
- **Heap máximo:** ~90KB de RAM livre utilizável por script (com WiFi
  desligado). Minimize sempre alocações dinâmicas de arrays em loops de
  animação de alta velocidade.

---

## 2. Objeto Global: `System`

O objeto `System` oferece bindings de baixo nível acelerados por hardware
para o SO do ESP32.

### Propriedades de Display

#### `System.screenWidth()`
- **Retorna:** `Integer` — sempre `240` (canvas virtual do CelerOS 1.1+).
- **Descrição:** largura do canvas de design em que os apps desenham. Em
  painéis maiores o runtime escala tudo para a tela física (veja a nota do
  canvas virtual na seção 3).

#### `System.screenHeight()`
- **Retorna:** `Integer` — sempre `320` (canvas virtual do CelerOS 1.1+).
- **Descrição:** altura do canvas de design em que os apps desenham.

> Hardcodar 240x320 é o padrão esperado: o runtime escala desenho, sprites
> e toque para o painel físico, então o mesmo app renderiza idêntico (e em
> tela cheia) em qualquer placa.

### Utilitários do SO

#### `System.getOSVersion()`
- **Retorna:** `String` (ex.: `"1.2.0"`)
- **Descrição:** devolve a string da versão atual do SO.

#### `System.getAPILevel()`
- **Retorna:** `Integer` (ex.: `5`)
- **Descrição:** devolve o inteiro do Nível de API do SO.

#### `System.millis()`
- **Retorna:** `Number`
- **Descrição:** devolve o uptime total do hardware ESP32 em milissegundos
  desde o boot. Útil para física com delta-time e temporização de loop.
  Relógio de 64 bits: não dá a volta (antes era `uint32` e voltava a 0 aos
  ~49 dias).

#### `System.micros()`
- **Retorna:** `Number`
- **Descrição:** devolve o uptime total do hardware ESP32 em microssegundos
  desde o boot. Essencial para temporização de altíssima resolução (ex.:
  protocolos bit-banged customizados). Relógio de 64 bits, exato até 2^53:
  `agora - t0` nunca fica negativo (o `uint32` antigo fazia wrap a cada ~71
  minutos).

#### `System.getTemperature()`
- **Retorna:** `Float`
- **Descrição:** lê o sensor de temperatura interno do ESP32 e devolve o
  valor em Celsius.

#### `System.hasTemperatureSensor()`
- **Retorna:** `Boolean`
- **Descrição:** verifica se a revisão do hardware ESP32 instalada suporta o
  sensor de temperatura interno (alguns chips novos removeram). Devolve
  `true` se suportado.

#### `System.delay(ms)`
- **Parâmetros:** `ms` (Integer) - Quantidade de milissegundos para pausar a
  execução.
- **Retorna:** `undefined`
- **Descrição:** pausa a execução do JavaScript. **CRÍTICO:** essa função
  comanda o kernel C++ para executar Garbage Collection em background. Se
  você tem um loop `while(true)`, é OBRIGATÓRIO incluir um `System.delay(10)`
  para evitar que o SO trave por exaustão de heap. Teto de 30 s por chamada
  (`delay(60000)` espera 30 s; antes não esperava nada).

#### `System.delayMicroseconds(us)`
- **Parâmetros:** `us` (Integer) - Quantidade de microssegundos para pausar.
- **Retorna:** `undefined`
- **Descrição:** delays sub-milissegundo de alta precisão, nativamente.
  Bloqueia a CPU de forma limpa, sem disparar Garbage Collection. Espera
  ocupada com teto de 1 s (1.000.000 µs) — para mais, use `System.delay`.

#### `System.print(str)`
- **Parâmetros:** `str` (String)
- **Retorna:** `undefined`
- **Descrição:** imprime uma mensagem no monitor serial USB físico num
  computador conectado (baud 115200). Útil para depurar variáveis enquanto a
  tela renderiza frames.

#### `System.getTouch()`
- **Retorna:** `Object` -> `{ x: Integer, y: Integer, touched: Boolean }`
- **Descrição:** consulta o controlador de toque.
  - `touched` é `true` se um dedo/stylus está pressionando a tela.
  - `x` e `y` são coordenadas em pixels. Se `touched` é `false`, `x` e `y`
    valem 0.
- **Gatilho oculto de saída:** se o usuário tocar em `x >= 200` e `y <= 40`
  (canto superior direito), o kernel C++ aborta instantaneamente o motor JS
  e força o fechamento do app para impedir que o usuário fique preso no SO.

#### `System.getTouches()` (API 43)
- **Retorna:** `Array` -> `[{ id: Integer, x: Integer, y: Integer, size: Integer }, ...]`
- **Descrição:** consulta TODOS os dedos no controlador de toque (multitoque).
  Mesma cedida de quadro do `System.getTouch()` — chame UM dos dois por loop,
  não os dois.
  - Ordenado do dedo mais antigo para o mais novo: índice `0` é o dedo
    primário (o que a UI/chrome do sistema acompanha).
  - `id` é o track id do controlador — estável enquanto o dedo está na tela;
    use para distinguir dedos entre quadros.
  - `size` é a área de contato (0 quando o controlador não informa).
  - Sem dedo, devolve `[]`.
  - Vidro sem multitoque devolve no máximo 1 ponto (CYD resistiva: 1;
    SmartDisplay 4848 e watch: até 5).
  - O chrome do sistema (topbar, canto de saída, gestos de borda do watch)
    consome só o dedo primário — os secundários chegam limpos ao app.

#### `System.getInfo()`
- **Retorna:** `Object` -> `{ totalRAM, freeRAM, minFreeRAM, maxAllocRAM, cpuFreqMHz, chipModel, chipCores, chipRevision, flashSize, uptimeMs, appRAM }` (Integers, exceto chipModel: String)
- **Descrição:** devolve um objeto com o estado atual do hardware ESP32,
  incluindo uso de memória, velocidade de CPU e especificações. Útil para
  depurar vazamentos de memória e checar uptime.
  - `minFreeRAM`: o menor valor de RAM livre registrado desde o boot.
  - `maxAllocRAM`: o maior bloco contíguo único que se pode alocar.
  - `appRAM`: heap livre quando o app atual foi aberto (antes de carregar o código; em placas sem PSRAM, RAM interna mais a IRAM acessível a byte para onde o runtime transborda) — quanto de RAM a placa dá a um app. `freeRAM` é medido agora, com o app já carregado. Ausente em firmware antigo.
  - `hasDisplay` (API 17, Boolean): `false` em placas headless (devkit
    barebone, sem vidro). Apps que desenham devem testar antes de tocar em
    Canvas/tela — em placas headless o painel é um stub que descarta.
  - `shape` (API 15, String): `"rounded"` (vidro com cantos mortos, ex.
    relogio), `"rect"` ou `"headless"` (API 17, sem display).
  - `board`: id da placa (`"cyd"`, `"devkit"`, ...).
  - `hasSpeaker` (Boolean): existe alto-falante físico (buzzer analógico ou
    amp I2S) — `playTone`/`beep` funcionam.
  - `hasAudio` (API 46, Boolean): o pipeline de áudio DIGITAL está no
    firmware (`playWav`, `playMusic`, `sfx`, fala ao vivo do TTS).
    `hasSpeaker` `true` com `hasAudio` `false` = só tons e bipes: o
    alto-falante é o buzzer analógico e as chamadas digitais devolvem
    `false`/`0` (perfil lite da CYD — o menu de recursos compila por placa).
  - `hasMic` (API 13, Boolean; desde a API 46 exige também que o build
    compile o canal de captura): `true` exatamente quando o objeto `Mic`
    nasce — prefira a `typeof Mic` como resposta canônica.
  - `hasPhysics` (API 46, Boolean): mundos verlet nativos (`System.verlet*`)
    compilados; `false` e a dep `celeros.physics` cai no `P.verlet`
    interpretado (mais lento).

#### `System.button()` (API 17)
- **Retorna:** `Integer` — `0` nada, `1` toque curto, `2` segurar ~1,2 s
- **Descrição:** lê o botão físico 1 da placa como input do app (o padrão é
  o botão ser "home" do SO). Poll consumível no estilo da casa: devolve o
  evento pendente desde a última leitura e zera. Em placas comuns devolve
  sempre `0` (não há latch). Em placas `buttonToApp` (devkit headless), o
  botão deixa de sair do app: o curto fica disponível aqui e segurar ~1,2 s
  encerra o app. O latch é bombeado pelo mesmo `present()` de
  `delay`/`getTouch` — alterne `System.button()` com `System.delay(ms)` no
  loop. Eventos não lidos não atravessam apps (reset na abertura).

#### `System.getIPAddress()`
- **Retorna:** String
- **Descrição:** devolve o endereço IP local atual do ESP32 (ex.
  "192.168.1.11") se o WiFi estiver conectado.

#### `System.isWiFiActive()`
- **Retorna:** Boolean
- **Descrição:** devolve `true` se o ESP32 estiver conectado a uma rede WiFi.

#### `System.restart()`
- **Retorna:** None
- **Descrição:** reinicia instantaneamente o hardware ESP32.

#### `System.getTime()`
- **Retorna:** `String` (ex.: `"14:30"` ou `"02:30 PM"`)
- **Descrição:** devolve a hora local atual formatada pelo SO, respeitando
  automaticamente a preferência do usuário (12 ou 24 horas).

#### `System.getSeconds()`
- **Retorna:** `Integer` (0-59)
- **Descrição:** devolve o segundo local atual direto do RTC.

#### `System.epoch()` (API 49)
- **Retorna:** `Number` — segundos desde 1970-01-01T00:00:00Z (UTC).
- **Descrição:** o instante absoluto em UTC. As demais chamadas de tempo
  devolvem a hora *local* já formatada; um app que conversa com nuvem
  (carimbo `entered_at` de um ticket, TTL de token) precisa do relógio
  absoluto. Monte strings RFC 3339 a partir dele (`new Date(System.epoch() *
  1000)` + os métodos `getUTC*` — o Duktape traz o `Date`). Sem NTP/RTC
  sincronizado o valor vem da estimativa persistida no boot; quando o
  carimbo importa, faça uma checagem de sanidade (valor implausível = relógio
  nunca sincronizou).

#### `System.getDate()`
- **Retorna:** `String` (ex.: `"15/06/2026"`)
- **Descrição:** devolve a data local atual formatada como DD/MM/AAAA.

#### `System.getYear()`
- **Retorna:** `Integer` (ex.: `2026`)
- **Descrição:** devolve o ano local atual com 4 dígitos.

#### `System.getMonth()`
- **Retorna:** `Integer` (1-12)
- **Descrição:** devolve o mês local atual.

#### `System.getDay()`
- **Retorna:** `Integer` (1-32)
- **Descrição:** devolve o dia local atual do mês.

#### `System.getTimezone()`
- **Retorna:** `String` (ex.: `"UTC-8"`)
- **Descrição:** devolve o offset/fuso horário configurado pelo usuário.

#### `System.prompt(promptMsg, initialText, options)`
- **Parâmetros:**
  - `promptMsg` (String) - Cabeçalho exibido acima do teclado.
  - `initialText` (String) - Texto pré-preenchido na caixa de entrada.
  - `options` (Object, opcional) - `{mask, hint}`:
    - `mask: true` (API level 7) oculta o texto digitado atrás de bullets,
      com botão ver/ocultar ao lado do X (senhas, PINs).
    - `hint: "num"` (API level 11) abre já na página numérica em vez do
      QWERTY (discagem 3x3 com teclas grandes). É uma sugestão, não uma
      trava — a tecla de modo ("ABC"/"123") continua disponível. Valores
      desconhecidos caem no QWERTY: firmware antigo degrada de boa.
- **Retorna:** `String`
- **Descrição:** suspende completamente a execução do JavaScript e abre o
  teclado QWERTY nativo em C++ em tela cheia (com shift — toque duplo trava o
  caps lock —, duas páginas de símbolos e uma página de acentos PT-BR).
  Quando o usuário toca em "OK", a execução retoma e a string
  digitada é devolvida. Devolve string vazia `""` se o usuário tocar em "X"
  (cancelar).

---

## 3. Pipeline de Desenho do Display

**Frame buffer automático (CelerOS 1.2+, placas com PSRAM):** toda chamada
de desenho vai para um frame off-screen do tamanho do painel, e o frame só
vai para o vidro quando o app *cede*: `System.delay()`, `System.getTouch()`,
`System.prompt()`, e logo antes das chamadas bloqueantes (`Net.*`,
`System.wifiScan/wifiConnect`, `System.otaCheck/otaStart` — também após cada
callback de progresso de OTA —, `FS.copyFile/copyDirectory/removeDirectory`).
Apps que limpam e redesenham a tela inteira a cada evento param de piscar,
sem mudança de código. `System.present()` força o frame para o vidro
(animações ou computações longas que nunca cedem); `System.isBuffered()`
diz se a placa tem o frame (`false` na CYD, onde o desenho vai direto ao
TFT).

> Regra prática: desenhe a tela completa e depois ceda. Algo desenhado logo
> antes de uma chamada C++ longa que não está na lista acima só aparece no
> próximo yield — chame `System.present()` antes.

### Motor de Cores
Cores em JS são sempre inteiros **RGB565 de 16 bits** (ex.: `0xF800` =
vermelho) em qualquer placa — use `System.color(r, g, b)` ou
`System.theme()` para construí-las. (O CelerOS 1.2 corrigiu um bug em que,
em painéis de 16 bits, valores RGB565 passavam como RGB888 e saíam com tom
errado.)

> **Canvas virtual (CelerOS 1.1+):** os apps sempre rodam num **canvas de
> design 240x320**. Em placas com painéis maiores (ex.: SmartDisplay 4"
> 480x480), `System.screenWidth()/screenHeight()` reportam 240/320, todas as
> coordenadas/tamanhos de desenho são escalados para a tela física, sprites
> são alocados no tamanho escalado e `System.getTouch()` devolve coordenadas
> no espaço 240x320 — o mesmo app renderiza idêntico (e em tela cheia) em
> qualquer placa. Cores são RGB565 em todo lugar; o runtime converte para o
> formato nativo do painel.

#### `System.color(r, g, b)`
- **Parâmetros:** `r`, `g`, `b` (Integers 0-255)
- **Retorna:** `Integer` (cor empacotada de 16 bits)
- **Descrição:** empacota valores RGB 8/8/8 de 24 bits no formato RGB 5/6/5
  de 16 bits esperado pelo hardware.

### APIs de Gráficos

#### `System.fillScreen(color)`
- **Parâmetros:** `color` (Integer 16 bits)
- **Descrição:** inunda a tela inteira com uma única cor. Extremamente
  rápido: bypass do loop de pixels usando DMA de SPI direto do hardware.

#### `System.drawPixel(x, y, color)`
- **Parâmetros:** `x` (Int), `y` (Int), `color` (Int 16 bits)
- **Descrição:** renderiza um único pixel.

#### `System.drawLine(x1, y1, x2, y2, color)`
- **Parâmetros:** `x1`, `y1`, `x2`, `y2` (Ints), `color` (Int 16 bits)
- **Descrição:** usa o algoritmo de Bresenham para renderizar uma linha
  reta entre dois pontos.

#### `System.drawRect(x, y, w, h, color)`
#### `System.fillRect(x, y, w, h, color)`
- **Parâmetros:** `x`, `y` (coords do topo-esquerda), `w` (largura), `h`
  (altura), `color` (Int 16 bits)
- **Descrição:** desenha retângulos vazados ou preenchidos.

#### `System.drawRoundRect(x, y, w, h, radius, color)`
#### `System.fillRoundRect(x, y, w, h, radius, color)`
- **Parâmetros:** `x` (Int), `y` (Int), `w` (Int), `h` (Int), `radius` (Int),
  `color` (Int)
- **Descrição:** desenha retângulo com cantos arredondados na cor
  especificada.

#### `System.drawBMP(path, x, y)`
- **Parâmetros:** `path` (String), `x` (Int), `y` (Int)
- **Retorna:** `Boolean` (`true` se ok, `false` se não suportado ou arquivo
  ausente)
- **Descrição:** lê uma imagem `.bmp` de 16, 24 ou 32 bits do sistema de
  arquivos (`/sd/` ou `/local/`) e a transmite em `x, y` sem usar RAM do
  JavaScript. A imagem é escalada pelo canvas virtual (um BMP de 240px de
  largura preenche a largura da tela em qualquer placa).

#### `System.drawPNG(path, x, y)`
- **Parâmetros:** `path` (String), `x` (Int), `y` (Int)
- **Retorna:** `Boolean` (`true` se ok, `false` se falhou caminho/decode)
- **Descrição:** desenha uma imagem `.png` do sistema de arquivos (`/sd/` ou
  `/local/`) em `x, y`, decodificada em streaming linha a linha (sem pico de
  RAM de framebuffer completo; apenas a janela deflate de ~44 KB durante o
  decode). O alpha do PNG é mesclado sobre o fundo existente. Como toda
  chamada de desenho, a imagem é escalada pelo canvas virtual 240x320
  (CelerOS 1.2+; antes, o PNG mantinha o tamanho nativo em painéis grandes).
  PNGs entrelaçados são suportados. Ideal para fundos e fotos; use
  `System.drawIcon()` para ícones 64x64 estilo launcher.

#### `System.drawJPG(path, x, y)` (API 36)
- **Parâmetros:** `path` (String), `x` (Int), `y` (Int)
- **Retorna:** `Boolean`
- **Descrição:** desenha um `.jpg` baseline (a saída do `Pack.snap` ou do
  `Camera.save`) decodificado em blocos 8x8 (sem a imagem inteira na RAM),
  escalado pelo canvas virtual como o `drawPNG`.

#### `System.drawCircle(x, y, radius, color)`
#### `System.fillCircle(x, y, radius, color)`
- **Parâmetros:** `x`, `y` (coords do centro), `radius` (Int), `color` (Int
  16 bits)
- **Descrição:** renderiza círculos perfeitos, vazados ou preenchidos.

#### `System.drawTriangle(x1, y1, x2, y2, x3, y3, color)`
#### `System.fillTriangle(x1, y1, x2, y2, x3, y3, color)`
- **Parâmetros:** `x1, y1, x2, y2, x3, y3` (coords dos vértices), `color`
  (Int 16 bits)
- **Descrição:** renderiza triângulos vazados ou preenchidos. Útil para
  projeções 3D ou indicadores de UI.

#### `System.drawFastVLine(x, y, h, color)`
- **Parâmetros:** `x, y` (coords de início), `h` (altura), `color` (Int 16
  bits)
- **Descrição:** desenho de linha vertical acelerado por hardware.
  Substancialmente mais rápido que `System.fillRect()` para fatias de
  raycaster.

#### `System.drawFastHLine(x, y, w, color)`
- **Parâmetros:** `x, y` (coords de início), `w` (largura), `color` (Int 16
  bits)
- **Descrição:** desenho de linha horizontal acelerado por hardware.

---

### Double Buffering de Hardware (Mini-Sprites)
O double buffering permite desenhar formas invisivelmente num buffer de RAM
off-screen (um Sprite) e depois "empurrar" o frame completo para a tela
física numa única transferência instantânea de DMA de hardware. Isso
**elimina completamente o flickering de tela**.

> [!CAUTION]
> **Limitações Severas de RAM e Fragmentação de Heap**
> O ESP32-WROOM tem RAM contígua muito limitada (~320KB no total, mas pela
> fragmentação do WiFi/WebManager, o maior bloco alocável costuma ficar
> abaixo de ~30KB). Alocar um buffer massivo (ex.: `240x320` a 16 bits
> ocupa 153,6 KB) fará o motor devolver `false` de `System.createSprite`
> instantaneamente.
> **Sempre** mantenha seus buffers o menor possível. A arquitetura
> recomendada é **Renderização em Fatias**: divida a tela em pequenas fatias
> horizontais (ex.: 10 fatias de 32px de altura) ou colunas verticais.
> `System.createSprite()` agora dispara Garbage Collection agressivo para
> desfragmentar a memória antes da alocação e cai automaticamente para cor
> de 8 bits para evitar travamentos se a RAM estiver muito fragmentada para
> 16 bits.

#### `System.createSprite(width, height)`
- **Parâmetros:** `width, height` (Integer)
- **Retorna:** `Boolean` (`true` se alocou com sucesso um buffer de cor 16
  ou 8 bits na RAM, `false` se a RAM esgotou)
- **Descrição:** aloca um buffer de Sprite persistente off-screen na RAM.
  Força GC automaticamente e cai para 8 bits para garantir memória contígua.

#### `System.bindSprite(enabled)`
- **Parâmetros:** `enabled` (Boolean)
- **Descrição:** se `true`, **TODAS** as chamadas `System.draw...` e
  `System.fill...` subsequentes são interceptadas e desenhadas
  *invisivelmente* no Sprite persistente em vez da tela. Se `false`, volta a
  desenhar direto no TFT.

#### `System.pushSprite(x, y)`
- **Parâmetros:** `x, y` (Integer - coordenadas do topo-esquerda onde colar
  o buffer na tela física)
- **Descrição:** empurra todo o buffer oculto para a tela física
  instantaneamente via DMA. O buffer permanece na RAM e pode ser modificado
  e empurrado de novo.

#### `System.deleteSprite()`
- **Descrição:** destrói o Sprite instantaneamente e libera a RAM. Você
  DEVE chamar isso ao terminar para evitar vazamentos severos de memória!

### APIs de Texto

#### `System.setTextColor(fg_color, bg_color)`
- **Parâmetros:** `fg_color` (frente), `bg_color` (fundo)
- **Descrição:** define as cores ativas de renderização de texto. Com
  `bg_color`, o texto sobrescreve em nível de hardware, apagando os pixels
  anteriores sem precisar desenhar retângulo manual.

#### `System.setTextSize(size)`
- **Parâmetros:** `size` (Integer 1-5)
- **Descrição:** multiplica a escala da fonte pixel padrão.

#### `System.drawString(text, x, y, font)`
- **Parâmetros:**
  - `text` (String) - Texto a renderizar.
  - `x`, `y` (Ints) - Coordenada topo-esquerda onde começa a renderização.
  - `font` (Integer 1, 2 ou 4) - Seleção de fonte de hardware. 2 é padrão, 4
    é negrito/grande.
- **Descrição:** renderiza strings em alta velocidade no display. O texto é
  UTF-8 e todas as fontes cobrem Latin-1 (U+0020..U+00FF), então acentos
  funcionam: `"Configurações"`, `"25°C"`. Caracteres fora dessa faixa
  (travessão, aspas curvas, €, emoji) não são desenhados.

---

## 4. GPIO de Hardware (Entrada/Saída de Propósito Geral)

O CelerOS habilita controle direto dos pinos do microcontrolador ESP32 via
`System.gpio`.

### Constantes
- `System.gpio.INPUT`
- `System.gpio.OUTPUT`
- `System.gpio.INPUT_PULLUP`
- `System.gpio.HIGH`
- `System.gpio.LOW`

### Funções

#### `System.gpio.pinMode(pin, mode)`
- **Parâmetros:** `pin` (número do pino de hardware), `mode` (constante de
  GPIO)
- **Descrição:** define o estado elétrico físico de um pino (ex.: pino 2
  como OUTPUT para acender um LED).
- Todas as funções de `System.gpio` lançam `RangeError` para pino
  inexistente ou reservado pelo sistema (flash/PSRAM) — mexer neles
- Reservado tambem significa pinos que a placa nega (`gpioDeniedMask` do perfil da board): as linhas de dados da PSRAM octal GPIO 33-37 (PWM ali corrompe o heap do runtime), os pinos da UART do console (43/44 no S3, 1/3 no ESP32) e o I2C do touch da SmartDisplay (19/45). O erro e o mesmo `RangeError`.
  derrubava o aparelho.

#### `System.gpio.digitalWrite(pin, state)`
- **Parâmetros:** `pin` (Integer), `state` (HIGH ou LOW)
- **Descrição:** aplica 3,3V (HIGH) ou 0V (LOW) num pino específico.

#### `System.gpio.digitalRead(pin)`
- **Parâmetros:** `pin` (Integer)
- **Retorna:** `Integer` (1 para HIGH, 0 para LOW)
- **Descrição:** lê o estado de tensão físico de um pino.

#### `System.gpio.analogRead(pin)`
- **Parâmetros:** `pin` (Integer)
- **Retorna:** `Integer` (0 a 4095)
- **Descrição:** aciona o conversor analógico-digital de 12 bits do ESP32
  para ler um nível de tensão contínuo.

#### `System.gpio.analogWrite(pin, pwmValue)`
- **Parâmetros:** `pin` (Integer), `pwmValue` (0 a 255)
- **Descrição:** inicia um sinal PWM (Pulse Width Modulation) automático de
  hardware num pino. Útil para controle de motores ou dimmer de LEDs.

#### `System.gpio.pulseIn(pin, state, [timeout])`
- **Parâmetros:** `pin` (Integer), `state` (HIGH ou LOW), `timeout` (Integer
  opcional em microssegundos, padrão e teto 1.000.000)
- **Retorna:** `Integer` (duração do pulso em microssegundos, ou 0 se deu
  timeout)
- **Descrição:** **Medição Nativa de Pulsos por Hardware.** Suspende o motor
  JS e delega ao kernel C++ a medição precisa da duração de um pulso de
  hardware de entrada. Isso contorna totalmente a sobrecarga de execução do
  JavaScript, dando precisão absoluta de microssegundos (crucial para ler
  sensores ultrassônicos HC-SR04).

#### `System.gpio.servo(pin, angulo)` (API 10)
- **Parâmetros:** `pin` (Integer), `angulo` (Number, 0 a 180; aceita fração para rampas suaves; fora da faixa é travado)
- **Retorna:** `Boolean` (`false` com pino de saída inválido ou sem canal livre — no máximo **5 servos ao mesmo tempo**)
- **Descrição:** move um servo hobby padrão (classe SG90) com PWM de 50 Hz (pulso de 500–2500 µs). O canal LEDC é alocado na primeira escrita do pino. Robôs: combine com o Celer Link — o app do controle envia comandos e o app do robô mapeia para as perninhas (`System.gpio.servo(13, 90)`).
- **Nota:** os canais vêm dos canais LEDC que a placa deixa livres (nunca os do backlight, `System.beep` ou `System.led`); os canais 0..2 do `analogWrite` só entram como último recurso, com timer próprio. Sair do app solta todos os servos (sem torque de sustentação).

#### `System.battery()` (API 10)
- **Retorna:** `Number` — tensão da **célula** em mV (leitura do pino já escalada pelo divisor da placa), ou `-1` se a placa não tem.
- **Descricao:** leitura media de ADC com cache de ~2 s. No cão robótico SpotPear lê o divisor 2:1 da Li-ion no GPIO2 (~4100 mV na USB, ~3300 mV = vazia).

#### `System.micLevel()` (API 10)
- **Retorna:** `Number` — nivel de som `0..100` (RMS de captura curta no slot esquerdo do I²S), ou `-1` sem microfone.
- **Descricao:** bloqueante curto (~100 ms); o desenho pendente aparece antes. A primeira chamada inicializa o canal RX (~300 ms).

#### `System.touchPad()` (API 10)
- **Retorna:** `Number` — `1` tocado, `0` solto, `-1` se a placa nao tem pad capacitivo.
- **Descricao:** pad capacitivo avulso (a "cabeca" do cao robotico). A referencia e calibrada na primeira chamada — mantenha o pad solto nesse instante.

#### `System.neopixel(strip, cores)` (API 10)
- **Parametros:** `strip` — indice 0-based da fita WS2812; `cores` — array de `0x00RRGGBB` (1..8 LEDs).
- **Retorna:** `Boolean` — `false` sem fitas na placa ou parametros invalidos.
- **Descricao:** atualiza a fita inteira via RMT (sem DMA). Exemplo: `System.neopixel(0, [0xFF0000, 0, 0x00FF00])`. As fitas apagam quando o app sai.

#### `System.gpio.servoOff(pin)` (API 10)
- **Parâmetros:** `pin` (Integer)
- **Retorna:** `Boolean**
- **Descrição:** para o PWM no pino e libera o canal — o servo fica solto (sem torque de sustentação). Chame ao terminar um movimento para economizar energia.

---

## 5. Sistema de Arquivos Unificado (FS)

O objeto global `FS` controla a camada C++ de sistema de arquivos virtual.
Roteia dinamicamente as operações para o cartão SD físico (prefixo `/sd/`)
ou para a Flash Interna de alta velocidade (prefixo `/local/`).

#### `FS.exists(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `Boolean`
- **Descrição:** valida se um arquivo ou pasta existe fisicamente.

#### `FS.readTextFile(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `String` (ou `null` se o arquivo não existe)
- **Descrição:** carregador de alta velocidade para RAM. Lê o arquivo
  inteiro num bloco contíguo de String na RAM. Não use em arquivos maiores
  que ~20KB!

#### `FS.writeTextFile(path, content)`
- **Parâmetros:** `path` (String), `content` (String)
- **Retorna:** `Boolean`
- **Descrição:** apaga qualquer arquivo existente e escreve a totalidade de
  `content` no disco.

#### `FS.appendTextFile(path, content)`
- **Parâmetros:** `path` (String), `content` (String)
- **Retorna:** `Boolean`
- **Descrição:** acrescenta a string ao final de um arquivo existente.

#### `FS.deleteFile(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `Boolean`
- **Descrição:** apaga permanentemente um arquivo da partição.

#### `FS.renameFile(pathFrom, pathTo)`
- **Parâmetros:** `pathFrom` (String), `pathTo` (String)
- **Retorna:** `Boolean`
- **Descrição:** renomeia um arquivo ou o move entre diretórios na mesma
  partição.

#### `FS.listDir(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `Array[String]`
- **Descrição:** percorre um diretório e devolve um array de caminhos
  absolutos (ex.: `["/local/app.js"]`).

#### `FS.mkdir(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `Boolean`
- **Descrição:** cria um novo diretório.

#### `FS.rmdir(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `Boolean`
- **Descrição:** remove um diretório vazio.

#### `FS.isDirectory(path)` / `FS.isFile(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `Boolean`
- **Descrição:** avalia se o caminho alvo é diretório ou arquivo.

#### `FS.getFileSize(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `Integer` (bytes)
- **Descrição:** devolve o tamanho físico total de um arquivo em bytes.

#### `FS.getTotalSpace(drive)` / `FS.getUsedSpace(drive)` / `FS.getFreeSpace(drive)`
- **Parâmetros:** `drive` (String - `"/local"` ou `"/sd"`)
- **Retorna:** `Integer` (bytes)
- **Descrição:** devolve métricas exatas de armazenamento da partição
  indicada.

#### `FS.getFileMD5(path)`
- **Parâmetros:** `path` (String)
- **Retorna:** `String` (representação hexadecimal do hash MD5)
- **Descrição:** usa o motor criptográfico `mbedtls` acelerado por hardware
  para processar o arquivo em streaming e devolver seu hash MD5 preciso.

#### `FS.mountSD()` / `FS.unmountSD()`
- **Parâmetros:** None
- **Retorna:** `Boolean` (mount devolve o status de sucesso)
- **Descrição:** dispara um remount/unmount SPI do cartão SD físico.

---
**Use os Apps e Games do catálogo do CelerOS Hub como exemplo:
https://os.celer.tec.br/store — veja também `data/apps/` neste repositório**
---
*Versão do Documento: 1.1 (Construído para o Ambiente JavaScript do CelerOS)*

## 6. Rede: `Net` (Nível de API 2)

Cliente HTTP para apps JS. As chamadas são **bloqueantes** (o script espera
a resposta, timeout de 10s). HTTP e HTTPS são suportados; respostas maiores
que 32 KB são truncadas.

> Nota de memória: HTTPS (TLS) consome ~45 KB de heap durante a chamada e
> divide a memória com o runtime JS (~90 KB) — mantenha payloads pequenos,
> especialmente em placas sem PSRAM.

#### `Net.isConnected()`
- **Retorna:** Boolean
- **Descrição:** devolve `true` se o WiFi estiver conectado.

#### `Net.get(url)`
- **Parâmetros:** `url` (String, `http://` ou `https://`)
- **Retorna:** String (corpo da resposta) ou `null` em falha (DNS, timeout,
  status HTTP fora de 2xx).
- **Descrição:** executa um HTTP GET. Segue redirects. Lança erro se o WiFi
  não estiver conectado. O corpo tem **teto de 32 KB** (`NET_MAX_BODY`):
  resposta maior é truncada em silêncio para o teto, sem erro nenhum. Para
  arquivos grandes use `Net.download`, que vai a disco sem teto.

#### `Net.getJSON(url)`
- **Parâmetros:** `url` (String)
- **Retorna:** objeto/array JS parseado, ou `null` em falha da requisição.
- **Descrição:** como `Net.get()`, mas parseia o corpo como JSON. Mesmo
  **teto de 32 KB** do `Net.get()`: um JSON maior que o teto chega truncado e
  o parse lança erro — mantenha os arquivos que você busca assim abaixo de
  32 KB (é exatamente por isso que toda categoria do catálogo da App Store
  cabe no teto). Um corpo JSON malformado lança um erro visível no script.

#### `Net.post(url, body, contentType)`
- **Parâmetros:**
  - `url` (String)
  - `body` (String) — corpo da requisição
  - `contentType` (String, opcional — padrão `"text/plain"`, ex.:
    `"application/json"`)
- **Retorna:** String (corpo da resposta) ou `null` em falha.
- **Descrição:** executa um HTTP POST. Lança erro se o WiFi não estiver
  conectado.

#### `Net.request(opts)` (API 49)
- **Parâmetros:** `opts` (Object):
  - `url` (String, obrigatória)
  - `method` (String, opcional — `"GET"` (padrão), `"POST"`, `"PUT"`,
    `"PATCH"`, `"DELETE"`)
  - `body` (String, opcional — até 64 KB)
  - `contentType` (String, opcional — usado quando há `body`)
  - `headers` (Object, opcional — até 6 cabeçalhos próprios, ex.:
    `{apikey: "...", Authorization: "Bearer ..."}`)
  - `timeoutMs` (Number, opcional — limitado a 1000..20000, padrão 10000)
- **Retorna:** `{status: Number, body: String}` para QUALQUER resposta HTTP,
  ou `null` quando o transporte em si falha (DNS/TCP/TLS/timeout, ou sem
  WiFi).
- **Descrição:** requisição com cabeçalhos próprios e status visível. O
  `Net.post` não envia cabeçalhos (gateways como o Supabase exigem o
  cabeçalho `apikey`) e colapsa toda falha em `null`, deixando o script sem
  distinguir "sem rede" de uma recusa 4xx de negócio — o `Net.request`
  responde as duas coisas. Nomes/valores de cabeçalho rejeitam CR/LF e
  demais controles (injeção na linha de pedido) e têm teto de 32/256 chars.
  O `body` da resposta segue o mesmo teto de 32 KB do `Net.get`. É o caminho
  dos totems CelerPark com a edge function `parking-gate`.
- **Exemplo:**
```javascript
var r = Net.request({
    url: "https://supabase.exemplo.br/functions/v1/parking-gate",
    method: "POST",
    body: JSON.stringify({action: "heartbeat", device_id: "lane-01"}),
    contentType: "application/json",
    headers: {apikey: key, Authorization: "Bearer " + key}
});
if (r === null) System.print("offline");
else System.print("HTTP " + r.status + ": " + r.body);
```

#### `Net.download(url, caminho, onProgress)` (API 6)
- **Parâmetros:**
  - `url` (String, `http://` ou `https://`)
  - `caminho` (String) — caminho de destino no VFS (ex.
    `"/local/apps/<pkg>/main.js.new"`)
  - `onProgress` (Função, opcional) — chamada por chunk com
    `(bytesBaixados, bytesTotais)`; `bytesTotais` é `-1` quando o servidor
    não manda `Content-Length`
- **Retorna:** Boolean — `true` no sucesso; em falha o arquivo parcial é
  removido e o arquivo existente em `caminho` fica **intacto** (o download
  vai para `caminho + ".part"` e só substitui o destino no sucesso)
- **Permissão:** exige `"fs"` além de `"net"`; o destino segue as mesmas
  regras do `FS` (caminho canônico em `/local` ou `/sd`, sem arquivos do
  sistema).
- **Descrição:** baixa direto para um arquivo em modo **streaming** — o
  corpo nunca passa pela heap do JS, então **não sofre o teto de 32 KB** (é
  o mecanismo da App Store para instalar/atualizar apps; os limites de
  tamanho ficam no hub). Erros dentro de `onProgress` não abortam o
  download. É assim que a loja atualiza apps: grava num arquivo de staging
  `*.new`, valida o `FS.getFileMD5()` contra o checksum do catálogo e então
  `FS.renameFile()` por cima do código antigo (atômico dentro do mesmo
  filesystem — nunca renomeie entre `/local` ↔ `/sd`).

### Exemplo

```javascript
var quote = Net.getJSON("http://economia.awesomeapi.com.br/json/last/USD-BRL");
if (quote === null) {
    System.print("request failed");
} else {
    System.print("USD/BRL: " + quote.USDBRL.bid);
}
```

## 12. Nível de API 3 — Apps de Sistema (W8)

Introduzido com o rework W8: as telas de sistema (Settings, App Store,
Installer, Help, Web Server) agora são apps JS que vivem no LittleFS. O
nível 3 adiciona os bindings de que eles precisam — cores de tema, cópia de
arquivos, controle de OTA e o formato de pacote de app.

### 12.1 Tema e Ícones

#### `System.theme()`
- **Retorna:** Object `{bg, card, raised, stroke, accent, accentD, onAccent, text, textDim, ok, warn, err}` — a paleta de tema do SO como valores RGB565, prontos para qualquer chamada de desenho. Os apps de sistema usam isso para herdar o visual do CelerOS em qualquer placa.

#### `System.textWidth(str, font)`
- **Parâmetros:** `str` (String), `font` (Number, padrão 2)
- **Retorna:** Number — largura da string em pixels no espaço virtual
  240x320. `System.drawString` usa datum topo-esquerda; centralize na mão:
  `x = 120 - (System.textWidth(s, 2) >> 1)`.

#### `System.drawIcon(name, x, y)`
- **Parâmetros:** `name` (String: `appstore`, `installer`, `settings`,
  `help`, `web`, `time`, `about`, `update`, `app`, `wifi_on`, `wifi_off`,
  `terminal`, `calculator`, `snake` — ou um caminho absoluto
  `/local`/`/sd`), posição no espaço virtual
- **Descrição:** desenha um ícone 64x64 de `/local/icons/<name>.png` com
  mesclagem de alpha (`.bin` legado aceito).

### 12.2 Ciclo de Vida do App

#### `System.exitApp()`
Fecha o app e volta ao launcher (igual a tocar o canto superior direito).
A saída é "grudenta": se um `try/catch` do app engolir o erro de saída, o
próximo `System.delay`/`getTouch`/`keypadPoll` relança — o app fecha mesmo
assim.

#### `System.rescanApps()`
Pede ao launcher para reescanear `/local/apps` e `/sd/apps`. Chame depois de
instalar/remover apps.

#### `System.launchApp(packageName)` (API 16)
Pede ao launcher para abrir outro app pelo `packageName` (também aceita
caminho ou nome da pasta) e encerra o app atual pela mesma saída limpa do
`exitApp()` — o launcher consome o pedido quando o app sai. O consentimento
de permissões do app de destino continua valendo. Caso de uso principal:
**plugins do watchface** — a linha de widget que o app instala no relógio
abre o app de origem ao toque (veja a página *Watchface-Plugins* da wiki).

#### `System.openWifiSetup()`
Empurra a tela nativa de configuração de WiFi. Como os apps JS rodam de
forma síncrona, chame `System.exitApp()` logo em seguida — a tela de setup
assume quando o script cede.

#### `System.present()`
Mostra o frame buffer automático no vidro agora (no-op sem ele). Só é
necessário em loops que nunca chamam `delay()`/`getTouch()`.

#### `System.fontHeight(font)`
Altura em pixels (canvas virtual) de uma fonte numérica (1/2/4) como
renderizada nesta placa — use `y - (System.fontHeight(f) >> 1)` para
centralizar texto verticalmente.

#### `System.setClip(x, y, w, h)` / `System.clearClip()`
Restringe o desenho a um retângulo do canvas virtual (o que ficar fora é
descartado) — ex.: uma lista rolante cujas linhas parciais não podem
pintar sobre o cabeçalho. `clearClip()` restaura a tela inteira. O clip é
zerado quando um app inicia.

#### `System.isBuffered()`
Devolve `true` quando a placa tem o frame buffer automático (placas com
PSRAM).

### 12.3 Hardware e Sistema

#### `System.setBrightness(level)` / `System.getBrightness()` / `System.backlightSupported()`
Controle do backlight (5–100). Em placas sem backlight PWM,
`backlightSupported()` devolve `false` e os setters são no-op.

**Brilho, volume, brilho automático e tempo de tela são configurações do
aparelho:** só apps com `"system"` (Settings) gravam na NVS. Nos demais
apps a mudança vale **enquanto o app roda** e o valor anterior volta quando
ele fecha (um efeito de fade não grava mais a flash a cada frame).

#### `System.setAutoBrightness(on)` / `System.getAutoBrightness()` (API 7)
Brilho automático pelo sensor de luz da placa: o nível escolhido pelo usuário
vira o máximo e a tela escurece até 30% dele no escuro (suavizado, checado 1x
por segundo, inclusive com app aberto). `getAutoBrightness()` devolve
`true`/`false`, ou `null` em placas sem sensor de luz. Persistido na
configuração `auto_brightness`.

#### `System.wifiStatus()`
- **Retorna:** `{connected, ip, webServer, savedNetworks}` (Booleans/String).

#### `System.webActive()` / `System.webSetActive(bool)`
Estado e toggle do servidor web (file manager + upload web) — ao vivo, sem
reboot.

#### `System.md5(str)`
- **Retorna:** MD5 em hex minúsculo da string (mesmo formato de
  `FS.getFileMD5`). Mantido para dados legados — **não use para senhas**
  (veja `setPin` abaixo).

#### Permissões do app (`app.json` → runtime, F4)
`"permissions": ["fs","net","gpio","system","mic"]` controla o que o runtime registra para o app: sem `fs` não existe objeto `FS`, sem `net` não existe `Net`, sem `gpio` não existe `System.gpio`, sem `mic` não existe `Mic` (gravação; API 19) e sem `system` as chamadas que afetam o aparelho (`restart`, `factoryReset`, `otaCheck/otaStart`, `openWifiSetup`, `web*`, `wifiConnect`, PIN `setPin/verifyPin/pinClear`, hora `setTimezone/setManualTime/set24hFormat/setNtpEnabled`) ficam ausentes. Caminhos do `FS` (e de `drawPNG`/`drawBMP`/`playWav`/`Net.download`) precisam ser **canônicos** dentro de `/local` ou `/sd`: sem `//`, `.` ou `..` (negados para todos os apps). **App sem o campo mantém tudo** (compatibilidade com a loja existente); apps de sistema (`"system": true`) **não** são exceção: também recebem só o que declararam e o dono concedeu — o próprio `"system": true` (ordem no grid, proteção contra remoção) só vale com a capability `"system"` declarada e concedida. `FS.appData()` devolve a pasta privada do app `/local/data/<packageName>/` (criada na primeira chamada) — use para recordes e estado em vez de arquivos soltos em `/local`.

#### `System.toast(mensagem)` / `System.beep(freq, ms)`
`toast` enfileira notificação do sistema (aparece na hora com a UI viva — `CELEROS_APP_TASK` — ou quando o app sai). `beep` toca um tom na saída de alto-falante da placa (bloqueante; 20–20000 Hz, até 5000 ms). A CYD aciona o conector de alto-falante (GPIO26, amplificador na placa, onda quadrada); a SmartDisplay alimenta o amplificador digital Nsiway NS4168 da placa via I2S (senoide, som mais suave). Devolve `false` em placa sem alto-falante.

#### `System.led(r, g, b)` (API 7)
Acende o LED RGB de status da placa, 0–255 por canal (PWM). `System.led()`
ou `System.led(0, 0, 0)` apaga; o LED também apaga quando o app sai. Devolve
`false` em placa sem LED. A CYD tem um no verso (R=GPIO4, G=GPIO16,
B=GPIO17).

#### `System.lightLevel()` (API 7)
Luz ambiente pelo sensor da placa: `0` (escuro) a `100` (sala iluminada);
`-1` sem sensor. Na CYD o sensor (LDR ao lado da tela) só separa "iluminado"
de "escurecendo": qualquer sala normalmente iluminada lê perto de 100.

#### `System.relay(n, on)` / `System.relayState(n)` / `System.relayCount()` (API 8)
Linhas de rele da placa. `n` é 1-based (`1` = linha L1 do hardware);
`relay(n, true/false)` comuta e devolve `false` sem reles ou com índice
inválido, `relayState(n)` devolve `1`/`0` (ou `-1`) e `relayCount()` diz
quantas linhas existem (`0`..`3`). Os reles partem **desligados** no boot.
Disponível nas SKUs "Y" (caixa de parede 86 switch) da SmartDisplay
4848S040 — L1=GPIO40, L2=GPIO2, L3=GPIO1 — quando o firmware é compilado
com `CONFIG_CELEROS_SMARTDISPLAY_RELAYS`; são os mesmos pinos do
alto-falante I2S da SKU padrão, então a placa tem um ou outro.

`System.getInfo()` também informa `hasLed`, `hasLightSensor` e `hasSpeaker`
para detecção de recursos — e, desde a API 46, as capacidades do build
`hasAudio` (pipeline digital) e `hasPhysics` (verlet nativo).

#### `System.setting(key)` / `System.setting(key, value)`
Configurações do sistema em NVS (`web_on`, `nowifi`, `install_sd`, `brightness`, ...). Leitura (aberta) devolve a string ou `null`; **escrita exige `"system"`** e devolve `true` (chave 1–15 caracteres, valor até 63). Para dados do próprio app use `Storage`. Apps de sistema usam isto em vez de arquivos `/local/*.txt` soltos (arquivos legados são importados e removidos no primeiro boot).

#### `System.setPin(pin)` / `System.verifyPin(pin)` / `System.pinClear()` / `System.pinState()`
PIN do Settings, tratado nativamente desde a 1.3: SHA-256 com salt
(`settings_pin2.bin`), sem hash exposto ao JS. `setPin`, `verifyPin` e
`pinClear` **exigem `"system"`** (`pinState` é aberto). `setPin` aceita 4–6
dígitos; `verifyPin` faz upgrade transparente de um PIN MD5 legado no
primeiro sucesso e, depois de 5 erros seguidos, recusa tentativas por 30 s
(o castigo dobra a cada erro, até 15 min). `pinState()` retorna `0` (sem PIN), `1` (ativo) ou `2` (corrompido —
flag setada sem arquivo; a UI deve pedir redefinição).

#### `System.webAuthInfo()` / `System.webAuthSetPass(senha)`
Credenciais do servidor web (Basic Auth desde a 1.3 — toda rota exige a
senha). `webAuthInfo()` → `{user, pass}` para exibição ao dono do aparelho;
`webAuthSetPass` aceita 6–31 caracteres.

#### `System.otaCheck()`
- **Retorna:** `{fetchFailed, available, hasFirmware, version, url, changelog, guide, type}` — resultado do manifest do canal de updates do aparelho.

#### `System.otaStart(url, progressCallback)`
- **Parâmetros:** `url` vinda de `otaCheck()`, callback que recebe `percent`
  (0–100) durante a gravação
- **Retorna:** `{ok, error?}` — grava o slot OTA inativo; em caso de sucesso
  o app deve oferecer `System.restart()`.

#### `System.setTimezone(tz)` / `System.setManualTime(year, month, day, hour, minute)` / `System.set24hFormat(bool)` / `System.get24hFormat()` / `System.setNtpEnabled(bool)` / `System.getNtpEnabled()`
Configurações de horário (persistidas pelo TimeManager). Os setters
**exigem `"system"`**. `setTimezone` devolve `false` (sem mudar nada) para
fuso vazio, maior que 48 caracteres ou com `|`/caracteres de controle;
`setManualTime` devolve `false` com campo fora da faixa (ano 2020–2099).

#### `System.factoryReset(mode)`
- `"configs"` — limpa arquivos de configuração em `/local` e redes WiFi
  salvas, **mantém** apps e ícones.
- `"total"` — formata a partição LittleFS inteira (**apps são apagados**; a
  recuperação exige `tools/flash_data.sh` ou `celerctl apps install`).
  Confirme sempre duas vezes na UI.

#### `Net.beginGet(url)` / `Net.pollGet(handle)` / `Net.cancelGet(handle)` (não-bloqueante)
`beginGet` dispara o GET em task de fundo e devolve um handle (`-1` sem slot livre ou sem WiFi — o firmware loga qual dos motivos).

**Um estilo por vez:** a stack da task assíncrona somada a um `Net.get` bloqueante no mesmo app pode estourar a RAM interna em boards no limite (a requisição então falha com erro de conexão). Use a API assíncrona *ou* a bloqueante dentro de um mesmo app. `pollGet` devolve `null` enquanto roda e depois `{done:true, ok, status, body, error}` (corpo limitado a 32 KB, igual às chamadas bloqueantes). `cancelGet` abandona a requisição (o slot se libera quando a task estoura o timeout; tasks nunca são mortas no meio do TLS). Máximo de 2 requisições concorrentes.

### 12.4 WiFi (Net)

- `Net.wifiScan()` → array `[{ssid, rssi, secure}]` (bloqueante, ~2s).
- `Net.wifiConnect(ssid, password)` → Boolean (bloqueante, até 15s; salva as
  credenciais).
- `Net.wifiDisconnect()` — desconecta o STA, mantém redes salvas.

### 12.5 Cópia de arquivos (FS)

- `FS.copyFile(src, dst)` → Boolean — binário seguro.
- `FS.copyDirectory(srcDir, dstDir)` → Boolean — cópia recursiva.
- `FS.removeDirectory(path)` → Boolean — exclusão **recursiva** (diferente
  de `FS.rmdir`, que exige diretório vazio).

### 12.6 Pacote de app (app.json)

```json
{
  "name": "Meu App",
  "packageName": "celeros.meuapp",
  "version": "1.0.0",
  "author": "voce",
  "description": "...",
  "type": "Utility",
  "category": "Utility",
  "api": 3,
  "topbar": true,
  "system": true,
  "order": 30,
  "icon": "settings"
}
```

- `system: true` — app de sistema: ordenado primeiro na grade do launcher
  (as telas de sistema nativas agora são apps assim).
- `order` — posição entre os apps de sistema.
- `icon` — nome do ícone em `/local/icons`. **Preferível:** embarque um
  `icon.png` (64x64 com alpha; decodificado no carregamento — CelerOS 1.2+)
  dentro da pasta do app — ele sobrepõe o nome e viaja com o pacote quando
  instalado via SD/celerctl. O `icon.bin` legado (v2 RGB565+A4) ainda é
  aceito.
- `packageName` — identidade usada pelo dedup do launcher, installer e App
  Store.
- Caminhos de instalação: `/local/apps/<Nome>/` (LittleFS) ou
  `/sd/apps/<Nome>/` (cartão SD). Reinstale/atualize com
  `celerctl apps install <pasta> [--sd]`.

---

## 13. Nível de API 5 — Teclado Acoplado (W9)

Introduzido com os apps W9 (Terminal, Calculator, Snake): uma **sessão de
teclado não bloqueante** que o app controla no próprio loop, então a entrada
de texto pode conviver com a UI do app (linha de input de shell, campos de
chat, formulários...). `System.prompt()` (seção 2) continua sendo a escolha
certa para diálogos simples de uso único.

O teclado renderiza no **mesmo alvo do app** (sprite do app > frame PSRAM >
display), então sobrevive a `present()` e compõe com o frame buffer
automático em qualquer placa. Com `field: false` o teclado é desenhado como
um bloco compacto ancorado no rodapé da tela; tudo acima de
`System.keypadRect().y` pertence ao app.

### 13.1 API de Sessão

#### `System.keypadOpen(options)` → Boolean
- **Parâmetros:** `options` (Object, opcional): `{title, initial, maxLen, field, mask, hint}`.
  - `title` (String) — rótulo do cabeçalho (exibido só com campo).
  - `initial` (String) — texto pré-preenchido.
  - `maxLen` (Number, padrão 64, máx 256) — limite do buffer.
  - `field` (Boolean, padrão true) — desenha o campo de input nativo + botão
    X em cima. `field: false` desenha o teclado puro acoplado no rodapé (o
    app ecoa a linha por conta própria).
  - `mask` (Boolean, padrão false, API level 7) — oculta o texto do campo
    atrás de bullets, com botão ver/ocultar ao lado do X.
  - `hint` (String, API level 11) — `"num"` abre na página numérica (mesmo
    layout do `prompt`).
- **Retorna:** `false` se já há uma sessão aberta (uma por vez) ou não há
  display.
- **Descrição:** abre a sessão de teclado e a desenha imediatamente. Enter
  (OK) **não** fecha a sessão: limpa o buffer e mantém o teclado aberto —
  ideal para UIs linha a linha. A sessão termina no `X` (só com
  `field: true`, reportado como evento `cancel`) ou com
  `System.keypadClose()`.

#### `System.keypadPoll()` → Object|null
- **Retorna:** `null` quando nada aconteceu, ou um objeto de evento por
  chamada:
  - `{type: "change"}` — o buffer mudou (tecla/backspace/espaço); leia com
    `System.keypadText()`.
  - `{type: "enter", text: "..."}` — OK pressionado; `text` é a linha, o
    buffer é limpo depois.
  - `{type: "cancel"}` — X pressionado; a sessão **se fechou sozinha**
    (redesenhe sua tela, o teclado sumiu).
- **Descrição:** bombeia o toque para o teclado, redesenha as teclas quando
  necessário (feedback de pressionamento, páginas de layout, cursor piscando)
  e reporta no máximo um evento por chamada. O canto de saída do SO no topo
  direito continua funcionando com o teclado aberto. Chame a cada iteração
  do loop enquanto a sessão estiver aberta.

#### `System.keypadText()` → String
Buffer de input atual (o mesmo texto que o campo nativo mostraria).

#### `System.keypadRect()` → `{x, y, w, h}`
Área ocupada pelo teclado no canvas virtual 240x320 (`h` é 0 com a sessão
fechada). O app não deve desenhar dentro dela.

#### `System.keypadDraw()`
Re-blita o teclado depois que o app repinta uma região que o sobrepõe (não é
necessário se o app só desenha acima de `keypadRect().y`).

#### `System.keypadClose()`
Fecha a sessão e libera o teclado. O próximo `present()` restaura o frame do
app. Sessões também são fechadas automaticamente quando o app sai.

### 13.2 Exemplo — linha de input acima de um teclado acoplado

```javascript
var T = System.theme();
System.keypadOpen({ field: false, maxLen: 96 });
var kbTop = System.keypadRect().y;   // o app é dono de 0..kbTop

while (true) {
    var ev = System.keypadPoll();
    if (ev && ev.type === "enter") {
        handleLine(ev.text);          // ex.: comando, mensagem, busca...
        redrawScreen();
    } else if (ev && ev.type === "change") {
        redrawInputLine(System.keypadText());
    }
    System.delay(20);                 // GC + present (obrigatorio)
}
```

Implementação de referência: `data/apps/Terminal/main.js` (app W9
pré-instalado).

### 13.3 Constantes globais de cor (correção da API 5)

`BLACK, WHITE, RED, GREEN, BLUE, YELLOW, CYAN, MAGENTA, ORANGE, DARKGREY`
agora são registrados como constantes globais RGB565 (antes do W9 o
registro era um no-op — os apps precisavam de `System.color()`).
`System.color()` e `System.theme()` seguem sendo a forma recomendada de obter
cores.

---

## 14. Topbar do Sistema

Todo app JS roda sob a **topbar do sistema** — uma faixa desenhada pelo core
com o nome do app e o botão **X** de sair à direita. O modo vem do pacote,
não do código:

- **Fixa** — `"topbar": true` no `app.json`: a faixa fica sempre visível e o
  canvas virtual 240x320 mapeia a área abaixo dela (as coordenadas do
  `getTouch` já descontam a faixa). Use em apps estilo sistema, com
  menus/listas/formulários — Settings, App Store, Terminal.
- **Retrátil (padrão)** — sem o campo `topbar`: o app roda em **tela cheia**
  (canvas 1:1 sobre o painel inteiro, como os apps pré-topbar). Deslizar o
  dedo de cima para baixo no **terço direito** da borda superior revela a
  faixa por **3 segundos**; todo o gesto de revelar é consumido pelo sistema —
  o app nunca vê o press/release dele. Ideal para jogos (Snake, 2048, Breakout).

Notas:

- No modo fixa, toques na faixa nunca chegam ao app; no retrátil, apenas
  enquanto ela está visível (X incluído — dispara no release, com debounce).
- Com gestos de relógio ativos (placas com touch), a borda de cima é dividida
  em terços: a esquerda abre os **ajustes rápidos** e o centro a **central de
  notificações** (ambos saem do app pelo caminho limpo do X); o terço direito
  é da revelação retrátil. Jogos não devem depender de arrastos para baixo
  que começam nos terços esquerdo/central da faixa do topo.
- Em placas com PSRAM a faixa é composta dentro do quadro (sem flicker; ao
  esconder, a área volta atomically no próximo push). Na CYD (desenho direto) a faixa só é
  desenhada quando muda, e o display fica recortado abaixo dela — o app não
  consegue pintar por cima (`System.setClip` é intersectado com essa área); ao
  esconder, ela permanece até o app repintar a região.
- Nada para codificar em nenhum dos modos: o mesmo main.js renderiza
  corretamente nos dois — o campo no `app.json` é o contrato inteiro.

### 14.1 Conteúdo custom (API 6)

Apps podem colocar texto próprio e **chips** tocáveis na faixa:

#### `System.topbarText(texto)`
Substitui o nome do app exibido na faixa (`""` restaura o nome). Redesenha sozinho.

#### `System.topbarButtons(labels)` → Number
Coloca até 3 chips tocáveis na faixa, da direita para a esquerda antes do X (`labels` = array de strings curtas, ex.: `["+", "Limpar"]`). Retorna quantos couberam. `[]` limpa.

#### `System.topbarPop()` → String|null
Consome o toque de chip mais antigo desde a última chamada (FIFO). O chip destaca enquanto pressionado e dispara no release (mesmo contrato com debounce do X).

```javascript
System.topbarText("Toques: 0");
System.topbarButtons(["+", "Limpar"]);
while (true) {
    var id = System.topbarPop();
    if (id === "+") { n += 10; System.topbarText("Toques: " + n); }
    else if (id === "Limpar") { n = 0; System.topbarText("Toques: 0"); }
    System.delay(20);
}
```

No modo retrátil os chips só são tocáveis enquanto a faixa está visível.
Para continuar instalável em firmware antigo, detecte a função
(`typeof System.topbarText === "function"`).

Implementação de referência: `data/apps/Touch Test/main.js`.

---

## 15. Celer Link (API 9)

Link Bluetooth LE entre CelerOS próximos. O caso clássico: uma placa com
CelerOS no robô fazendo `CelerLink.start()`, e o controle vindo de outro
CelerOS (por exemplo o 4848 SmartDisplay) com `scan()`, `connect()` e
`send()` dentro de um app JS.

**Disponibilidade:** só em placas compiladas com Bluetooth
(`CONFIG_CELEROS_BLUETOOTH`; a SmartDisplay tem, a CYD é experimental).
Detecte com `typeof CelerLink !== "undefined"` para continuar instalável em
qualquer firmware.

**Segurança:** o link em si segue sem criptografia no ar, mas desde a
**API 11** há **pareamento por código** opcional: o lado do `start()` liga
`{pairing: true}`, cada conexão nova gera um código de 6 dígitos que só o
app **local** vê (`status().code` — desenhe na tela do robô) e o controle
digita via `verify()`. Sem o código certo, `send()`/`poll()` ficam fechados.
Controles aprovados são memorizados no firmware (até 4) e reconectam sem
código. O código viaja em claro: isso trava o vizinho casual que conecta e
controla, não quem grampeia o rádio. Para Robôs de brinquedo e protótipos;
não use para nada sensível.

Modelo: uma conexão por vez, mensagens de até **240 bytes**, melhor esforço.
Quem quer ser controlado chama `start()` (advertising BLE + servidor GATT,
visível como `Celer-XXXX`). O controle escaneia, conecta e troca mensagens.
Os dois sentidos funcionam; o link é simétrico depois de conectado.

#### `CelerLink.start([nome], [opcoes])` → Boolean
Vira controlável: liga o advertising e o servidor GATT. `nome` é o nome BLE
do device (até 29 bytes). O default é o nome do aparelho na matilha — o
mesmo que a CelerNet anuncia (`Pack.me().name`, setting `celernet_name`,
`Celer-XXXX` até ser renomeado; API 40). A primeira chamada de qualquer função
inicializa o Bluetooth (~300 ms). O nome volta ao default quando o app sai.

`opcoes` (objeto, **API 11**): `{pairing: true}` liga o gate de pareamento —
cada conexão nova exige o código de 6 dígitos (veja `verify()` e
`status().code`). **Desde a API 14 o pareamento é o padrão**: `start()` /
`start(nome)` já exigem o código (antes qualquer aparelho BLE por perto podia
mandar comandos). Link aberto só com `{pairing: false}` explícito. Mostre
`status().code` na tela do app periférico quando `status().pairing` for
`true`. Vale para as conexões seguintes à chamada.

Pareados viram *bond* com chave (API 14): a chave nasce do código + um
desafio daquela conexão, e nas reconexões o central responde a um desafio
novo — trocar o MAC para o de um controle pareado não abre mais o canal.
Bonds da API 11 (só MAC) são descartados: cada controle pareia uma vez de
novo. Central com firmware antigo passa a pedir o código a cada conexão.

#### `CelerLink.stop()` → Boolean
Para o advertising (o device deixa de ser descobrível).

#### `CelerLink.scan([timeoutMs])` → Array
Escaneamento bloqueante (default 2500 ms) por CelerOS próximos. Retorna
`[{id: "AA:BB:CC:DD:EE:FF", name: "Celer-9F2A", rssi: -55, node: 0xEEFF}]`,
sinal mais forte primeiro (até 16 devices). `node` (API 40) é o id do aparelho
na matilha — o mesmo `id` dele em `Pack.members()`/`CelerNet.nodes()` (como
número; a malha mostra em 4 dígitos hex).

#### `CelerLink.connect(idOuNome, [timeoutMs])` → Boolean
Conecta num device do último `scan()`, pelo `id` (MAC) ou pelo `nome`.
Bloqueante (default 4000 ms, máx. 8000): o prazo cobre a conexão inteira —
enlace, negociação do MTU, descoberta, inscrição e leitura do estado de
pareamento do peer. Só retorna `true` com o link estabelecido; se o peer
exige código, `status().pairing` vem `true` e o canal de dados só abre após
`verify()` (nesse estado `connected`/`send()` seguem `false`). Substitui a
conexão atual.

#### `CelerLink.disconnect()` → Boolean
Derruba a conexão atual (inclusive uma pendente de pareamento).

#### `CelerLink.verify(codigo)` → Boolean (API 11)
Lado do controle: envia o `codigo` (6 dígitos) ao peer conectado que exige
pareamento. Bloqueante (~3 s). `true` = aceito, canal liberado
(`status().verified` e `connected` viram `true`); `false` = recusado, link
caído ou código inválido. Idempotente: num link já verificado (ou sem
pareamento) retorna `true` sem tocar no rádio. Regras do lado que exige:
**3 códigos errados** derrubam a conexão; **60 s** sem digitar derrubam e o
código é regerado na próxima conexão.

#### `CelerLink.unpair([id])` → Boolean (API 11)
Lado do robô: esquece os controles pareados memorizados no firmware. Sem
argumento apaga **todos**; com `"AA:BB:CC:DD:EE:FF"` apaga só aquele. A
memória sobrevive a reboot e troca de app (NVS) — é isso que faz a
reconexão dos pareados entrar sem código. Devolve `false` se o `id` não
estava pareado ou é inválido.

#### `CelerLink.send(mensagem)` → Boolean
Envia uma mensagem ao peer conectado (até 240 bytes). **String** vai como
bytes crus; **objeto** é serializado como JSON — comunicação estruturada sem
parser no firmware (quem recebe decide como ler). Retorna `false` sem
conexão, se a mensagem não cabe no MTU negociado (entre CelerOS: 253 bytes,
então 240 sempre cabe; um celular sem troca de MTU aceita só 20) ou, no lado
`start()`, se o peer ainda não assinou as notificações. Nunca entrega
mensagem cortada.

#### `CelerLink.poll()` → String|null
Consome a mensagem recebida mais antiga (FIFO de 8). Fila cheia descarta a
**mais antiga** (num controle remoto o comando novo vale mais; veja
`status().dropped`). A fila é limpa a cada conexão nova. `null` quando vazia.
Chame no loop do app, como o `keypadPoll` — de preferência num laço até
`null`, para não acumular comandos velhos.

#### `CelerLink.status()` → Object
`{connected, peer, node, listening, role, name, pairing, verified, code, mtu, rssi, pending, dropped}`:

| Campo | Significado |
|-------|-------------|
| `connected` | Boolean — link **autorizado** para `send()` (false durante o pareamento pendente) |
| `peer` | `"AA:BB:CC:DD:EE:FF"` ou `""` |
| `node` | Number (API 40) — id do peer na matilha (`0` sem conexão) |
| `listening` | Boolean — advertising pedido via `start()` |
| `role` | `"central"` (nós conectamos), `"peripheral"` (conectaram em nós) ou `""` |
| `name` | nosso nome de advertising |
| `pairing` | Boolean (API 11) — handshake pendente: mostrar o código (periférico) ou pedir ao usuário (central) |
| `verified` | Boolean (API 11) — canal de dados liberado (`true` em link sem pareamento) |
| `code` | código de 6 dígitos do pareamento — **só** no periférico durante `pairing`; nunca sai do device |
| `mtu` | MTU ATT negociado (0 sem conexão); payload máx. = `mtu - 3` |
| `rssi` | sinal da conexão em dBm (0 sem leitura) |
| `pending` | mensagens esperando `poll()` |
| `dropped` | mensagens descartadas por fila cheia desde o início do app |

Queda de link: o supervision timeout é de ~2 s. Robôs devem parar sozinhos
se os comandos pararem de chegar (keepalive) — o Celer Remote repete o `move`
a cada 250 ms enquanto a seta está pressionada e manda `stop` ao soltar; o
Dog Face para após 900 ms sem `move` ou quando o link cai.

Sair do app reseta a sessão sozinho (desconecta e para o advertising);
chame `stop()`/`disconnect()` só para controlar no meio do app.

### Exemplo — pareamento por código (API 11)

```javascript
// lado do ROBO (periferico): codigo na tela enquanto o handshake pendura
CelerLink.start("Celer-Dog", {pairing: true});
while (true) {
    var st = CelerLink.status();
    if (st.pairing) {
        // desenhe st.code GRANDE na tela (o Dog Face usa sete-segmentos);
        // expira sozinho em 60 s e nasce novo na proxima conexao
        System.fillScreen(0);
        System.setTextColor(0xFFFF);
        System.drawString(st.code, 40, 140, 4);
    }
    var msg = CelerLink.poll();
    if (msg !== null && st.verified) { /* comandos: so chegam liberados */ }
    System.delay(30);
}

// lado do CONTROLE: apos connect() true
if (CelerLink.status().pairing) {
    var cod = System.prompt("codigo na tela do robo", "");
    if (!cod || !CelerLink.verify(cod)) { System.exitApp(); }  // recusado
}
```

Compatibilidade: peers de firmware anterior à API 11 seguem funcionando —
central antigo conecta num robô com pareamento mas não controla nada (o
canal fica fechado); central novo num peer antigo não vê `pairing` e cai
direto no controle. Pareados são memorizados no NVS (até 4, mais recente
primeiro): a reconexão entra sem código; `unpair()` esquece.

### Exemplo — lado do robô (controlável)

```javascript
// "bot": recebe comandos e age (aqui beep/LED; servos num robo de verdade)
// link aberto so para a demo: em app real deixe o pareamento (padrao) e
// mostre status().code na tela
CelerLink.start(null, {pairing: false});  // "Celer-XXXX" no ar
System.drawString("esperando controle...", 10, 10);
while (true) {
    var msg = CelerLink.poll();
    if (msg !== null) {
        var cmd = null;
        try { cmd = JSON.parse(msg); } catch (e) {}
        if (cmd && cmd.type === "move") {
            System.beep(50, 10);
            System.led(0, (cmd.speed || 0) > 128 ? 255 : 0, 0);
        }
    }
    System.delay(20);
}
```

### Exemplo — lado do controle (o 4848)

```javascript
// "remote": escaneia, conecta e envia o D-pad como JSON
var peers = CelerLink.scan(3000);
if (!peers.length) { System.drawString("nenhum CelerOS por perto", 10, 10); System.delay(2000); System.exitApp(); }
if (!CelerLink.connect(peers[0].id)) { System.drawString("conectou nao", 10, 10); System.delay(2000); System.exitApp(); }

var last = "";
while (true) {
    var t = System.getTouch();
    var dir = "";
    if (t.touched) {
        if (t.y < 100) dir = "up"; else if (t.y > 220) dir = "down";
        else if (t.x < 100) dir = "left"; else if (t.x > 140) dir = "right";
    }
    if (dir !== last) {
        last = dir;
        CelerLink.send(dir ? {type: "move", dir: dir, speed: 200} : {type: "stop"});
    }
    System.delay(20);
}
```

Os dois exemplos também funcionam em par com o app nRF Connect no celular
(conecte no `Celer-XXXX`, escreva na característica, ative notificações).

## 16. Nível de API 12 — Timers, Storage, sprites múltiplos e FS binário

### 16.1 Timers (`setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`)

Globais no padrão do navegador. Disparam **nos pontos onde o app cede** — o
início de `System.delay`, `System.getTouch`, `System.keypadPoll` e das
chamadas bloqueantes (`Net.*`, `FS.getFileMD5`, ...). Um loop apertado que
nunca cede não vê os timers dispararem (e já derruba o watchdog sozinho).
Sem `Promise` no Duktape, esta é a fundação de "event loop" cooperativo.

```js
var iv = setInterval(function () {
    relogio(System.getTime());
}, 1000);            // 1x por segundo, enquanto o app ceder

setTimeout(function () {
    clearInterval(iv);
    System.toast("pronto");
}, 60000);
```

- **Retorno:** id `>= 1`, único dentro do app (`0` = falhou — máximo 8
  timers vivos). Um id de timer que já disparou ou foi cancelado não
  cancela o timer novo que reaproveitou a vaga. Piso de 10 ms.
- **Erro no callback PROPAGA**: o app morre com a tela de erro e a stack do
  callback (mesma política de qualquer binding). Interval atrasado dispara
  **uma vez** na cedida seguinte (catch-up sem rajada).
- Os timers morrem com o app — nada atravessa apps.

### 16.2 `Storage` — persistência privada do app

O "localStorage" do CelerOS: chave-valor em NVS com **namespace próprio por
`packageName`** (o `System.setting` é global e apps colidiam entre si).
Dispensa `permissions`.

```js
Storage.set("recorde", "3250");
Storage.set("nome", "Maikeu");
var r = Storage.get("recorde", "0");   // default quando ausente
Storage.remove("recorde");
Storage.clear();                       // apaga TUDO do app
```

- Chave: 1–15 caracteres (limite do NVS). Valor: string até 4 KB (bytes
  `\0` preservados); números e booleanos são serializados (`get` devolve
  **sempre string** — `""` quando ausente e sem default; converta de volta
  com `parseInt`/`parseFloat`).
- `set` devolve `false` quando gravar deixaria a NVS sem a folga reservada
  ao sistema (credenciais WiFi, calibração, ajustes) — a partição é pequena
  (~20 KB) e compartilhada.
- `packageName` com mais de 11 caracteres usa um namespace por hash do nome
  completo (antes o nome era cortado e `celeros.notes`/`celeros.notepad`
  dividiam dados); os dados do namespace antigo são copiados na primeira
  abertura.
- Scripts `.js` avulso (sem app.json) compartilham o namespace `app__anon`.
- `Storage.clearFor(packageName)` apaga o Storage de OUTRO app — exige a
  permissao `"system"` (a App Store 2.1.3+ usa na desinstalacao; `clear()`
  so apaga o Storage do PROPRIO app).

### 16.3 Sprites múltiplos (`System.useSprite`)

`System.createSprite(w, h)` agora devolve um **id** `1..8` (`0` = falhou) e o
sprite novo vira o alvo das próximas operações (apps antigos que ignoram o
retorno continuam funcionando). `System.useSprite(id)` troca o alvo:
`0` = quadro/display, `1..8` = sprite existente. `System.deleteSprite(id)`
apaga um sprite específico (sem argumento, apaga o corrente).

```js
var fundo = System.createSprite(240, 200);   // id 1
var heroi = System.createSprite(24, 24);     // id 2 — vira o corrente
System.fillRect(0, 0, 24, 24, System.color(255, 0, 0));
System.useSprite(fundo);                     // desenha no fundo
System.fillRect(0, 0, 240, 200, 0);
System.pushSprite(0, 40);                    // fundo (corrente) vai ao vidro
System.useSprite(heroi);
System.pushSprite(10, 50);                   // heroi por cima
System.useSprite(0);                         // volta a desenhar no quadro
```

Máximo de **8 sprites com PSRAM, 1 sem PSRAM** (API 29 dobrou o pool;
`System.spriteSlots()` informa o limite da placa — o degradê silencioso para
8-bit do sprite gigante continua valendo).

### 16.4 FS binário (`FS.readFile` / `FS.writeFile`)

Leitura e escrita de **bytes** — cada byte do arquivo vira um caractere
(0–255) da string. O `readTextFile` truncava no primeiro `\0`; estes não.

```js
FS.writeFile("/local/dado.bin", String.fromCharCode(1, 0, 2, 255));
var d = FS.readFile("/local/dado.bin", 512);   // maxLen opcional (default 16KB, teto 64KB)
if (d !== null && d.charCodeAt(1) === 0) { /* ... */ }
```

- `readFile` devolve `null` quando o arquivo não existe. `writeFile` aceita
  até 64 KB por chamada.
- Regras do jail de segurança (arquivos do sistema exigem `"system"`)
  valem para os dois.

### 16.5 `System.setTextDatum(datum)`

Âncora do `drawString` no alvo corrente: `0`=TL (default — comportamento
anterior), `1`=TC, `2`=TR, `4`=ML, `5`=MC, `6`=MR, `8`=BL, `9`=BC, `10`=BR.
Centralizar texto deixa de precisar do par `textWidth`/conta-na-mão. O datum
é resetado para `0` a cada app.

```js
System.setTextDatum(5);               // meio-centro
System.drawString("GAME OVER", 120, 160, 4);
System.setTextDatum(0);               // bom costume: devolve ao default
```

## 17. Nível de API 12 — Energia e hora

### 17.1 Tempo de tela — `System.setScreenTimeout(ms)` / `System.screenTimeout()`

Sem toque por `ms` milissegundos o backlight apaga; o **primeiro** toque
depois disso apenas acorda a tela (o evento é consumido — nada é clicado às
cegas). `0` = sempre ligada (default). Faixa aceita: 10 s a 4 h. Persistido
entre boots e configurável também em **Configurações → Tela** ("Tela
apaga"). Placa sem backlight PWM: no-op.

### 17.2 Sono profundo — `System.deepSleep(ms[, wakePin])` *(requer `"system"`)*

Dorme de verdade: o chip desliga e **acorda com um reboot completo** (apps
não sobrevivem — o `resetReason` do boot seguinte é `"deep sleep"`). O timer
de `ms` sempre acorda; `wakePin` opcional também acorda com nível alto
(botão, INT do touch...). Uso típico: robôs/bateria que acordam de hora em
hora para checar a rede.

```js
System.deepSleep(3600000);        // 1 hora
System.deepSleep(0, 4);           // so o pino 4 (0 ms = erro)
System.deepSleep(600000, 4);      // o que vier primeiro
```

### 17.3 Alarme do dia — `System.setAlarm(h, m[, msg])` / `clearAlarm()` / `getAlarm()`

Dispara na **próxima** ocorrência de `h:m` (hoje se ainda não passou, senão
amanhã) com um toast **ALARME: msg** e desarma. Em RAM (não sobrevive a
reboot); precisa de hora válida (NTP ou ajuste manual — trocar fuso ou hora
recalcula a próxima ocorrência). Conferido pelo launcher: com um app aberto,
o toast aparece quando o app fecha. `System.getAlarm()` devolve
`{armed, hour, minute, msg}` ou `null` (mensagem até 64 caracteres).

### 17.4 Hora persistente

Sem RTC externo, a hora agora sobrevive a reboot: o sistema grava o epoch
no NVS a cada 10 min e recupera no boot (precisão de minutos — o tempo
desligado não é contado). Sem isso, todo boot sem rede voltava a 1970.

### 17.5 Mudança de watchdog para apps legítimos

`System.getTouch()` (e todo ponto de espera) agora alimenta o watchdog do
sistema: **loops de jogo que só chamam `getTouch`/`present` não reiniciam
mais o aparelho** aos 15 s. Um loop JS puro sem NENHUMA chamada de API
continua derrubando o WDT — nesse caso o app é o travado mesmo (e o
`celerctl shell "exit"` recupera o aparelho remotamente).

## 18. Nível de API 12 — Melodias, notificações e widgets do toolkit

### 18.1 `System.playTone(notas)` — melodia bloqueante

`notas` é array de pares `[[freq, ms], ...]` ou plano `[freq, ms, freq, ms,
...]`. Cada nota toca no hardware de áudio da placa (o mesmo do `beep`;
alto-falante I2S ou buzzer LEDC), com o watchdog alimentado entre notas.
Limites: 1–64 notas, nota de 20 Hz–20 kHz por 1–2000 ms, 15 s no total.
Devolve o número de notas tocadas. Blocking: desenhe antes.

```js
System.playTone([[880,120],[0,60],[1320,180]]);  // pausa = freq 0? -> use nota de 20ms a 20Hz p/ pausa
```
*Correção: não há nota "silêncio" — intercale notas curtas de grave ou corte
a melodia em chamadas.*

### 18.1b `System.playWav(caminho)` — arquivo WAV do FS

Toca um **WAV PCM 16-bit** (mono ou estéreo, 8–48 kHz) direto do FS
(`/local` ou `/sd`) em streaming pelo I2S — o arquivo não carrega inteiro
na RAM, o watchdog é alimentado por chunk e o volume é o do
`System.setVolume`. Bloqueante. `true` = tocou; `false` = placa sem
alto-falante I2S, arquivo ausente ou cabeçalho inválido. Regras do jail
valem (arquivo do sistema exige `"system"`).

```js
System.playWav("/sd/aviso.wav");
```

### 18.2 `System.notify(titulo[, msg])` + centro de notificações

Toast **agora** + registro no histórico `/local/notifications.txt` (cap 20
entradas, protegido pelo jail — apps só escrevem nele por esta chamada). O
**Configurações → Notificações** lista tudo com data/hora e tem "Limpar
notificações". Apps com `"system"` também leem via
`System.notifications()` (array `{epoch,title,msg}`) e limpam via
`System.notificationsClear()`.

```js
System.notify("Bateria fraca", "15% restante");
```

### 18.3 OTA por variante (SKUs "Y" de relé)

O `update.json` pode declarar `"variant"` (ex.: `"smartdisplay-y3"`). O
dispositivo compara com a própria variante (placas com relés são
`smartdisplay-y1`/`-y3`) e **recusa** atualização de outra variante — e um
aparelho COM relés também recusa manifest **sem** variant (a imagem genérica
é a que desinstala o suporte a relé). Sem `variant` no manifest: instala só
em dispositivos sem relés (retrocompatível com o canal atual).

### 18.4 Widgets nativos do Kui (toolkit C++)

`Switch` (pilula on/off com onChange), `Slider` (0..100 com onLiveChange/
onChange), `ProgressBar` (fill 0..100) e `Spinner` (arco girando) entram no
toolkit nativo (`main/UI/Kui.h`) para as telas do sistema — mesmos padrões
de `Button`/`List` (immediate mode, feedback de pressão, hit-test no Rect).

## 19. Nível de API 13 — Sensores do watch (IMU), dia da semana, keepAwake

Adicionadas para a board do smartwatch Waveshare AMOLED 2.06 (IMU QMI8658);
em placas sem o hardware as chamadas degradam limpo (feature-detect com
`System.getInfo().hasImu`).

### 19.1 `Sensors.accel()`

- **Retorna:** `Object` -> `{ x, y, z }` em **g** (faixa ±8 g), ou `null`
  se a placa não tem IMU.
- **Descrição:** última amostra da task de movimento (cache a ~30 Hz — não
  faz I²C na chamada, segura em loops).

### 19.2 `Sensors.steps()`

- **Retorna:** `Integer` — passos do dia corrente (zera à meia-noite,
  persistido entre reboots), ou `-1` sem IMU.
- **Descrição:** pedômetro portado do firmware de referência do watch
  (pico/vale sobre a aceleração dinâmica, linha de base com LPF, cadência
  mínima de 280 ms).

### 19.3 `Sensors.temp()`

- **Retorna:** `Number` — temperatura do die do IMU em °C, ou `-255` se
  indisponível (leitura I²C on-demand; não chamar em loops apertados).

### 19.4 `System.getWeekday()`

- **Retorna:** `Integer` — `0` (domingo) .. `6` (sábado), hora local.

### 19.5 `System.keepAwake(bool)`

- **Descrição:** segura a tela acesa (pula a escada dim/AOD/off do
  ScreenPower) enquanto `true`, ou por `ms` milissegundos com
  `System.keepAwake(ms)` (expira sozinho). Jogos e apps de treino chamam
  ao abrir. **Solto automaticamente quando o app fecha.** No-op em placas
  sem estados de tela.

### 19.6 `System.setVolume(pct)` / `System.getVolume()` (API 13)

- **Parâmetros/Retorna:** `pct` 0..100 (default 100; persistido só por
  apps `"system"` — nos demais vale enquanto o app roda).
- **Descrição:** volume do áudio do OS. Nas placas I²S escala a forma de
  onda; no codec do watch (ES8311) também vai no registrador de volume de
  hardware. `System.beep`/`playTone` pegam o valor sozinhos. Placas de
  buzzer (LEDC) têm ganho fixo — o valor segue guardado.
  `System.getInfo().hasMic` diz se há `System.micLevel()` disponível (cão
  robô e o watch).

## 20. Nível de API 14 — Consentimento de permissões, pareamento padrão, prompt

### 20.1 Consentimento de permissões

O `"permissions"` do `app.json` agora é um **pedido**: na primeira vez que o
app abre (ou quando uma atualização pede algo novo) o launcher mostra
**"Permitir <app>? Acesso a: arquivos, rede, GPIO, sistema"**. O runtime
recebe só o que foi concedido (declaradas ∩ concedidas). App sem o campo
pede as quatro — declare só o que usa. Concessões ficam no NVS, por
`packageName` + pasta de instalação (cópia em outra pasta pede de novo).
Apps já instalados quando o firmware com consentimento roda pela primeira
vez são concedidos automaticamente. Desinstalar (launcher ou
`Storage.clearFor` da loja) esquece a concessão.

`packageName` precisa ser `[A-Za-z0-9._-]` (até 64, sem `..`); fora disso é
ignorado (o app é identificado pelo nome).

Regras do `FS` que acompanham:
- **Escrita** em `/local/apps` e `/sd/apps` (código de outros apps) só com
  `"system"` — leitura segue livre.
- `/local/data/<pkg>/` de **outro** app é invisível (leitura e escrita);
  o `FS.appData()` do próprio app segue aberto.
- Árvores: copiar `/local` ou `/local/data` inteiros, ou remover/usar como
  destino a raiz do `/sd`, só com `"system"`.

### 20.2 `CelerLink.start` exige pareamento por padrão

Veja `CelerLink.start` acima. Use `{pairing: false}` para o link aberto.

### 20.3 `System.prompt(msg, inicial, {nullOnCancel: true})`

Com `nullOnCancel`, cancelar (X) devolve `null`; sem a opção continua `""`
(não dá para distinguir de confirmar vazio). O teclado também atende o
`exit` remoto e os botões físicos enquanto está aberto (timers JS pausam
até ele fechar).

### 20.4 Alarme e toasts com app aberto

O alarme do `System.setAlarm` dispara mesmo com um app aberto: a faixa do
sistema vira um banner **ALARME: msg** por 8 s e o aparelho bipa 3 vezes.
`System.toast`/`notify` chamados durante o app agora aparecem quando ele
fecha (antes o primeiro "vencia" antes de ser desenhado).

### 20.5 `FS.listDir` sem limite

Devolve todas as entradas (antes cortava em 128 em silêncio).

## 21. Nível de API 15 — Experiência de relógio: bateria, geometria da tela, histórico de passos

Chegou com o trabalho do smartwatch (placa `waveshare-watch`); todas as
chamadas degradam sem erro nas outras placas.

### 21.1 `System.batteryInfo()` (API 15)

- **Retorna:** `Object` -> `{ mv, pct, charging, usb, full }`, ou `null`
  quando a placa não lê bateria.
  - `mv`: tensão da célula (mesmo valor de `System.battery()`).
  - `pct`: 0..100. Vem do fuel gauge do PMU (AXP2101 do relógio) ou é
    estimado pela curva de descarga LiPo sobre `mv` nas placas com divisor
    simples. `-1` se desconhecido.
  - `charging` / `usb` / `full`: estado de carga; sempre `false` em placas
    sem PMU.
- **Descrição:** o firmware guarda em cache por ~2 s; pode chamar uma vez
  por quadro.

### 21.2 Campos novos em `System.getInfo()`

| Campo | Tipo | Significado |
|---|---|---|
| `hasBattery` | Boolean | `System.batteryInfo()` devolve dados |
| `board` | String | id do perfil da placa (ex.: `"waveshare-amoled206"`) |
| `inset` | Integer | margem segura em px **virtuais** (espaço de 240 de largura) para manter o conteúdo longe dos cantos arredondados do vidro; `0` em tela retangular |
| `shape` | String | `"rounded"` (vidro de cantos arredondados) ou `"rect"` |

### 21.3 `Sensors.stepHistory()` (API 15)

- **Retorna:** `Array` de `{ date, steps }` dos últimos dias fechados (até 7,
  o mais recente primeiro). `date` é um inteiro `aaaammdd`. Vazio sem IMU ou
  antes da primeira meia-noite.
- **Descrição:** o pedômetro agora vira o dia à meia-noite com o relógio
  ligado (antes, só no boot) e arquiva o dia encerrado.

### 21.4 Comportamento do app casa

Nas placas com app casa (relógio: o watchface), o botão BOOT na raiz do
launcher abre a casa, e o launcher volta para ela depois de `home_idle_s`
segundos ocioso (ajuste de sistema, padrão 30, `0` desliga).

### 21.5 Alarmes múltiplos e timer

#### `System.alarms()` / `System.addAlarm(alarm)` / `System.updateAlarm(id, alarm)` / `System.removeAlarm(id)` (API 15)

#### `System.setTimer(seconds, label)` / `System.getTimer()` / `System.cancelTimer()` (API 15)

Os alarmes agora vivem num agendador do sistema persistido no NVS (sobrevivem
a reboot e deep sleep — o relógio acorda por timer para o próximo evento).
Quando um dispara, o app aberto é fechado e uma tela de alarme em tela cheia
toca (funciona com a tela apagada ou em AOD) com **Soneca 5 min** / **Parar**;
sem resposta por 2 minutos, entra em soneca sozinho.

| Chamada | Retorna | Notas |
|---|---|---|
| `System.alarms()` | `Array` de `{ id, hour, minute, days, enabled, label, next }` | `days` = máscara, bit0 domingo .. bit6 sábado, `0` = uma vez (desliga sozinho depois de tocar). `next` = epoch em segundos do próximo toque, `0` quando desligado |
| `System.addAlarm({hour, minute, days?, enabled?, label?})` | `id` ou `-1` | até 8 alarmes; rótulo até 40 caracteres |
| `System.updateAlarm(id, {...})` | `Boolean` | substitui o alarme daquele slot |
| `System.removeAlarm(id)` | `Boolean` | |
| `System.setTimer(segundos, rotulo?)` | `Boolean` | uma contagem regressiva (1..86400 s), roda em segundo plano, substitui a atual |
| `System.getTimer()` | `{ remaining, label }` ou `null` | |
| `System.cancelTimer()` | — | |

`System.setAlarm/getAlarm/clearAlarm` (API 12) continuam funcionando: mapeiam
para o slot `0` como alarme de uma vez, agora persistente.

### 21.6 `System.unreadNotifications()` (API 15)

- **Retorna:** `Integer` — notificações não lidas (sem permissão; o conteúdo
  continua exigindo `"system"` via `System.notifications()`). Viram lidas
  quando o usuário abre a central de notificações (relógio: arrastar para
  cima a partir da borda de baixo).

`System.getInfo()` também ganha `screenW` / `screenH`: o tamanho físico do
vidro, para apps que desenham geometria (ex.: ponteiros analógicos) e
precisam compensar a escala não uniforme do 240x320.

### 21.7 `Phone` — o celular pareado (Gadgetbridge)

Só existe nas placas compiladas com `CONFIG_CELEROS_PHONE_LINK` (o relógio):
teste com `typeof Phone !== "undefined"`. O relógio aparece no
**Gadgetbridge** (Android) como um **Bangle.js**; o pareamento pede o código
de 6 dígitos mostrado no relógio. As notificações do celular caem na central
de notificações do sistema, a hora é ajustada pelo celular e as chamadas
abaixo expõem o resto.

#### `Phone.status()` (API 15)

- **Retorna:** `{ enabled, connected, passkey, name }` — `passkey` é o
  código de pareamento na tela agora (`0` quando não há); `name` é o nome
  Bluetooth que o celular vê (`Bangle.js xxxx`).

#### `Phone.forget()` (API 15)

- Apaga o pareamento (bonds do NimBLE) e derruba o celular; esqueça o
  relógio no Android também antes de parear de novo. Exige `"system"`.

O sistema cuida do resto sem código de app: código de pareamento em tela
cheia, tela de chamada recebida (Recusar/Atender voltam ao celular),
notificação dispensada no relógio some no celular, a versão do firmware
aparece no Gadgetbridge, e bateria/passos são enviados quando mudam ou
quando o Gadgetbridge pede. Notificação nova **acorda o relógio com o
alerta em tela cheia** (origem, título, corpo e hora; sem toque volta a
dormir em ~8 s, toque abre a central; com a tela acesa em um app vale só o
toast). Em Não perturbe só o histórico, sem som nem alerta. O texto do
Android é reduzido ao que as fontes desenham (emoji some, aspas/travessões
tipográficos viram ASCII).

#### `Phone.music(cmd)` / `Phone.musicInfo()` (API 15)

- `cmd`: `"play"`, `"pause"`, `"playpause"`, `"next"`, `"previous"`,
  `"volumeup"`, `"volumedown"`. Retorna `false` sem conexão.
- `musicInfo()` → `{ artist, track, album, state }` ou `null` antes de o
  celular mandar algo.

#### `Phone.weather()` (API 15)

- **Retorna:** `{ temp, hum, txt, loc, age }` (temp em °C, `age` em segundos
  desde que o celular mandou; guardado entre reboots) ou `null`.

#### `Phone.find(on)` (API 15)

- Faz o celular tocar (`true`) ou parar (`false`). O celular também pode
  fazer o relógio bipar ("encontrar dispositivo" no Gadgetbridge); um toque
  para. **O toque é do lado do Gadgetbridge** (sem confirmação): configure o
  tom de ping (GB → Ajustes de notificação → Ping tone) e, no Android 10+,
  o som só toca de forma confiável com o pareamento via Companion Device —
  sem isso o GB pode mostrar o aviso na tela sem tocar.

#### `Phone.setEnabled(on)` (API 15)

- Liga/desliga o link com o celular (persistido). Exige `"system"`; o painel
  de ajustes rápidos tem o mesmo botão.

## 22. Nível de API 18 — IA: objeto `AI` (DeepSeek / OpenRouter)

Conversa com um LLM (API compatível com OpenAI) a partir de um app JS. O
objeto `AI` só existe para apps com permissão `"net"` (HTTPS por baixo
dos panos).

Dois providers embutidos, escolhidos a cada chamada pelo `opts.provider`
(padrão `"deepseek"`):

- `"deepseek"` — modelo padrão `deepseek-flash`, chave em `/local/deepseek_key.txt`;
- `"openrouter"` — modelo padrão `qwen/qwen3.8-omni-flash` (multimodal: aceita
  content parts `input_audio`), chave em `/local/openrouter_key.txt`.

A chave da API é **do aparelho, nunca do JS**: o dono provisiona uma vez com
`python3 tools/push_ai_key.py deepseek|openrouter` (lê o `.env` na raiz do
repo) ou pelo gerenciador de arquivos da web, gravando
`/local/<provider>_key.txt`. O arquivo é protegido pelo jail do FS — nenhum
app consegue lê-lo — e o framework lê na hora da chamada (trocar a chave não
pede reboot).

#### `AI.configured([provider])` (API 18)
- **Parâmetros:** `provider` (String, opcional) — `"deepseek"` (padrão) ou `"openrouter"`.
- **Retorna:** Boolean
- **Descrição:** `true` quando existe chave daquele provider provisionada no aparelho. Use junto de `Net.isConnected()` antes de conversar.

#### `AI.chat(opts, cb)` (API 18)
- **Parâmetros:**
  - `opts` (Object) — o próprio payload da requisição (formato OpenAI): `messages` (obrigatório, Array de `{role, content}` com role `"system"`, `"user"` ou `"assistant"`; `content` pode ser String ou, em modelos multimodais, Array de content parts como `{type:"input_audio", input_audio:{data:"<wav em base64>", format:"wav"}}`), opcional `provider` (`"deepseek"` | `"openrouter"`, consumido pelo framework e removido do payload), opcional `model` (padrão o do provider), `max_tokens` (padrão `1024`), `temperature`, etc. O framework força `stream: false`.
  - `cb` (Function) — chamada **exatamente uma vez** com o objeto resultado quando a requisição termina.
- **Retorna:** Boolean — `true` quando o pedido entrou no ar (o callback vai disparar); `false` quando ocupado (outra requisição em curso — nenhum callback).
- **Lança:** erro legível sem WiFi, sem chave provisionada ou com provider desconhecido.
- **Descrição:** Assíncrono: o POST HTTPS roda em task própria (timeout de 60 s) enquanto o app continua desenhando. O callback recebe `{ok, status, content, usage, raw, error}`:
  - `ok` — `true` com HTTP 2xx;
  - `content` — o texto da resposta (`choices[0].message.content`), `null` quando o corpo não pôde ser parseado;
  - `usage` — `{prompt_tokens, completion_tokens, total_tokens}` quando presente;
  - `raw` — o corpo cru da resposta (teto de 32 KB; parseie você mesmo se precisar de mais);
  - `toolCalls` (API 20) — array `[{id, name, args}]` quando o modelo responde com chamada de função em vez de texto (`choices[0].message.tool_calls`); `args` é a string `function.arguments` decodificada em Object quando é JSON válido, senão a string crua;
  - `finishReason` (API 20) — `choices[0].finish_reason` quando presente (`"tool_calls"` ou `"stop"`);
  - `error` — erro de transporte ou `"cancelado"` quando `ok` é `false`; `detail` — a mensagem de erro da própria API (`error.message` do corpo da resposta, truncado em 120 caracteres) quando presente — ex.: chave inválida, saldo, rate limit.
- Erro dentro do callback propaga como o erro de qualquer binding (o app morre com a tela de erro).

### Exemplo

```javascript
if (!AI.configured("openrouter") || !Net.isConnected()) {
    System.print("configure a chave e o WiFi");
} else if (AI.chat({ provider: "openrouter",
                     messages: [{ role: "user", content: "piada curta" }] },
                   function (r) {
                       if (r.ok) System.print(r.content);
                       else System.print("erro: " + r.error);
                   })) {
    // siga bombeando: o callback dispara enquanto o app cede
    while (true) System.delay(20);
}
```

### Exemplo — por voz (áudio entra, texto sai)

```javascript
// Mic.start/stop existem nas placas com microfone (ver seção 23): o
// stop() devolve o WAV em base64 pronto para o input_audio.
if (Mic.start({ ms: 8000 })) {
    // ... UI de segurar-para-falar enquanto Mic.recording(), nível via Mic.level()
    var b64 = Mic.stop();  // null quando não capturou nada
    if (b64) {
        AI.chat({
            provider: "openrouter",
            messages: [{ role: "user", content: [
                { type: "input_audio", input_audio: { data: b64, format: "wav" } }
            ]}]
        }, function (r) { if (r.ok) System.print(r.content); });
    }
}
```

## 23. Nível de API 19 — Gravação de microfone: objeto `Mic`

Captura o áudio do microfone da placa (hoje o cão robô e o relógio, ambos
16 kHz mono 16-bit). O objeto `Mic` só existe quando **tudo** isso vale: a
placa tem microfone, o app **declarou `"mic"`** no `app.json` e o usuário
**concedeu** no diálogo de consentimento do launcher. Fora disso
`typeof Mic === "undefined"` — apps detectam e caem no teclado. A gravação
roda em task própria: o app continua desenhando enquanto o áudio é capturado.

#### `Mic.start([opts])` (API 19)
- **Parâmetros:** `opts` (Object, opcional) — `{ms: tetoDeCapturaEmMs}`, padrão `6000`, limitado a `200..10000` (10 s = 320 KB de PCM, alocados na PSRAM).
- **Retorna:** Boolean — `false` sem microfone, sem RAM ou com gravação já em curso.
- **Descrição:** Inicia a captura. No teto de `ms` o gravador para sozinho (`Mic.recording()` vira `false`; o buffer espera o `Mic.stop()`).

#### `Mic.stop([opts])` (API 19)
- **Parâmetros:** `opts` (Object, opcional) — `{raw: true}` para receber os bytes crus do WAV em vez do base64.
- **Retorna:** String — base64 do WAV (header PCM16/mono/16 kHz de 44 bytes + amostras) pronto para o `input_audio`; `null` quando não estava gravando ou faltou memória.
- **Descrição:** Encerra a captura e devolve o áudio. Uma gravação por vez. O **silêncio das pontas sai cortado** (160 ms antes da primeira voz, 240 ms depois da última, mínimo de 100 ms): a janela de gravação abre antes da fala e fecha ~0,5 s depois dela — sem o corte esse colchão viaja no base64/upload e a LLM processa mais áudio do que o necessário.

#### `Mic.recording()` (API 19)
- **Retorna:** Boolean — `true` enquanto a task de captura está rodando.

#### `Mic.level()` (API 19)
- **Retorna:** Number — nível de som 0..100 (RMS do último chunk de 32 ms; sala quieta 0-3, fala 15-40), `-1` quando não está gravando.
- **Descrição:** Para o medidor VU ao vivo. Com gravação em curso, o `System.micLevel()` devolve o mesmo nível ao vivo (compartilham o canal I2S).

## 24. Nível de API 20 — Function calling na IA

`tools` e `tool_choice` no opts do `AI.chat` sempre viajaram intactos no POST
(o objeto de opts inteiro é serializado como está). O que a API 20 acrescenta
é o **parse da resposta**: quando o modelo responde com uma chamada de
função, o callback agora recebe `r.toolCalls` e `r.finishReason` (veja a
lista de campos em `AI.chat`), então apps agem sobre comandos estruturados
sem precisar parsear `r.raw` na mão.

```js
AI.chat({
    provider: "openrouter",
    messages: [{ role: "user", content: "senta por favor" }],
    tools: [{ type: "function", function: {
        name: "dog_command",
        parameters: { type: "object", properties: {
            command: { type: "string", enum: ["sit", "lie", "stand", "walk"] }
        }, required: ["command"] }
    } }],
    tool_choice: "auto",
    max_tokens: 150
}, function (r) {
    if (r.ok && r.toolCalls && r.toolCalls.length) {
        System.print("comando: " + r.toolCalls[0].args.command);
    } else if (r.ok) {
        System.print("resposta: " + r.content);
    }
});
```

Nem todo modelo/provider habilita tool calling — faça feature-detect: sem
`toolCalls` na resposta, caia para o `r.content` (ex.: casar palavras-chave).
O `qwen/qwen3.8-omni-flash` via OpenRouter suporta tools.

## 25. Nível de API 20 — Wake word no dispositivo: objeto `WakeWord`

Detecção sempre-on da palavra de ativação **"Hi Celer"** rodando no próprio
chip (modelo microWakeWord treinado pelo CelerOS, executando em TensorFlow
Lite Micro — nada de rede). Alimenta-se do mesmo canal I2S do `Mic`; durante
uma gravação o detector descansa e volta depois. Só existe quando **todos**
vale: a placa liga a opção (hoje o cachorro robô), o app declarou `"mic"`
(mesmo consentimento do microfone — o aparelho está ouvindo) e o dono
concedeu. Senão `typeof WakeWord === "undefined"`.

#### `WakeWord.start()` (API 20)
- **Retorna:** Boolean — `true` com o modelo e a task de pé; `false` sem microfone, sem RAM para o modelo/arena ou sem modelo embutido no build.

#### `WakeWord.stop()` (API 20)
- **Descrição:** Encerra a detecção, destrói o modelo e libera a RAM (~35 KB + arena). O runtime também encerra quando o app sai.

#### `WakeWord.poll()` (API 20)
- **Retorna:** Boolean — `true` quando "Hi Celer" foi detectado desde o último poll (consome o evento; detecções entre polls colapsam numa — poll uma vez por volta do loop).

#### `WakeWord.level()` (API 20)
- **Retorna:** Number — nível de som 0..100 do último chunk lido (mesma escala do `Mic.level()`); `-1` parado.

#### `WakeWord.running()` (API 20)
- **Retorna:** Boolean — a task de detecção está viva?

Fluxo típico (Dog Face): `WakeWord.start()` no boot; ao ver `poll() ===
true`, ack em beep, `Mic.start({ms: 3500})` para capturar o comando e
enviá-lo ao `AI.chat` com `tools` — o detector cede sozinho durante a
gravação.

## 26. Nível de API 21 — Mensagens seladas no Celer Link

As mensagens comuns do Celer Link (`send`/`poll`) **não são cifradas no ar**:
o pareamento por código autentica quem conecta, mas qualquer um com um
sniffer BLE por perto lê o conteúdo. Para segredos curtos — a senha do WiFi
que o Celer Remote manda ao robô, que não tem teclado — há um canal selado:
AES-128-GCM com uma chave derivada do **bond do pareamento por código**
(confidencial e autenticado). Limite honesto: quem gravou o próprio momento
do pareamento conhece o código e, portanto, a chave; o selo protege as
transferências feitas depois.

#### `CelerLink.sendSealed(mensagem)` (API 21)
- **Parâmetros:** `mensagem` (String ou Object — objeto vira JSON), até **209 bytes** (o selo ocupa nonce + tag).
- **Retorna:** Boolean — `false` sem conexão verificada ou **sem bond com o peer** (o par precisa ter sido pareado por código; peer sem pareamento não tem chave).
- **Descrição:** Envia a mensagem cifrada e autenticada ao peer conectado. Mensagem maior que o teto lança `RangeError`.

#### `CelerLink.pollSealed()` (API 21)
- **Retorna:** String|null — a mensagem selada mais antiga **que autenticou** com o bond do peer conectado (fila própria de 2); `null` quando vazia.
- **Descrição:** O `poll()` comum nunca entrega quadros selados, e um selo que não confere é descartado pelo firmware — então o que sai daqui veio de quem pareou. Use este canal para aceitar segredos: um `{type:"wifi"}` que chegue pelo `poll()` comum deve ser ignorado.

```js
// robô: aceita a credencial só pelo canal selado
var s = CelerLink.pollSealed();
if (s) { var m = JSON.parse(s); if (m.type === "wifi") Net.wifiConnect(m.ssid, m.pass); }
// controle: CelerLink.sendSealed({type: "wifi", ssid: ssid, pass: senha});
```

## 27. Nível de API 22 — Toolkit de UI: objeto `UI` + primitivas novas

Até a API 21 cada app desenhava a própria interface com primitivas
(`fillRoundRect` + `drawString` + hit-test à mão). O objeto `UI` expõe os
**widgets nativos do sistema** (os mesmos das telas do CelerOS: fontes
FreeSans, botões com estado afundado, listas com rolagem por inércia,
diálogos) num modelo **imediato**, que encaixa no laço bloqueante de sempre:

```js
var T = System.theme();
var ligado = false, volume = 40, aba = 0;
var itens = [{label: "WiFi", right: "Casa", bars: 3}, {label: "Bluetooth", sub: "Desligado"}, "Tela", "Som"];
while (true) {
    var full = UI.begin(T.bg);                 // lê o toque 1x; true = redesenho total
    if (UI.header("Ajustes", {back: true})) System.exitApp();
    aba = UI.tabs(10, 48, 220, 30, ["Geral", "Rede", "Sobre"], aba);
    UI.card(10, 86, 220, 70);
    UI.text("Modo escuro", 22, 96);
    ligado = UI.toggle(176, 94, ligado);
    volume = UI.slider(22, 122, 196, volume);
    UI.cardEnd();
    var i = UI.list("menu", 10, 164, 220, 120, itens);
    if (i >= 0) System.toast("Abrir " + i);
    if (UI.button("Salvar", 10, 290, 220, 28)) salvar();
    UI.end();                                  // present + ritmo (~30 fps)
}
```

**Modelo de redesenho.** Os widgets **sempre** fazem o hit-test, mas só
desenham no frame total (`UI.begin` devolveu `true`) ou quando o **próprio**
estado visual mudou (pressionado, arrasto, valor, texto) — nesse caso limpam
só o próprio retângulo com o fundo corrente. Na CYD (sem quadro PSRAM) isso
evita o pisca de redesenhar a tela inteira a cada toque. Regras práticas:

- desenho **próprio** do app (primitivas) vai dentro de `if (full) { ... }`;
- um tap que dispara um widget marca o **próximo** frame como total (a ação
  quase sempre muda a tela); para outras mudanças use `UI.invalidate()`;
- `UI.text` e `UI.badge` se redesenham sozinhos quando o texto muda — um
  contador em `UI.text` não precisa de `invalidate`;
- coordenadas no espaço virtual 240x320 de sempre; cores RGB565
  (`System.theme()`); um tap vale para **um** widget por frame.

#### `UI.begin([bg])` (API 22)
- **Retorna:** Boolean — `true` quando este frame é de redesenho total (o fundo `bg`, padrão `theme().bg`, já foi pintado).
- **Descrição:** Abre o frame: leva o quadro anterior ao vidro, lê o toque uma vez (tap/arrasto/pressão para todos os widgets do frame) e trata a topbar (X de sair) como `getTouch`.

#### `UI.end([fps])` (API 22)
- **Descrição:** Fecha o frame: present + espera até completar `1000/fps` ms desde o último `end` (padrão 30, teto 60). Substitui o `System.delay` do laço.

#### `UI.invalidate()` (API 22)
- **Descrição:** Marca o próximo frame como total (troca de tela, dados novos).

#### `UI.toast(msg, [ms])` (API 22)
- **Descrição:** Aviso curto (pílula na base da tela, padrão 1800 ms) **dentro do app**, desenhado pelo `UI.end` — o `System.toast` só aparece quando o app sai. Ao vencer, o próximo frame é total.

#### `UI.touch()` (API 22)
- **Retorna:** Object `{down, x, y, tap, released, moved, sx, sy}` — o toque do frame corrente, como os widgets o viram (`tap` já é `false` se um widget consumiu o tap; `sx/sy` = ponto do pouso). Para widgets próprios, "salvar ao soltar" (`released`) e swipe (`released && moved`: direção = `x - sx`, `y - sy`).

#### `UI.text(s, x, y, [opts])` (API 22)
- **Parâmetros:** `opts`: `role` (`"caption"` | `"body"` (padrão) | `"title"` | `"display"`), `color`, `align` (`"left"` | `"center"` | `"right"`; `x` é a âncora), `w` (largura máxima: corta com `..`), `lines` (com `w`: quebra por palavra em até N linhas, máx. 64), `bg` (fundo para limpar quando o texto muda), `id` (dois textos na mesma posição).
- **Retorna:** Number — altura usada (virtual).
- **Descrição:** Texto com as fontes de papel do sistema (FreeSans/DejaVu escolhidas pela densidade da tela). Redesenha sozinho quando o conteúdo muda.

#### `UI.measure(s, [role])` (API 22)
- **Retorna:** Number — largura virtual de `s` na fonte do papel.

#### `UI.lineHeight([role])` (API 22)
- **Retorna:** Number — altura virtual da linha do papel.

#### `UI.measureWrap(s, w, [role])` (API 22)
- **Retorna:** Number — altura virtual de `s` quebrado por palavra na largura `w` (até 64 linhas), sem desenhar. Para dimensionar balões/cards antes do `UI.text`.

#### `UI.header(title, [opts])` (API 22)
- **Parâmetros:** `opts`: `sub` (legenda à direita), `back` (seta de voltar).
- **Retorna:** Boolean — `true` no tap da seta.
- **Descrição:** Cabeçalho do app (faixa de 40 px no topo do canvas, abaixo da topbar do sistema) no visual das telas nativas.

#### `UI.button(label, x, y, w, h, [opts])` (API 22)
- **Parâmetros:** `opts`: `style` (`"primary"` (padrão) | `"ghost"` | `"danger"`), `disabled`, `id`; cor própria com `color` (fundo) + `textColor` e `role` do rótulo (teclados de calculadora, jogos).
- **Retorna:** Boolean — `true` no frame do tap (soltar dentro do botão em que pousou, sem arrastar).

#### `UI.toggle(x, y, on, [opts])` (API 22)
- **Retorna:** Boolean — o novo estado (44x24 virtual; o alvo de toque tem folga de 6 px). Getters do sistema podem devolver `0/1`: compare com `!!valor` (`if (UI.toggle(x, y, !!v) !== !!v) ...`).

#### `UI.slider(x, y, w, value, [opts])` (API 22)
- **Parâmetros:** `opts`: `min` (0), `max` (100), `step` (1).
- **Retorna:** Number — o valor (atualiza ao vivo durante o arrasto; 28 px de altura).

#### `UI.progress(x, y, w, h, pct)` (API 22)
- **Descrição:** Barra de progresso 0..100.

#### `UI.spinner(cx, cy, r, [color])` (API 22)
- **Descrição:** Arco girando (redesenha a cada frame) — espera de rede/IA.

#### `UI.list(id, x, y, w, h, items, [opts])` (API 22)
- **Parâmetros:** `items`: Strings ou `{label, sub, right, rightColor, bars, enabled}` (`sub` = segunda linha; `right` = texto à direita, na cor `rightColor`; `bars` 0..4 = sinal). `opts`: `rowH` (padrão 36, ou 48 com `sub`), `selected` (índice destacado; a lista abre rolada até ele).
- **Retorna:** Number — índice tocado neste frame, ou `-1`.
- **Descrição:** Lista rolável com arrasto + inércia nativos (estado de rolagem guardado pelo `id`).

#### `UI.tabs(x, y, w, h, labels, sel)` (API 22)
- **Retorna:** Number — a aba ativa (controle segmentado).

#### `UI.card(x, y, w, h, [opts])` (API 22)
- **Parâmetros:** `opts`: `color` (`theme().card`), `radius` (10), `stroke`.
- **Descrição:** Superfície arredondada; os widgets seguintes usam a cor do card como fundo até `UI.cardEnd()`.

#### `UI.cardEnd()` (API 22)
- **Descrição:** Fecha o card (volta ao fundo anterior).

#### `UI.scrollBegin(id, x, y, w, h, contentH)` (API 22)
- **Retorna:** Number — deslocamento vertical; desenhe o conteúdo em `y - off`.
- **Descrição:** Área rolável genérica (recorte + arrasto + inércia). Rolar marca o próximo frame como total, então o conteúdo vai dentro do `if (full)`. Toque fora da área não vale para os widgets de dentro.

#### `UI.scrollEnd()` (API 22)
- **Descrição:** Fecha a área (restaura o recorte e desenha a barra de rolagem).

#### `UI.scrollTo(id, y)` (API 22)
- **Descrição:** Posiciona a lista/área `id` no deslocamento `y` (um valor grande vai ao fim — o próximo `UI.list`/`UI.scrollBegin` limita ao conteúdo) e para a inércia. Chat/log que "segue o fim".

#### `UI.resetScroll(id)` (API 22)
- **Descrição:** Volta ao topo a lista/área `id` (troca de tela).

#### `UI.badge(text, x, y, [opts])` (API 22)
- **Parâmetros:** `opts`: `color`, `textColor`.
- **Retorna:** Number — largura virtual da pílula.

#### `UI.confirm(title, [body], [opts])` (API 22)
- **Parâmetros:** `opts`: `yes` ("OK"), `no` ("Cancelar"), `danger` (botão de confirmar vermelho).
- **Retorna:** Boolean — `true` = confirmou.
- **Descrição:** Diálogo modal **bloqueante** (como `System.prompt`) sobre a tela escurecida. Ao voltar, o próximo `UI.begin` é total.

#### `UI.alert(title, [body], [ok])` (API 22)
- **Descrição:** Aviso modal bloqueante com um botão.

### 27.1 Primitivas novas em `System`

#### `System.fillGradient(x, y, w, h, top, bottom, [radius])` (API 22)
- **Descrição:** Retângulo (arredondado com `radius`) com gradiente vertical `top` → `bottom`.

#### `System.fillArc(x, y, r0, r1, a0, a1, color)` (API 22)
- **Descrição:** Arco cheio entre os raios `r0`..`r1`, ângulos em graus (0 = 3h, sentido horário) — anéis de progresso, medidores.

#### `System.fillSmoothCircle(x, y, radius, color)` (API 22)
- **Descrição:** Círculo com borda suavizada (anti-aliasing).

#### `System.fillSmoothRoundRect(x, y, w, h, radius, color)` (API 22)
- **Descrição:** Retângulo arredondado com cantos suavizados.

#### `System.drawWideLine(x0, y0, x1, y1, width, color)` (API 22)
- **Descrição:** Linha grossa com anti-aliasing (ponteiros de relógio, gráficos).

#### `System.mixColor(a, b, pct)` (API 22)
- **Retorna:** Number — mistura RGB565 (`pct` 0 = `a`, 100 = `b`): estados pressionados, sombras, gradientes manuais.

## 28. Nível de API 23 — Módulos JS: `require`

App pode ser separado em vários `.js` chatos na pasta do app (o hub publica
todos; ver o App_Development_Guide). `require` carrega o módulo UMA vez por
execução, executa embrulhado como `function(module, exports, require)` e
devolve `module.exports`. Módulos podem requerer módulos (mesma pasta);
ciclos recebem `exports` parcial (padrão CommonJS). Sem permissão: é código
do próprio app.

#### `require(nome)` (API 23)
- **Parâmetros:** `nome` do módulo `[A-Za-z0-9_.-]` (sufixo `.js` opcional, sem caminho) — resolve para `<pasta do app>/nome.js`; desde a API 30, se o arquivo não existir na pasta e o `deps.json` do app referenciar o nome, cai para o cache de dependências em `/local/modules` (seção 35).
- **Retorna:** o `module.exports` do módulo (`{}` se o módulo não exportar nada).
- **Erros:** módulo não encontrado, nome inválido, erro de sintaxe/eval (propaga como exceção — capturável com `try/catch`), profundidade máxima de aninhamento (8).

```js
// main.js
var notas = require("notas");        // carrega notas.js
notas.tocar("alerta");

// notas.js
var audio = require("audio");        // módulos requerem módulos
exports.tocar = function (n) { audio.beep(n); };

// audio.js
module.exports = {                   // trocar module.exports inteiro também vale
    beep: function (n) { System.playTone([[880, 80]]); }
};
```

- O `line N` dos erros do Duktape bate com a linha N do arquivo do módulo.
- O cache vale por execução do app (reabrir recarrega do disco).
- `.js` avulso rodado pelo shell não tem pasta de app: `require` devolve erro.

## 29. Nível de API 24 — Fala: `AI.speak` (texto para voz)

Texto vira voz no alto-falante da placa. O `AI.speak` envia o texto ao
endpoint `/audio/speech` do OpenRouter (modelo padrão
`google/gemini-3.8-flash-lite-tts`, 30 vozes naturais — fala português sem
configuração) e toca o áudio **ao vivo** enquanto baixa: **nada passa pela
RAM**, o download e o playback rodam em task própria e o app segue livre
(animando a boca do robô, por exemplo). O mesmo slot serial do `AI.chat`:
enquanto uma fala está em curso, `AI.chat`/`AI.speak` devolvem `false`.

Funciona em qualquer placa com alto-falante I2S (cão, SmartDisplay, watch).
Exige a chave do OpenRouter (`AI.configured("openrouter")`) e WiFi. A fala
ao vivo não toca o armazenamento; um `.wav` salvo (`save:true` ou
`play:false`) ocupa LittleFS a ~48 KB por segundo de fala (24 kHz): 300
chars de texto ≈ 20 s ≈ 960 KB — por isso o teto de 300 chars no `text`.

#### `AI.speak(opts, cb)` (API 24)
- **Parâmetros:**
  - `opts` (Object) — `text` (String, obrigatório, 1..300 chars; o estilo pode vir no próprio texto, ex. `"Diga animado: chegou comida!"`), `voice` (String, opcional; padrão `"Charon"` — voz grave que combina com o cão; Puck, Kore, Fenrir, Aoede... são outras), `model` (String, opcional; padrão `google/gemini-3.8-flash-lite-tts`), `path` (String, opcional; destino do `.wav` quando ele é salvo — padrão `tts.wav` na pasta privada do app, `FS.appData()`), `play` (Boolean, opcional, padrão `true` — `false` só baixa o arquivo para tocar depois com `System.playWav(path)`), `save` (Boolean, opcional, padrão `false` — `true` também guarda o `.wav` em `path` enquanto toca ao vivo).
  - `cb` (Function) — chamada **exatamente uma vez** ao final (depois do playback, quando ele roda).
- **Retorna:** Boolean — `true` quando o pedido entrou no ar (o callback vai disparar); `false` quando ocupado (nenhum callback).
- **Lança:** erro legível sem WiFi, sem chave, sem `text`, texto acima de 300 chars ou caminho negado pelo jail do FS.
- **Descrição:** o download toca **ao vivo** (o som sai no primeiro byte da resposta, não no fim do arquivo; corpo de erro nunca toca no alto-falante). O callback recebe `{ok, status, path, bytes, played, error?, detail?}`:
  - `ok` — `true` quando o áudio foi baixado (e, quando salvo, selado em `path`);
  - `path` — onde o `.wav` ficou quando salvo (`save:true`/`play:false`; serve para `System.playWav` e para o cache do app: a mesma frase pode tocar offline depois), `""` quando só tocou ao vivo;
  - `bytes` — PCM baixado (~48 KB por segundo de fala);
  - `played` — `true` quando tocou até o fim; `false` com `ok` true significa `play:false` ou corte pelo `AI.cancel()` (alto-falante ocupado no primeiro byte cai no playback do arquivo terminado);
  - `error`/`detail` — erro de transporte e a mensagem da própria API (voz inválida, saldo...).
- `AI.cancel()` corta a fala no meio (o som para no próximo chunk).

#### `AI.warm([provider])` (API 24)
- **Parâmetros:** `provider` (String, opcional; `"deepseek"` padrão ou `"openrouter"`).
- **Retorna:** Boolean — `true` quando o aquecimento entrou na fila; `false` quando não há o que fazer (sem WiFi, sem chave, provider desconhecido, placa sem PSRAM ou pedido já no ar). Nunca lança, sem callback.
- **Descrição:** abre a conexão TLS com o provider **agora**, para o próximo `AI.chat`/`AI.speak` pular DNS + TCP + handshake (~2 s no S3). Não ocupa o slot serial: um `AI.chat` logo em seguida é aceito e roda assim que o aquecimento termina. Uso típico: o app de voz chama no wake word, enquanto o dono ainda fala.

```javascript
if (WakeWord.poll()) {
    AI.warm("openrouter");   // a conexao abre enquanto o dono fala
    Mic.start({ ms: 3500 });
}
```

### Exemplo — o cão responde

```javascript
if (AI.configured("openrouter") && Net.isConnected()) {
    AI.speak({ text: "Oi! Tudo bem com voce?" }, function (r) {
        if (!r.ok) System.print("erro: " + r.error);
    });
    while (true) System.delay(20);  // callback dispara no yield
}
```

### Exemplo — baixar sem tocar (cache de frases fixas)

```javascript
// baixa uma vez no WiFi, toca offline quando quiser
AI.speak({ text: "bateria fraca, bora carregar", path: FS.appData() + "aviso.wav", play: false },
         function (r) { if (r.ok) System.playWav(r.path); });
```

## 30. Nível de API 25 — Música: `System.playMusic` (mixer chiptune)

Poucos canais de música, misturados ao vivo no alto-falante da placa. O
app (ou a LLM por trás dele) orquestra um pequeno "MIDI" — até **4 trilhas**
de eventos de nota `[midi, semicolcheias]` — e uma task de síntese mistura
tudo como chiptune: ondas quadrada 50%/25%, triangular e dente-de-serra
para melodias/baixo, e uma trilha de percussão usando as **notas de bateria
do General MIDI** (36 bumbo, 38 caixa, 42 chimbal). A reprodução é **não
bloqueante**: o app segue livre para piscar LEDs e mover servos no ritmo
enquanto toca.

Funciona em qualquer placa com alto-falante I2S (cão, SmartDisplay, watch).
Compartilha a posse exclusiva do alto-falante com `playWav`/`playTone`/
`AI.speak`: `playMusic` devolve `false` com o alto-falante ocupado. Tudo é
clampado (aqui e de novo no motor — o app nunca é confiável): bpm 60..200,
loops 1..8 com teto total de 120 s, 4 trilhas x 48 notas, midi 0..96
(0 = pausa), duração 1..64 semicolcheias, volume 0..100.

#### `System.playMusic(song, [opcoes])` (API 25; `opcoes` na 27)
`opcoes.startMs` (API 27) começa a reprodução do meio da música (ms
desde o início) — é assim que o handoff da matilha retoma no vizinho
exatamente de onde a música parou.
- **Parâmetros:** `song` (Object) — `{bpm: 60..200 (default 120), loops: 1..8 (default 4), tracks: [...]}`; cada trilha `{wave: "sq"|"sq25"|"tri"|"saw" (default "sq"), drum: Boolean (notas viram percussão GM), vol: 0..100 (default 80), notes: [[midi, semicolcheias], ...]}` — midi 0 é uma pausa que ainda avança o tempo, então as trilhas se alinham pela soma das durações.
- **Retorna:** Boolean — `true` quando a música começou; `false` com o alto-falante ocupado, placa sem áudio I2S ou música sem notas.
- **Descrição:** uma música por vez; um novo `playMusic` só entra quando a anterior acaba (ou é cortada). Enquanto toca, o detector de wake word on-device dorme (como qualquer reprodução).

#### `System.musicStop()` (API 25)
Corta a música no próximo bloco do mixer (~15 ms). Retorna `true` quando
havia algo tocando. Idempotente.

#### `System.musicPlaying()` (API 25)
`true` enquanto a task de síntese toca (até acabarem os loops ou chegar um
`musicStop`).

#### `System.musicPos()` (API 25)
Milissegundos de áudio já escritos no alto-falante desde o início — para
luzes/coreografia sincronizadas na batida — ou `-1` parado.

### Exemplo — festa: batida orquestrada pela IA + LEDs piscando

```javascript
var song = {
    bpm: 128, loops: 4,
    tracks: [
        { drum: true, vol: 100,
          notes: [[36,2],[42,1],[42,1],[38,2],[42,1],[42,1]] },   // bumbo/chimbal/caixa
        { wave: "tri", vol: 90,
          notes: [[40,4],[40,2],[47,2],[45,4],[43,4]] },          // linha de baixo
        { wave: "sq", vol: 70,
          notes: [[64,2],[67,2],[72,4],[0,4],[71,2],[67,2]] }     // tema curto (0 = pausa)
    ]
};
if (System.playMusic(song)) {
    var beatMs = 60000 / song.bpm;
    while (System.musicPos() >= 0) {          // dança enquanto toca
        var step = Math.floor(System.musicPos() / (beatMs / 2));
        System.neopixel(0, [step % 2 ? 0xFF2000 : 0x20C020, 0, 0, 0]);
        System.delay(30);
    }
    System.neopixel(0, [0, 0, 0, 0]);
}
```

## 31. Nível de API 26 — CelerNet: malha BLE entre CelerOS

Malha de dispositivos pela área: cada CelerOS com Bluetooth anuncia
pacotes de advertising **não-conectáveis** e escuta o ar; quem ouve um
pacote novo **repete** (com um salto a menos no orçamento de TTL) — a
mensagem atravessa a área de dispositivo em dispositivo, sem nenhuma
conexão GATT. Espalhe três placas pela casa: a mensagem enviada em uma
chega na outra ponta com `hops: 2`, tendo sido repetida pela do meio.

O `CelerLink` (seção 15) segue sendo o canal par-a-par de alta vazão
(240 bytes por pacote, pareamento, selos). A malha é para **cobertura**:
telemetria, presença, comandos curtos e avisos — mensagens de até **434
bytes**, em fragmentos de ~14 bytes por salto de rádio (a vazão da
malha é de uns poucos pacotes por segundo por nó; não é para streaming).

**Disponibilidade:** só em placas compiladas com Bluetooth
(`CONFIG_CELEROS_BLUETOOTH`). Detecte com
`typeof CelerNet !== "undefined"`.

**A malha é infraestrutura, não sessão de app:** ligada, sobrevive à
troca de app e ao reboot (o estado fica no setting `celernet`; default
desligado). No relógio (bateria) avalie o custo: o rádio fica escutando.

**Segurança (v3, API 37):** todo pacote é cifrado e autenticado
(AES-CCM) com a **chave da rede**, e cada pacote leva um número de
sequência que nunca se repete: o nó descarta o que não autentica (outra
rede, pacote forjado — nem entrega, nem repete) e o que já viu (captura
reenviada). A rede não é mais escolha do app:

- a **matilha** (rede privada) é nome + senha definidos no aparelho —
  `mesh join <nome> <senha>` no shell (o assistente de provisionamento
  no app Matilha vem a seguir). A chave sai dos dois (PBKDF2-SHA256):
  um segundo aparelho que digita o mesmo nome e senha entra na mesma
  matilha, e o mesmo nome com outra senha é outra rede;
- aparelho sem matilha fica na **rede aberta "celer"**: a chave dela é
  pública (integridade, sem sigilo) e serve para aparelhos ainda não
  configurados. Nela, `mic` e `camera` recusam toda sessão remota com
  `denied` (veja `Pack`); `speaker` e canais de dados seguem valendo.

Nós com firmware CelerNet v2 e nós v3 não se ouvem mais: atualize todos
os aparelhos juntos.

#### `CelerNet.start([opcoes])` → Boolean (API 26)
Liga o nó da malha. `opcoes`: `{name: "Celer-Dog"` (nome anunciado, até
14 caracteres desde a API 37; default `Celer-XXXX` do fim da MAC) e
`relay: true`
(repete pacotes de outros; `false` = só escuta e anuncia presença, para
economia). Persiste o estado: o nó volta sozinho no próximo boot.
A primeira chamada pode subir o Bluetooth (~300 ms). Com a RAM interna
apertada (BLE ainda fora do ar e um app aberto) o pedido é **aceito
mesmo assim** — o nó sobe sozinho em segundos, quando a RAM permitir
(`status().active` confirma); `false` só sem memória para as filas.
A opção `net` (API 26–36) é **ignorada** desde a API 37: a rede é a
matilha do aparelho.

#### `CelerNet.stop()` → Boolean (API 26)
Desliga o nó (e persiste o desligado).

#### `CelerNet.broadcast(mensagem, [ttl])` → Boolean (API 26)
Manda a mensagem para **toda** a rede. Mesma regra de payload do
`CelerLink.send`: string crua ou objeto serializado como JSON, 1–434
bytes (fora disso lança `RangeError`). `ttl` (1–8, default 4) é o
alcance em saltos. Retorna `false` com a malha desligada ou a fila cheia
— a saída é assíncrona (o rádio transmite nos próximos ~ms).

#### `CelerNet.send(destino, mensagem, [opcoes])` → Boolean (API 27)
**Unicast**: só o destino entrega a mensagem (o flood segue carregando
pela área — os repetidores não a abrem para os outros). `destino` é o
id do nó (`"9F2A"`) **ou o nome** (`"Celer-Dog"`, primeiro
case-insensitive; a presença vem ordenada por sinal, nomes duplicados
resolvem para o mais forte). Destino fora da tabela de presença devolve
`false` — presença vai e vem por natureza; o app decide.
`opcoes`: `{ttl: 4, urgent: false, copies: 2}` — `urgent` furam a fila
da presença, e `copies` (1–3) reenvia a mensagem ~1,5 s depois
(redundância no lugar de ACK). Mensagem de **um quadro** (até 16 B):
cada cópia é independente e **a entrega pode duplicar** — dedulique por
um `id` no seu payload (os envelopes do OS já fazem). Mensagem
**fragmentada** (> 16 B): as cópias dividem a identidade e o destino junta
fragmentos de qualquer uma — entrega uma vez só, e o fragmento perdido
numa cópia vem da outra.

**Desenhando um protocolo de malha (o que o firmware faz por baixo):**

- **16 bytes cabem num pacote de rádio.** Acima disso a mensagem vai em
  fragmentos de 14 bytes (100 B = 8 pacotes) e se perde se *qualquer*
  fragmento se perder em qualquer salto. Os apps do hub Sonar, Batata
  Quente, Sentinela e Coral cabem cada mensagem num pacote: prefixo de 1
  letra do app + 1 letra de operação + campos curtos (`"bp123.4.150"`).
- **Nunca comece mensagem crua com `P`** quando ela tem 4+ bytes: é o
  magic dos envelopes do OS (`Pack`) e o serviço Pack a engole —
  `"Ping 1"` nunca chega ao `CelerNet.poll()` do outro lado (`"ping 1"`
  chega). Use prefixo minúsculo.
- **A fila de TX tem 96 pacotes** (as suas mensagens + o que o nó
  repete) e cada pacote segura o rádio por ~185 ms (~5 pacotes/s). Um
  `send` de 434 B com as 2 cópias padrão ocupa 62 pacotes — uns 11 s de
  ar; a mensagem só entra na fila inteira (todas as cópias) ou nada
  (`false`). Mensagem grande, só de vez em quando.
- **Não há ACK no rádio.** Se precisa de confirmação, faça a resposta
  ser o ACK (o `s?`/`s!` do Sonar, o `bp`/`bk` com reenvio da Batata
  Quente) e deduplique as retentativas por um número de sequência.
- **Só o app aberto recebe.** O `CelerNet.poll()` é do app em primeiro
  plano (repetir é trabalho do OS e não precisa de app): protocolos entre
  apps funcionam com o app aberto nas duas pontas.

#### `CelerNet.poll()` → Object|null (API 26)
Mensagem que chegou (FIFO de 8; cheia descarta a mais antiga):
`{from: "9F2A", fromName: "Celer-Dog", msg: "...", unicast: false,
hops: 2, rssi: -71}` — `from`/`fromName` são a **origem** (não o
repetidor), `hops` quantos saltos a mensagem deu, `rssi` o sinal do
último salto ouvido. `msg` é string (decodifique JSON se o remetente
mandou objeto) e `unicast` (API 27) diz se a mensagem era endereçada a
este nó. `null` quando vazia. Drene no laço do app até voltar `null`.

#### `CelerNet.nodes()` → Array (API 26; `caps` na 27)
Presença: nós da rede ouvidos nos últimos 15 s, sinal mais forte
primeiro: `[{id: "9F2A", name: "Celer-Dog", caps: 9, rssi: -71,
hops: 1, lastSeen: 2}]` (`lastSeen` em segundos; `hops` conta saltos
dados — vizinho direto = 1; até o firmware 1.7.0 vinha 0 — e, com o
caminho direto fresco, um anúncio repetido por outro nó não o troca).
Cada nó anuncia
presença a cada ~3 s; desde a API 27 o anúncio leva o **papel** do nó
(`caps`, um bitmask — `Pack.members()` devolve decodificado).

#### `CelerNet.status()` → Object (API 26)
`{active, relay, node, name, net, secure, provisioned, txQueued,
txDropped, rxDropped, relayed, heard, rxAuthFail, rxReplay}` — `node` é
o nosso id (fim da MAC), `net` o nome da rede (a matilha, ou `"celer"`),
`secure`/`provisioned` (API 37) se é uma matilha privada, `relay` se
estamos repetindo, `relayed` quantos pacotes de outros repetimos desde
o `start()`, `heard` quantos nós estão na tabela de presença,
`rxAuthFail` pacotes ouvidos que não autenticaram (outra rede por perto)
e `rxReplay` pacotes já vistos (duplicatas de relay, replays).

### Exemplo — mensagem atravessando a área

```javascript
// em QUALQUER um dos nós (o do meio repete sozinho)
if (typeof CelerNet !== "undefined" && !CelerNet.status().active) {
    CelerNet.start({name: "Celer-Cozinha"});
}
CelerNet.broadcast({type: "aviso", texto: "cafe pronto"}, 4);

// no loop de todos os nos:
var m;
while ((m = CelerNet.poll()) !== null) {
    var aviso = JSON.parse(m.msg);
    System.drawString(m.fromName + " (" + m.hops + " saltos): " +
                      aviso.texto, 10, 10);
}
var vizinhos = CelerNet.nodes();
System.drawString(vizinhos.length + " nos ouvindo", 10, 30);
```


## 32. Nível de API 27 — A matilha (`Pack`): papéis, envelopes, música itinerante

A **matilha** é a malha com significado: o mesmo rádio do CelerNet, lido
pelo OS. Cada membro anuncia no beat de presença o seu **papel** — o que
ele tem a oferecer: `speaker` (alto-falante), `mic`, `display` (tela),
`motors` (patas), `leds`, `hub` (rede alcançável) — derivado da própria
placa, sem configuração. E o OS fala seus próprios envelopes tipados
pela malha (unicast, deduplicados por id de mensagem) — é por ali que
viaja a primeira feature da matilha: **a festa itinerante** — o
chiptune tocando no cachorro muda para o SmartDisplay (ou o relógio),
retomando do mesmo milissegundo.

O `Pack` existe onde o `CelerNet` existe (`CONFIG_CELEROS_BLUETOOTH`;
detecte com `typeof Pack !== "undefined"`). É infraestrutura: o serviço
roda com ou sem app aberto.

#### `Pack.me()` → Object
Quem somos na matilha: `{id: "9F2A", name: "Celer-Dog",
caps: {speaker: true, mic: true, display: false, motors: true,
leds: true, hub: false}, meshActive: true, net: "casa",
provisioned: true}` — `caps` decodificado do bitmask que o firmware deriva
da placa (`hub` segue o estado da rede ao vivo). `net` e `provisioned` são
da API 40 (seção 43).

#### `Pack.members()` → Array
A matilha ouvida nos últimos 15 s, mais forte primeiro — mesmo formato
do `me()` mais `{rssi, hops, lastSeen}` por membro:
`[{id, name, caps, rssi: -58, hops: 1, lastSeen: 2}]`.

#### `Pack.send(destino, mensagem, [opcoes])` → Boolean
**Envelope custom** para um membro (unicast, deduplicado pelo firmware
— as duplicatas das cópias redundantes nunca chegam a você). `destino`
é id ou nome (mesmas regras do `CelerNet.send` — destino sumido devolve
`false`); `mensagem` é string ou objeto-como-JSON, 1–430 bytes
(`RangeError` fora disso).
`opcoes.urgent` fura a fila da presença. Quem recebe drena com
`Pack.poll()`. Desde a API 41 todo envelope também viaja numa cópia
ESP-NOW quando o plano de dados está de pé (só a malha perde muitos
quadros quando o WiFi divide o rádio); as duplicatas caem pelo id da
mensagem, então quem recebe vê uma vez só.

#### `Pack.poll()` → Object|null
Envelope custom que chegou: `{from: "9F2A", fromName: "Celer-Dog",
data: "..."}` — `data` é string (decode o JSON que você mandou). `null`
quando vazio. Mensagens de `CelerNet.broadcast` puro continuam chegando
pelo `CelerNet.poll()` como sempre — os dois canais não se misturam.

#### `Pack.handoffMusic([destino])` → Boolean
**Passa a festa adiante**: serializa a sessão do `System.playMusic` em
curso (música + posição) numa única mensagem da malha e o membro com
alto-falante retoma do mesmo ponto. `destino` omitido = o mais forte
com `caps.speaker`. `false` se nada está tocando aqui, a malha está
desligada ou não há receptor por perto. No sucesso a música local para
(e se o alto-falante do receptor estiver ocupado o envelope é largado —
a música fica onde estava).

### Exemplo — a festa itinerante

```javascript
// a festa no cachorro (Dog Face ou qualquer app):
System.playMusic({bpm: 128, loops: 4, tracks: [
    {wave: "sq",  vol: 80, notes: [[64,2],[67,2],[71,2],[74,2]]},
    {drum: true,  vol: 90, notes: [[36,4],[42,2],[42,2]]}
]});
// ...se afastando do cachorro:
Pack.handoffMusic();            // continua no SmartDisplay

// qualquer membro, vigiando envelopes:
var e;
while ((e = Pack.poll()) !== null) {
    System.notify(e.fromName, e.data);
}
```

## 33. Nível de API 28 — Canvas nativo: os pixels do vidro

Todo app JS desenha num canvas virtual 240x320 que o firmware escala para
o display físico — uma base de código, qualquer placa. O **canvas
nativo** é a saída para apps que querem os pixels de verdade: um jogo em
tela cheia no SmartDisplay 4" (480x480) desenha 1:1, sem a esticada de
proporção 2.0/1.5, com toque na precisão física.

#### `System.pushSprite(x, y[, transparente])` (3º argumento na API 28)
Com a cor opcional `transparente` (RGB565), os pixels do sprite com essa
cor **não** são transferidos — blit com croma-chave: um sprite com fundo
sólido (ex.: preto) compõe sobre a cena sem o quadrado em volta. Deixe os
escuros internos longe da cor-chave (mestre o asset para um quase-preto
que difere no bit menos significativo). Sem o argumento o blit é opaco,
como sempre.

#### `System.setNativeCanvas(enable)` → Booleano (API 28)
`true` passa **todas** as chamadas de desenho/sprite/toque seguintes para
pixels físicos: as coordenadas são usadas como chegam
(`System.screenWidth()`/`screenHeight()` passam a informar o vidro —
480/480 no SmartDisplay), `createSprite` cria no tamanho físico,
`drawPNG`/`drawBMP` mantêm o tamanho nativo (sem escala do canvas
virtual) e `System.getTouch()` devolve coordenadas físicas. Retorna
`true` quando aplicado; `false` (e nada muda) quando o app roda com a
**topbar fixa** — o modo exige app em tela cheia (`"topbar": false` no
`app.json`), que passa a cuidar do próprio gesto de saída
(`System.exitApp()`).

`false` volta ao canvas virtual 240x320 — a troca vale por chamada de
desenho, então um app pode manter os menus no `UI.*` virtual (o toolkit
sempre raciocina em coordenadas virtuais; não misture widgets `UI.*`
com o modo nativo no mesmo quadro) e só entrar no nativo para jogar.
Alternar marca o quadro para repintura total: redesenhe a tela inteira
logo depois de trocar. O modo é zerado na saída do app.

### Exemplo — jogo em tela cheia no vidro quadrado

```javascript
// app.json: "topbar": false
if (System.setNativeCanvas(true)) {
    var W = System.screenWidth(), H = System.screenHeight();  // 480, 480
    System.fillRect(0, 0, W, H, 0x0000);
    var t;
    while (true) {
        t = System.getTouch();
        if (t.touched) System.fillCircle(t.x, t.y, 24, 0x07FF);  // px físico
        System.delay(10);
    }
}
```

## 34. Nível de API 29 — Pool de sprites 8 + `System.spriteSlots()`

O pool de sprites múltiplos (seção 16.3) dobrou: **8 slots em PSRAM**
(continua 1 sem PSRAM). A alocação segue sob demanda — um slot só consome
memória quando o app cria o sprite —, então o pool maior não custa nada
para quem não usa.

#### `System.spriteSlots()` → Inteiro (API 29)
Devolve o limite **real** do pool na placa (8 com PSRAM, 1 sem). Engines
e jogos orçamentam os slots em vez de chumbar o máximo histórico:

```js
var cap = System.spriteSlots ? System.spriteSlots() : 4;  // degrada no velho
if (System.createSprite(32, 32) === 0) { /* pool cheio: pinta procedural */ }
```

O comportamento de compatibilidade do `createSprite` com pool cheio (reciclar
o sprite corrente) segue valendo — com 8 slots o caso ficou raro; conte os
ids vivos e respeite o `spriteSlots()` antes de pedir mais.

## 35. Nível de API 30 — Dependências compartilhadas: `deps` no app.json

A game engine e a física do SDK (53 KB somados) deixaram de ser copiadas
para dentro de cada jogo: o app **declara** as dependências no `app.json` e
a loja as instala num cache público em `/local/modules/<nome>/<versão>/` —
uma única cópia por versão no dispositivo, compartilhada pelos apps. O
`require()` resolve o fallback.

#### O campo de dependências `"deps"` (API 30)

```json
"deps": { "celeros.engine": "^1.0.0", "celeros.physics": "^1.0.0" }
```

- **Nome** = identidade do módulo em todo lugar: `require("celeros.engine")`,
  arquivo `celeros.engine.js`, pasta `/local/modules/celeros.engine/`. O
  validador do `require` aceita `.` a partir desta API (formato
  `prefixo.nome`, minúsculas).
- **Versão** = range `^X.Y.Z` (mesma major, ≥ base) ou exata `"1.0.0"`. A
  resolução acontece **no install**: a loja escolhe a maior versão do índice
  do hub (`/store/deps.json`) que satisfaz o range e grava a escolha em
  `<pasta do app>/deps.json` (a fonte do `require` em runtime). Um update do
  app re-resolve os ranges. A gramática é o modelo do `pub` do Dart: a
  **major é a linha do breaking** — `^1.1.0` roda em qualquer 1.x ≥ 1.1.0
  (minor/patch chegam no próximo install ou no `celerctl apps deps
  --upgrade`) e nunca pula para 2.0; **majors coexistem** no cache, cada app
  pinado pelo próprio `deps.json` (o lock por app; o GC do launcher preserva
  toda versão que algum app pinna).
- O `deps.json` guarda o **fecho transitivo** (as deps das deps vêm
  junto). O runtime lê até **32** módulos por app a partir da API 44; até a
  API 43 lia só 8 e o resto do fecho falhava no `require`. App cujo fecho
  passa de 8 módulos declara `"api": 44`.
- O hub valida no publish: as deps existem no repositório, a soma dos `.js`
  do pacote **+ deps resolvidas** conta no teto de 48/128 KB (a dep segue
  compilando no heap de cada app) e `api` do app ≥ `minApi` da dep.
- **O provisionamento é automático em todo caminho**: `celerctl apps
  install`/`apps store`, a loja, `celerctl dev` (abertura + mudança de
  `app.json`) e `celerctl push PASTA /local/apps` resolvem contra o hub,
  baixam os módulos para `/local/modules` e gravam o `deps.json` antes de o
  app rodar. `celerctl apps deps --upgrade` refresca os pinos de todos os
  apps instalados (a maior satisfazendo — nunca cruza major).

#### Resolução do `require` (precedência)

1. `<pasta do app>/<nome>.js` — arquivo local vence (vendoring continua
   funcionando; útil para testar uma cópia modificada);
2. `/local/modules/<nome>/<versão do deps.json>/<nome>.js` — cache do hub
   instalado pela loja;
3. erro claro: "dependência ausente — reinstale o app pela loja".

O launcher coleta o lixo do cache: versões sem nenhum app referenciando no
`deps.json` saem do disco no scan (boot, install, uninstall). Escrever em
`/local/modules` exige a permissão `system` (a leitura é livre) — um app
comum não troca o código que os outros carregam.

O scaffold `celer.js new --game` gera o `app.json` já com as deps da engine;
no emulador/harness o `require` resolve as deps da árvore `tools/sdk/engine`
(veja o Game Engine Guide).


## 36. Nível de API 31 — Verlet nativo: `System.verlet*`

O step pesado do verlet — integração, relaxação de vínculos e bounds com
bounce — roda em **C++ float** (FPU single do S3; double é soft-fp e custa
5-10×): os pontos vivem num buffer nativo malloc'ado (PSRAM quando a placa
tem; ~10 KB na RAM interna senão), fora do heap Duktape, e o JS cria, pinta
e desenha por índice. Até 4 mundos simultâneos, 256 pontos e 640 vínculos
cada; todos saem no início do próximo app. O jeito recomendado de usar é a
dep: `P.verletFast` (celeros.physics 1.2.0) faz o feature-detect e cai
para o verlet JS interpretado em firmware sem API 31 — a API crua:

#### `System.verletNew([iterations, radius])` → Inteiro (API 31)
Cria um mundo verlet (iterations de relaxação por step, default 4, máx 16). `radius` > 0 liga a **colisão ponto-ponto**: pares não vinculados mais próximos que `2×radius` se separam (reposicionamento sem impulso — pilhas ficam estáveis). Devolve o id (1..4) ou -1.

#### `System.verletFree(id)` (API 31)
Devolve o mundo (malloc incluso). Os mundos também saem sozinhos no fim do app.

#### `System.verletAddPoint(id, x, y)` → Inteiro (API 31)
Adiciona um ponto parado em (x, y); devolve o índice (0..) ou -1 (mundo cheio).

#### `System.verletStick(id, a, b[, len])` → Boolean (API 31)
Vínculo entre os pontos a e b; `len` ausente = distância atual.

#### `System.verletPin(id, idx[, on])` → Boolean (API 31)
Prena/solta o ponto (on ausente = prender).

#### `System.verletSet(id, idx, x, y)` → Boolean (API 31)
Move um ponto SEM tocar na posição anterior — a velocidade implícita nasce da diferença (o dedo puxando).

#### `System.verletStep(id, dt, gx, gy[, damp, minX, minY, maxX, maxY, bounce])` → Boolean (API 31)
Um step completo: integração (gravidade em px/s², `dt²` como no `P.verlet`), relaxação das iterations e bounds opcionais (ativos quando `maxX > minX`) com rebote. Escalares puros: zero objetos no heap.

#### `System.verletXY(id)` → Array (API 31)
`[x0, y0, x1, y1, ...]` — uma alocação por frame para o desenho iterar.

#### `System.verletSticks(id)` → Array (API 31)
`[a0, b0, a1, b1, ...]` — índices dos pontos de cada vínculo.

#### `System.verletCount(id)` → Inteiro (API 31)
Quantos pontos o mundo tem.

#### `System.verletDelStick(id, i)` → Boolean (API 31)
Remove o vínculo `i` (o último entra no lugar — para vários cortes, delete do maior índice para o menor).

#### `System.verletDelPoint(id, idx)` → Boolean (API 31)
Remove o ponto `idx`: vínculos ligados a ele saem e o último ponto herda o índice (deleções do maior para o menor mantêm os índices coerentes).

#### `System.verletPins(id)` → Array (API 31)
Estado dos pinos por ponto (`[0, 1, ...]`) — para destacar e alternar.

## 37. Nível de API 32 — Efeitos misturados: `System.sfx`

O `System.playTone` é **bloqueante**: segura a thread JS nota a nota — o
loop de um jogo congelava 50-600 ms a cada explosão, e com música tocando o
efeito nem soava (o alto-falante tem uma posse só). O `System.sfx` entrega a
melodia à task do sintetizador chiptune: o efeito é **misturado por cima da
trilha do `playMusic`** (a trilha abaixa para ~55% enquanto o efeito soa,
para ele ficar legível) e a chamada volta na hora. Sem trilha, o
sintetizador abre uma sessão curta só para o efeito.

Mesmas placas do `playMusic` (alto-falante I2S: cão, SmartDisplay,
relógio). Um efeito por vez: um `sfx` novo substitui o que está soando (o
feedback mais recente vence, como num console). Não empurra o quadro —
chamar de dentro do draw é seguro.

#### `System.sfx(melodia)` → Inteiro (API 32)
- **Parâmetros:** `melodia` (Array) — `[freq, ms]`, `[[freq, ms], ...]` ou plano `[f, ms, f, ms, ...]`; `freq` 20..20000 Hz ou **0 = pausa** (avança o tempo), `ms` 1..1000 por tom. Clampado: 24 tons, 3 s no total; entradas malformadas são puladas.
- **Retorno:** Inteiro — quantos tons foram aceitos; `0` quando o alto-falante está ocupado (`playWav`, `playTone`, `AI.speak`), a placa não tem áudio I2S ou nada era válido.

```javascript
// tiro por cima da trilha, sem travar o loop do jogo
if (typeof System.sfx === "function") System.sfx([[1200, 30], [900, 30], [600, 50]]);
else System.playTone([[1200, 30], [900, 30], [600, 50]]);   // firmware antigo: bloqueia
```

A `celeros.engine` 1.2 roteia o `E.audio.sfx` por ela automaticamente
(`E.caps.mix`) e torna o `E.audio.duck` um no-op quando há mistura.

## 38. Nível de API 33 — Corpo rígido nativo (`System.rigid*`) e `System.drawSprite`

Caixas que **giram, empilham e tombam**, círculos que **rolam**, pedra
rápida que **não atravessa** tábua fina: um solver de impulsos sequenciais
(molde box2d-lite) em C++ float — SAT caixa-caixa com até 2 contatos,
atrito e impulso **acumulados com warm start** (pilhas ficam em pé),
correção de penetração por pseudo-velocidade (nada de tremor), restituição,
**sono** por corpo (parado 0,5 s vira estático até levar pancada) e
**sub-passos adaptativos** anti-túnel (≥ 120 Hz; nenhum corpo anda mais que
40% da menor meia-espessura do mundo por sub-passo). Um castelo de 30 peças
custa ~1-2 ms por quadro no S3 — no interpretado não fecharia o quadro.

Só nas placas S3 (`CONFIG_CELEROS_JS_GAME_ACCEL`: SmartDisplay, relógio,
cão); no ESP32 clássico as funções não existem — teste com `typeof`. O
jeito recomendado é a dep: `P.rigid()` da `celeros.physics` 1.5.0 (devolve
`null` sem o binding). Até 2 mundos de 96 corpos; saem no início do
próximo app. Unidades livres (as do app), ângulo em **radianos**, y para
baixo. Índices são **estáveis**: remover libera o slot e o próximo add o
reaproveita.

#### `System.rigidNew([iterations])` → Inteiro (API 33)
Cria um mundo (iterações do solver por sub-passo, default 10, máx. 30). Devolve o id (1..2) ou -1.

#### `System.rigidFree(id)` (API 33)
Devolve o mundo (malloc incluso, ~60 KB na PSRAM).

#### `System.rigidBox(id, x, y, w, h[, angle, density, friction, bounce])` → Inteiro (API 33)
Caixa com centro em (x, y) e medidas w × h. `density` 0 = **estático** (chão, paredes); default 1. `friction` default 0,6; `bounce` (restituição 0..1) default 0,1. Devolve o índice ou -1 (mundo cheio).

#### `System.rigidCircle(id, x, y, r[, density, friction, bounce])` → Inteiro (API 33)
Círculo de raio r (mesmos defaults). Círculo encostado sofre resistência ao rolamento — a bola para.

#### `System.rigidRemove(id, idx)` → Boolean (API 33)
Remove o corpo (contatos inclusos) e **acorda o mundo** — o que estava apoiado nele cai.

#### `System.rigidSet(id, idx, x, y[, angle, vx, vy, w])` → Boolean (API 33)
Teleporte + velocidade (u/s e rad/s); acorda o corpo. O lançamento de um projétil é um `rigidSet` com a velocidade do estilingue.

#### `System.rigidImpulse(id, idx, jx, jy)` → Boolean (API 33)
Impulso no centro (Δv = j / massa); acorda o corpo. Explosões: impulso radial nos vizinhos.

#### `System.rigidStep(id, dt[, gx, gy, maxSub])` → Inteiro (API 33)
Avança `dt` segundos (clampado em 0,1) com gravidade em u/s². Devolve quantos sub-passos rodou (`maxSub` default 12, máx. 16).

#### `System.rigidState(id[, buf])` → Array (API 33)
`[x, y, angle, hit, speed, flags, ...]` — 6 números por índice. Passe o array do quadro anterior em `buf` e ele é preenchido no lugar (o `length` acompanha o mundo) e devolvido — nada de array novo por quadro; o firmware 1.8.0 ignora o `buf` e devolve um novo, então use sempre o retorno. `hit` = maior impulso de impacto do último step (aproximação × massa efetiva: o dano do jogo sai daqui); `speed` = rapidez do ponto mais rápido do corpo; `flags`: 1 vivo, 2 acordado.

#### `System.rigidCount(id)` → Inteiro (API 33)
Slots em uso (marca d'água): o `rigidState` tem `6 × rigidCount` números.

#### `System.drawSprite(id, x, y[, angle, zoomX, zoomY, key, smooth])` (API 33)
Desenha o sprite `id` (do `createSprite`) **girado e escalado** com o centro em (x, y) no alvo corrente — o quadro, ou outro sprite selecionado por `useSprite` (não desenha um sprite sobre si mesmo). `angle` em **graus** (horário), `zoomY` default = `zoomX`, `key` = cor-chave transparente (RGB565; `null` = opaco), `smooth` = amostragem com anti-alias (reduzir/ampliar arte no load sem serrilhado; o padrão, vizinho mais próximo, é mais rápido por quadro). Peças que giram na física, e um fundo pequeno em PNG ampliado para a tela inteira dentro de um sprite.

Na mesma API o pool de sprites com PSRAM dobrou para **16** (`System.spriteSlots()` informa): um jogo com arte por personagem, texturas de material e o cenário num sprite de tela cheia estourava os 8.

```javascript
var P = require("celeros.physics");          // dep ^1.5.0
var w = P.rigid({ iterations: 10 });
if (!w) { /* firmware sem API 33: avise o usuário */ }
w.box(160, 270, 400, 20, { static: true });  // chão
var tabua = w.box(200, 240, 48, 6, { density: 0.6, friction: 0.7 });
var pedra = w.circle(40, 200, 6, { density: 3, bounce: 0.3 });
w.set(pedra, 40, 200, 0, 420, -40, 0);       // lança
w.step(dt, { gravity: { x: 0, y: 400 } });
var s = w.state();
if (w.hit(tabua, s) > 900) w.remove(tabua);  // quebrou
System.drawSprite(sprTabua, w.x(tabua, s), w.y(tabua, s),
                  w.angle(tabua, s) * 57.2958, 1, 1, 0x0000);
```

## 39. Nível de API 34 — `System.blitSprite` (restaurar o fundo numa chamada)

#### `System.blitSprite(id, x, y, w, h)` (API 34)
Copia o retângulo (x, y, w, h) do sprite `id` para a **mesma posição** do alvo corrente, tratando o sprite como se cobrisse o canvas a partir de (0, 0) — um fundo de tela inteira. O recorte do alvo volta ao que era. É o painter da camada suja de um jogo numa chamada de binding: `setClip` + `useSprite` + `pushSprite` + `useSprite(0)` + `clearClip` eram 5 chamadas por caixa suja, e um quadro movimentado repinta dezenas de caixas. Só nas placas S3 (`CONFIG_CELEROS_JS_GAME_ACCEL`, como o `drawSprite`): detecte antes de usar.

```javascript
E.dirty.enable(function (x, y, w, h) {
    if (System.blitSprite) { System.blitSprite(sprFundo, x, y, w, h); return; }
    System.setClip(x, y, w, h);              // API 33 e anteriores
    System.useSprite(sprFundo);
    System.pushSprite(0, 0);
    System.useSprite(0);
    System.clearClip();
});
```

No mesmo nível o `System.rigidState(id, buf)` aceita o array do quadro anterior e o preenche no lugar (veja a API 33); a `celeros.physics` 2.1 usa isso dentro do `state()`.

## 40. Nível de API 35 — Câmera: `Camera` (fotos e QR na esp32-cam)

O objeto `Camera` só existe em placas com sensor de câmera no perfil (hoje a
esp32-cam, OV2640) construídas com `CONFIG_CELEROS_JS_CAMERA`, e só para apps
que declaram a permissão **"camera"**. Feature-detect com
`typeof Camera !== "undefined"` (ou `System.getInfo().board`).

#### `Camera.setup({framesize, pixformat, fbcount, xclkMhz})`
Configura o modo foto e liga o sensor. Devolve `true` em caso de sucesso.
Opções: `framesize` `"qqvga"|"qvga"|"vga"|"svga"|"hd"|"sxga"|"uxga"` (default
`qvga`; JPEG acima disso agradece PSRAM), `pixformat` `"jpeg"|"gray"|"rgb565"`
(default `jpeg`), `fbcount` 1-2 (default 2 com PSRAM) e `xclkMhz` 10 ou 20
(default 20; baixe para 10 se a bancada mostrar ruído no relógio de pixels).

#### `Camera.capture()` -> `{id, w, h, len, format}` | `null`
Captura um quadro. O buffer é copiado para um slot retido (PSRAM) e a fila do
driver é liberada na hora — até 2 quadros retidos (`id` 1-2); com os dois
cheios, o mais antigo é reciclado. `null` = sensor não pronto.

#### `Camera.save(id, path)` -> bytes gravados | `-1`
Grava o quadro retido `id` em `path` (mesmas regras do `FS.writeFile`:
atômico no `/local`, direto no SD). O nome do arquivo é seu —
`/sd/foto.jpg` é o costumeiro.

#### `Camera.free(id)`
Libera um quadro retido.

#### `Camera.led(on)`
O LED de flash branco da câmera (GPIO4 na AI-Thinker), para iluminar um QR
ou uma foto no escuro. É um LED de potência sem limitação de corrente na
placa: o firmware o apaga sozinho após 800 ms acesos e, depois de um
acendimento longo (> 250 ms), ignora o próximo `led(true)` por 4x o tempo que
ficou aceso. Pulsos curtos (piscadas) passam livres. Não serve de lanterna
contínua.

#### `Camera.scanQR({timeoutMs, attempts, led})` -> string | `null`
Lê códigos QR **no próprio aparelho** (decodificador quirc; o quadro
grayscale vai direto para o decoder — sem etapa de JPEG). Reconfigura o
sensor para grayscale QVGA durante a leitura e devolve o modo foto depois
(a troca custa dezenas de ms, só quando o app mistura fotos e leitura).
Tenta até decodificar algo, estourar o orçamento de `attempts` (default:
derivado do `timeoutMs`, uma tentativa ~250 ms) ou o `timeoutMs`
(default 6000). `led:true` acende o flash na leitura, sujeito ao mesmo teto do
`Camera.led` (até 800 ms por leitura; prefira `led:false` com luz ambiente). Devolve o
texto decodificado ou `null`.

```javascript
var code = Camera.scanQR({ timeoutMs: 5000, led: true });
if (code) {
    // padrao do no-sensor: entrega pro gateway pela malha
    var gw = Pack.members().filter(function (m) { return m.caps.hub; })[0];
    if (gw) Pack.send(gw.id, { t: 'qr', code: code }, { urgent: true });
}
```

Notas para nós-sensor: `scanQR` renova a janela do exec-timeout a cada
tentativa, então um loop de leitura é seguro; a malha anuncia
`caps.camera: true` no `Pack.members()` das placas com câmera (payload da
API 27), e fotos/resultados de QR cabem no envelope da malha — imagens
inteiras não (para isso, WiFi).

Placas sem vidro: apps que desenham não rodam no perfil da esp32-cam (ver
`CELEROS_UI`); a interface de um app de câmera são LEDs, logs e a malha.

## 41. Nível de API 36 — Recursos da matilha: usar o mic, o speaker, a câmera e os dados de outro aparelho

Cada nó **expõe** o que tem e qualquer membro da matilha pode **abrir**. A
malha leva a descoberta e o controle; cada abertura é uma *sessão* com
lease: se o cliente some, o dono recebe o recurso de volta sozinho em ~20 s
(e, se o dono esqueceu a sessão, o cliente reabre sozinho com o mesmo handle).
Nada bloqueia — `open()` devolve o handle na hora e `status(h)` conta quando
o dono respondeu (~1 s num salto).

Os recursos nativos vêm do perfil da placa: `mic`, `speaker` e `camera`
(exclusivos: uma sessão por vez). `mic` e `speaker` ficam prontos nas placas com áudio I2S (veja `Pack.listen`/`speak`/`record` abaixo); a `camera` fica pronta nas placas com câmera (veja `Pack.snap`/`view` abaixo). As sessões usam **ESP-NOW** (rádio WiFi, sem roteador, ~65 KB/s por sentido) quando os dois nós cabem num canal — o nó no WiFi mantém a internet, o livre vai para o canal do AP — e caem para a malha nos outros casos. Os **canais de dados** criados por
apps (`Pack.expose`) já funcionam, pela malha (até 425 bytes por mensagem,
taxa baixa: leituras de sensor, estados, comandos).

Privacidade: abrir o `mic` ou a `camera` de outro nó exige a mesma permissão
que o `Mic`/`Camera` local exigiria (`"mic"`/`"camera"` no app.json), e **só
funciona dentro de uma matilha privada** (API 37): um nó na rede aberta
`"celer"` recusa com `denied` (veja a nota de segurança em `CelerNet`). O dono
desliga o compartilhamento por recurso com os settings `res_share_mic`,
`res_share_cam`, `res_share_spk`, `res_share_sens` (todos nascem `"1"`) e
`res_share_gpio` — que nasce **`"0"`**: acionar um relé de outro cômodo é
diferente de ouvir um mic, o dono liga de propósito (`"0"` = recusa com
`denied`). Abrir `gpio`/`sensor` remotos exige a permissão `"gpio"` do
app.json.
Pelo cabo vale o mesmo regime: um computador ligado na USB do gateway é
outro cliente dos recursos, com o interruptor mestre `res_share_usb`
(default `"0"`, liga com `cfg res_share_usb 1` no shell). O tráfego ESP-NOW também vai cifrado com a chave da matilha.

#### `Pack.resources([tipo])` → Array
O que os vizinhos expõem: `[{node, nodeName, name, type, busy, shared, ready}]`,
`type` é `"mic" | "speaker" | "camera" | "gpio" | "sensor" | "data"`. Vem de um
cache; o nó ainda sem cache é consultado em segundo plano — chame de novo ~1 s
depois. Nós na API 38+ trazem também os **metadados** do recurso: `unit`
(unidade, ex. `"%"`), `min`/`max` (faixa de sensor) e `schema` (JSON dos
parâmetros que o `open` aceita, ex. `{"off":0|1}` num relé).

#### `Pack.open(no, nome, [opts])` → Number
Abre o recurso `nome` no `no` (id ou nome). Devolve o handle (0..7) ou `-1`
(sem slot, malha desligada, nó desconhecido, falta de permissão). `opts`
viaja ao dono como JSON (até 48 bytes).

#### `Pack.status(h)` → Object|null
`{state, reason, node, name, via}` (`via`: `"espnow"` — rápido, até 1449 bytes por mensagem — ou `"mesh"`). `state`: `"opening"`, `"open"`, `"refused"`,
`"revoked"`, `"lost"` (o dono saiu / não respondeu) ou `"closed"`. `reason`
na recusa/revogação: `"notFound"`, `"busy"`, `"denied"`, `"unsupported"`,
`"full"`, `"local"`, `"gone"`, `"noLink"` (áudio/imagem sem canal ESP-NOW comum) (`"expired"` não aparece: o cliente reabre).

#### `Pack.read(h)` → String|null
Próxima mensagem publicada na sessão (a mais antiga primeiro; 6 no buffer).

#### `Pack.write(h, dado)` → Boolean
Manda um dado ao dono (string ou objeto como JSON; ≤ 1449 bytes pelo ESP-NOW, ≤ 425 pela malha).

#### `Pack.close(h)`
Fecha a sessão. Os handles fecham sozinhos quando o app sai.

#### `Pack.expose(nome, [opts])` → Boolean
Cria um canal de dados do app (nome ≤ 15 caracteres). `opts.shared` (padrão
`true`) aceita várias sessões; `false` = exclusivo (o 2º cliente recebe
`busy`). `opts.unit`, `opts.min`, `opts.max` (API 38) publicam metadados que
os consumidores veem no `Pack.resources()`.

#### `Pack.unexpose(nome)` → Boolean
Tira o canal e revoga as sessões abertas (`"gone"`); a saída do app faz o
mesmo.

#### `Pack.publish(nome, dado)` → Number
Manda `dado` a todas as sessões do canal; devolve quantas.

#### `Pack.sessions(nome)` → Number
Sessões vivas no canal (`-1` = canal inexistente).

#### `Pack.pollWrite()` → Object|null
Próxima escrita de um cliente num canal nosso: `{res, from, fromName, data}`.

```javascript
// dono: termômetro
Pack.expose("temp");
setInterval(function () { Pack.publish("temp", { c: Sensors.temp() }); }, 2000);

// cliente: qualquer membro da matilha
var t = Pack.resources("data").filter(function (r) { return r.name === "temp"; })[0];
var h = t ? Pack.open(t.node, "temp") : -1;
// no loop:
var d = h >= 0 ? Pack.read(h) : null;
if (d) System.drawString(JSON.parse(d).c + " C", 10, 40);

#### `Pack.listen(no)` → Number
Toca o microfone do `no` ao vivo no alto-falante **deste** aparelho
(interfone). Exige a permissão `"mic"` e um canal ESP-NOW comum com o nó
(senão recusa com `"noLink"`). Devolve um handle; `Pack.close(h)` para. O
áudio é PCM 16 kHz mono pelo ESP-NOW (32 KB/s), com ~160 ms de reserva.

#### `Pack.speak(no)` → Number
O inverso: o microfone **deste** aparelho toca no alto-falante do `no`. Exige
microfone local e `"mic"`.

#### `Pack.record(no, [opts])` → Number
Grava aqui o microfone do `no` (`opts.ms` de teto, 200..10000, padrão 6000).
Consulte `Pack.recording(h)` (false no teto ou com a sessão caída) e
`Pack.level()` (RMS 0..100) e colha com `Pack.recordStop`.

#### `Pack.recording(h)` → Boolean
True enquanto a gravação remota segue.

#### `Pack.level()` → Number
RMS 0..100 do último bloco de áudio remoto gravado (-1 = nenhum).

#### `Pack.recordStop(h, [opts])` → String|Boolean|null
Encerra a gravação e devolve o WAV em base64 (o formato do `input_audio` do
`AI.chat`), o WAV cru com `{raw:true}`, ou grava direto num arquivo com
`{path:"/local/x.wav"}` (exige `"fs"`; devolve true/false — use este acima de
poucos segundos: o `FS.writeFile` tem teto de 64 KB).

```javascript
var mic = Pack.resources("mic").filter(function (r) { return r.ready; })[0];
var h = Pack.record(mic.node, { ms: 4000 });
while (Pack.recording(h)) System.delay(100);
if (Pack.recordStop(h, { path: "/local/remoto.wav" })) System.playWav("/local/remoto.wav");
```

#### `Pack.snap(no, [opts])` → Number
Tira uma foto JPEG na câmera do `no` e grava em `opts.path` (padrão
`/local/snap.jpg`; exige `"camera"` e `"fs"`). Transferência confiável pelo
ESP-NOW (blocos de 1400 bytes, ACK com bitmap, só os blocos que faltaram são
reenviados). Consulte `Pack.status(h)`: `bytes`/`total` mostram o progresso e
`state` vira `"done"` com o arquivo gravado (~3 s num quadro VGA).
`opts.quality` 5..63 (menor = melhor, padrão 12). A foto sai do modo vigente da
câmera: um nó lendo QR manda um quadro em tons de cinza, sem reconfigurar o
sensor.

#### `Pack.view(no, [opts])` → Number
Vídeo ao vivo da câmera do `no`: um fluxo de quadros JPEG a `opts.fps` (1..10,
padrão 3; quadro incompleto no ar é descartado, nunca reenviado).

#### `Pack.drawFrame(h, x, y)` → Boolean
Desenha o quadro completo mais novo de uma sessão `Pack.view` em `x, y` (mesmo
decoder e escala do `System.drawJPG`); false = nenhum quadro novo desde a
última chamada.

```javascript
var cam = Pack.resources("camera").filter(function (r) { return r.ready; })[0];
var h = Pack.snap(cam.node, { path: "/local/foto.jpg" });
while (Pack.status(h).state === "open" || Pack.status(h).state === "opening") System.delay(100);
if (Pack.status(h).state === "done") System.drawJPG("/local/foto.jpg", 0, 0);
```


## 42. Nível de API 38 — Recursos genéricos: relés, GPIO e sensores da matilha

A ideia do produto: **qualquer feature do hardware vira recurso publicado**.
A API 38 acrescenta dois tipos ao catálogo da matilha e os primeiros
provedores nativos:

| Recurso | Tipo | Arbitragem | O que faz |
|---|---|---|---|
| `rele1`..`rele3` | `gpio` | exclusivo, matilha **privada**, `res_share_gpio` (default `"0"`) | aciona as linhas de relé da placa (SKUs com L1..L3) |
| `gpio` | `gpio` | idem | um pino de saída digital livre (`{"pin":N}` no `open`) |
| `lum` | `sensor` | compartilhado, `res_share_sens` | sensor de luz da placa, 0..100 `%` |
| `bat` | `sensor` | compartilhado, `res_share_sens` | carga da bateria, 0..100 `%` |

`Pack.resources()` mostra a unidade e a faixa dos sensores e o esquema de
parâmetros dos atuadores (`schema`).

#### Abrir um relé (auto-off)

O `open` recebe `{"off":1}` para pedir **auto-off**: quando a sessão acaba
(lease vencido, `close`, revogação — inclusive o dono local usando
`System.relay`, que ganha na hora), o relé **desliga sozinho**. Uma matilha
inteira pode cair que o atuador volta ao repouso.

```javascript
// (app com "gpio" no app.json)
var r = Pack.resources("gpio").filter(function (x) { return x.name === "rele1"; })[0];
var h = Pack.open(r.node, "rele1", { off: 1 });
while (Pack.status(h).state === "opening") System.delay(100);
if (Pack.status(h).state !== "open") throw new Error("rele1: " + Pack.status(h).reason);
Pack.write(h, "\u0001\u0001");   // [1][1] = liga
System.delay(30000);               // ...rega...
Pack.write(h, "\u0001\u0000");   // [1][0] = desliga
Pack.close(h);                     // sessao acaba: o auto-off garante 0
```

O protocolo de dados do `gpio` é binário, 1 byte de operação:
`[1][0|1]` escreve, `[2]` lê (o dono responde `[2][0|1]`). Ops futuros
(pulso/PWM) respondem `[255]`.

#### Sensor com taxa ou por pedido

`Pack.open(no, "lum", { rate: ms })` assina um **stream**: o dono amostra
sozinho e empurra mensagens de 8 bytes `[ts u32][f32 LE]` (o valor na unidade
do `unit` do catálogo). Com `rate` omitido (ou 0) a leitura é **por pedido**:
`Pack.write(h, "\x02")` pede uma amostra e ela chega no `Pack.read`. Com
taxa, a sessão exige ESP-NOW (como o áudio); por pedido funciona também na
malha pura.

```javascript
var t = Pack.open(no, "bat", { rate: 60000 });   // 1 amostra por minuto
while (true) {
  var d = Pack.read(t);
  if (d) mostra(decodifica(d));                  // 8 bytes: ts u32 + f32 LE
  System.delay(1000);
}
```

Dica de decodificação: os 8 bytes são `ts` (u32 little-endian) seguido do
valor float32 little-endiano — `d.charCodeAt(4)` & 0xff é o byte baixo do
float. Quem só quer o número pode ler o `unit`/`min`/`max` do catálogo e
tratar o `read` como opaco, exibindo o valor decodificado pelo próprio app
com `TypedArray` (suportado no Duktape).

Segurança do atuador, resumida: exclusivo (uma mão na bomba por vez),
privada (a rede aberta recusa com `denied`), `res_share_gpio` default `"0"`
(o dono liga de propósito), notificação no dono a cada sessão ("rele1 em uso
por X") e **o uso local sempre ganha** — `System.relay` no próprio nó revoga
a sessão remota no mesmo instante.

## 43. Nível de API 40 — Entrar na matilha: `Pack.join` e o convite pelo CelerLink

A matilha se apoia em três pilares e, desde a API 40, eles dividem uma
identidade só (`Pack.me().id`/`name` são os mesmos nos três):

| Pilar | Papel | JS |
|---|---|---|
| **CelerLink** | confiança: pareia por código de 6 dígitos e entrega a chave da matilha | `CelerLink.*` (camada baixa) |
| **CelerNet** + recursos | a malha: presença, mensagens, recursos | `Pack.*` (fachada), `CelerNet.*` (camada baixa) |
| **HostLink** | o gateway: o computador entra pelo cabo USB | `celerctl` / a crate Rust (sem JS) |

Um aparelho só compartilha mic, câmera e relés numa **matilha privada**
(veja a seção 41). São três portas de entrada, todas chegando na mesma
chave: a senha (`Pack.join`, `mesh join` no shell, `celerctl mesh join`), o
**convite** por um pareamento CelerLink (nenhuma senha digitada no aparelho
novo) e o cabo. Essas chamadas trocam a chave de rede do aparelho, então
exigem a permissão `"system"` no `app.json` (a mesma do `Net.wifiConnect`);
sem ela devolvem `false`. A chave em si nunca chega ao JS.

`Pack.me()` ganha `net` (nome da matilha; `"celer"` = rede aberta) e
`provisioned` (Boolean: numa matilha privada). `CelerLink.scan()` e
`status()` ganham `node`, o id do peer na matilha (seção do CelerLink).

#### `Pack.join(nome, senha)` → Boolean
Entra (ou cria) a matilha privada `nome` (1–15 caracteres) com `senha`
(≥ 8 caracteres; prefira 12+). Outro aparelho que digitar o mesmo par cai
na mesma matilha — nada para sincronizar. Bloqueia ~0,3 s (derivação da
chave). `false` com argumento inválido, sem permissão ou erro de gravação.

#### `Pack.leave()` → Boolean
Esquece a matilha e volta à rede aberta `"celer"`.

#### `Pack.acceptInvite([on])` → Boolean
Lado do aparelho novo: abre (padrão) ou fecha a **janela de convite** por
10 minutos. O aparelho passa a anunciar pelo CelerLink com o gate de código;
mostre `CelerLink.status().code` enquanto `CelerLink.status().pairing` for
true. A janela fecha sozinha ao entrar, em 10 minutos ou quando o app sai.

#### `Pack.invite()` → Boolean
Lado de quem já é membro: manda a chave da matilha, selada com o bond do
CelerLink, ao peer conectado e **verificado por código**
(`CelerLink.connect` + `CelerLink.verify`). `false` fora de matilha privada
ou sem peer verificado. A resposta chega em `Pack.inviteStatus()`.

#### O computador como membro da matilha (API 41)

Com o cabo USB num gateway (qualquer aparelho falando com o `celerctl`) e o
`res_share_usb` ligado (`celerctl shell cfg res_share_usb 1`), o computador
**entra na matilha como membro virtual**: todo aparelho o lista em
`Pack.members()` como `pc-XXXX` (XXXX = id do gateway; `caps.hub` true; o
id dele fica na faixa `FFxx`). Os apps falam com ele como com qualquer
membro — `Pack.send("pc-1CAE", {...})` chega no `celerctl mesh listen` do
computador, e o que o computador manda (`celerctl mesh send W "oi"`) chega
no `Pack.poll()` com `fromName: "pc-1CAE"`. No próprio gateway o apelido
`"pc"` também vale. Tirou o cabo, o membro sai com a presença; as sessões
que o computador segurava fecham (relés abertos com `off:1` desligam).
Nenhuma chamada JS nova: é o mesmo contrato do `Pack`.

#### `Pack.inviteStatus()` → String
`"idle"`, `"waiting"` (janela aberta), `"joined"` (entramos por convite),
`"sent"` (convite enviado, esperando a resposta — até 10 s), `"ok"` (o
convidado entrou) ou `"fail"`.

### Exemplo — convidando um aparelho novo

```javascript
// no aparelho NOVO (app Matilha -> "Aguardar convite"):
Pack.acceptInvite(true);
// a cada quadro: se CelerLink.status().pairing, mostre CelerLink.status().code
// quando Pack.inviteStatus() === "joined": Pack.me().provisioned === true

// num aparelho que JÁ está na matilha:
var peers = CelerLink.scan(3000);
if (peers.length && CelerLink.connect(peers[0].id) && CelerLink.verify(codigoDigitado)) {
    Pack.invite();                       // depois: Pack.inviteStatus() === "ok"
}
```

## 44. Nível de API 42 — Pacote único do app: `System.installZip`

Todo o app cabe em UM arquivo `.zip` — o mesmo que o hub já produz no
publish (`app.zip`, DEFLATE, layout flat com o `app.json` na raiz). O
`System.installZip` descompacta e publica o app em `/local/apps/<nome>`
com troca atômica: extrai em `<nome>.new`, confere que o entry do
`app.json` existe e só então troca pela pasta nova — se algo falhar no
meio (zip truncado, disco cheio, queda de energia), o app antigo fica
intacto. A App Store usa isto para trocar N downloads por 1 blob; pela
bancada o par é `celerctl apps installzip pacote.zip` (ou o comando
`installzip` do shell).

Requisitos do pacote: até 64 entradas, métodos `stored` e `deflate`,
arquivo solto até 272 KB e soma não comprimida até 448 KB (os tetos
finos por categoria continuam no lint do publish). Requer a permissão
`system`.

#### `System.installZip(zipPath, nome)` → Object (API 42)

`zipPath` é o caminho do `.zip` no aparelho (tipicamente baixado com
`Net.download` para `/local`); `nome` vira a pasta em `/local/apps/<nome>`
(sem barra, sem `..`, até 40 caracteres — o display name do app, igual à
convenção de pastas). Bloqueante; renova a janela do exec-timeout no fim.
Devolve `{ok: true, files, bytes}` ou derruba com `Error` (`installZip:
pacote recusado` para zip/teto/entry inválidos, `installZip: nome de
pasta invalido`). Depois de publicar, o launcher é rescaneado — o app
aparece no grid sem replug.

### Exemplo — instalando de um blob baixado

```javascript
// baixa o pacote inteiro em 1 request (o catálogo do hub publica
// it.zip = {url, size, md5} quando o servidor já serve o zip)
var ok = Net.download(it.zip.url, "/local/blob.zip", function (got, total) {
    drawProgress(got, total);
});
if (ok && FS.md5("/local/blob.zip") === it.zip.md5) {
    System.installZip("/local/blob.zip", it.name);   // {ok:true, files:N}
    FS.remove("/local/blob.zip");
}
```

## 45. Nível de API 42 — Serviços em segundo plano e gates de política

Um app pode declarar `"service": "service.js"` no app.json: o JS roda
FORA do foreground num heap próprio do OS (uma thread por serviço, sem
UI), bombeado pela tabela de serviços com orçamento de 8 ms/giro. A
superfície disponível ao serviço: timers (`setTimeout`/`setInterval`),
`require()` da pasta do app, `Storage` (NVS do pacote), `FS` (com a
jail), `CelerNet`/`Pack` (poll) e o `System` enxuto abaixo + `Service`.
Fora do serviço: UI/touch, `Net.*` (o serviço usa `System.otaCheck`), IA,
mic, câmera. O serviço herda o consentimento do app (só faz o que o app
pode); erro em callback PARA o serviço (app `system:true` reinicia 1x
após 60 s). Sem PSRAM, o heap do serviço suspende com app aberto; com
PSRAM segue no ar. Companheiro do serviço: o `install.sh` na pasta do
app roda 1x por versão no `sh` do device em modo RESTRITO (só comandos
de arquivo, na jaula da pasta do app e de `/local/data/<pkg>`, ≤16 KB).
O dialeto é o shell do CelerOS, não o Bourne: blocos são `if COND` /
`else` / `end` — não existe `then`/`fi`, e no `sh -e` comando
desconhecido para o script na hora. O shell não tem aspas; tem
redireção `>`/`>>`, expansão `$VAR`/`$?` e os comandos de arquivo de
sempre (`test`, `echo`, `cp`, `rm`...). Caminhos ABSOLUTOS (`../data`
resolve `/local/apps/data` e é negado); o `echo` junta argumentos com
um espaço — reconstrói JSON byte a byte. Sucesso grava o marcador de
versão; falha o deixa vazio e o script roda — e notifica — em TODO boot
até passar. Rode uma vez na bancada (`celerctl shell "svc setup
<pkg>"`) antes de publicar.

#### `System.appOpen()` → bool (API 42)
true com um app JS em primeiro plano. Gate da política: o check de
update do Nucleo nunca dispara com app aberto.

#### `System.updateBusy()` → bool (API 42)
true com check manual ou OTA em curso — não dispara check em cima de
check.

#### `System.shellActive()` → bool (API 42)
true com sessão `celerctl` ativa (debug/ota push no meio não pode ser
atropelado).

#### `System.syncTime()` → bool (API 42)
Tenta o SNTP agora e devolve se a hora JÁ é válida (o SNTP assenta
assíncrono — repita no próximo giro enquanto `System.timeValid()` for
false).

#### `System.timeValid()` → bool (API 42)
Hora válida (SNTP/manual/celular desde o boot).

#### `System.persistTime()` → bool (API 42)
Grava o epoch no NVS (o saveEpoch de 10 min do TimeManager virou
política do serviço Nucleo; o nativo vira watchdog e retoma se o
serviço ficar 15 min sem girar).

## 46. Nível de API 44 — 32 dependências compartilhadas por app

O runtime e o coletor de módulos do launcher leem o `deps.json` do app (o
fecho transitivo resolvido no install) até **32** módulos. Até a API 43 os
dois paravam em 8: o resto do fecho falhava com "módulo não encontrado" e o
coletor apagava esses módulos de `/local/modules`. Quando um `deps.json`
enche o teto (talvez cortado), o coletor agora pula a rodada em vez de
apagar qualquer coisa. Nada muda na API JS: apps com fecho maior que 8
módulos (uma aventura da CelerGame usa ~19) declaram `"api": 44`.

## 47. Nível de API 45 — `System.copySprite` (região de sprite para o alvo corrente)

#### `System.copySprite(id, sx, sy, w, h, dx, dy, key)` (API 45)
Copia a região (sx, sy, w, h) do sprite `id` para (dx, dy) do alvo CORRENTE: o quadro, ou um sprite
selecionado com `useSprite`. Não há escala. `key` é opcional: pixels dessa cor RGB565 não são copiados.
O recorte do alvo volta ao que era. Copiar um sprite sobre si mesmo é ignorado.

É o stamp de folha em escala 1 numa chamada só:
- **No quadro:** substitui `setClip` + `useSprite` + `pushSprite` + `useSprite(0)` + `clearClip`.
- **Dentro de outro sprite:** o `pushSprite` só empurra para o quadro, então gravar um fundo (uma sala
  de 195 tiles) tinha que ir pelo `drawSprite` afim com recorte (~240 µs por tile 32x32 no 4848, contra
  ~150–200 µs aqui). Junto com o `celeros.game.world` 1.1 (opção `tile`), a troca de sala da Lenda caiu
  de ~250 ms para ~120 ms.

Só placas S3 (`CONFIG_CELEROS_JS_GAME_ACCEL`, como o `drawSprite`), então detecte antes de usar. O
`celeros.game.spr` 1.5.1 usa a função dentro do `E.spr.stamp`/`E.spr.blit` quando ela existe.

```javascript
// sala gravada num sprite, uma chamada por tile (folha de células de 32 px)
System.useSprite(sprSala);
for (var k = 0; k < tiles.length; k++) {
    var t = tiles[k];
    if (System.copySprite) System.copySprite(folha, t.sx, t.sy, 32, 32, t.x, t.y);
    else System.drawSprite(folha, ...);   // API 44 e anteriores
}
System.useSprite(0);
```

## 48. Nível de API 47 — Sensores e atuadores da matilha: eventos, pulso/PWM, reflexos e ACL

A API 47 fecha o ciclo **sensor → decisão → atuador** da matilha: o atuador
ganha pulso e PWM, o sensor empurra **eventos** na transição de um limiar, o
firmware executa **reflexos** sozinho (NVS, sobrevive a app fechado e PC
desligado) e o dono pode dizer **quem** abre cada recurso.

### Atuadores: pulso e PWM

O `gpio`/`releN` ganhou as ops que antes respondiam `[255]` (o `schema` do
catálogo agora anuncia `{"off":1,"ops":"1234"}`):

| DATA | Efeito |
|---|---|
| `[1][0|1]` | liga/desliga (API 38) |
| `[2]` | lê (resposta `[2][0|1]`) |
| `[3][ms u16 LE]` | **pulso**: liga agora e o dono desliga sozinho no prazo (1..65535 ms) |
| `[4][0..100]` | **PWM** no pino genérico (`gpio`), 8 bits no LEDC — relé recusa `[255]` (comuta rede, não é dimmer) |

O app JS pode mandar **objetos** em vez de bytes — o dono entende a forma
textual `{"w":1}`, `{"r":1}`, `{"p":3000}` e `{"d":50}` (útil porque uma
string UTF-8 com byte >0x7F vira dois bytes no fio):

```javascript
var h = Pack.open(r.node, "rele1", { off: 1 });
Pack.write(h, { p: 3000 });    // pulso de 3 s; o dono desliga sozinho
Pack.write(h, { d: 50 });      // PWM 50% (so no "gpio" generico)
```

Pelo celerctl: `res pulse rele1 3000`, `res pulse -n A1B2 rele1 3000` (outro
nó, por procuração) e `res pwm <pino> 50`.

### Sensores: catálogo maior e eventos por limiar

O catálogo nativo cresceu: `lum` e `bat` (API 38), **`temp`** (die do IMU,
onde a placa tem) e **`adc`** (pino livre do ADC via `{"pin":N}` no `open`;
o pino passa pelas guardas do firmware — flash/PSRAM nunca).

Abra um sensor com `{gt: limiar}` e/ou `{lt: limiar}` (+ `{h: histerese}`)
para receber **eventos** em vez de stream: o dono avalia o limiar a 1 Hz (ou
no `rate`) e empurra uma mensagem de 10 bytes na **transição** — `[0xE0][ts
u32][f32 LE][dir]`, `dir` 1 = subiu (`gt`), 2 = desceu (`lt`). A histerese
re-arma o evento; um cooldown de 1 s por sessão segura o ruído. O evento
viaja também pela malha BLE (multi-hop) quando não há ESP-NOW.

```javascript
var h = Pack.open(no, "lum", { lt: 20, h: 2 });   // "escureceu"
// no loop:
var ev = Pack.onEvent(h);      // {v, dir:"lt", at} | null
if (ev) acende();
```

A amostra continua disponível no `Pack.read(h)` (mesmo formato de 8 bytes da
API 38) e o pedido por `{"r":1}` (ou `"\x02"`) segue funcionando.

### Reflexos nativos: `Pack.ruleAdd` / `ruleDel` / `ruleList`

Uma regra fica no **NVS do nó** e é avaliada pelo firmware: "se o meu sensor
X passar de Y, aplique Z". Sobrevive a app fechado, troca de app, crash do JS
e PC desligado. A regra mora no nó **do sensor** (quem tem o dado decide); o
alvo pode ser local (o `releN` do próprio nó) ou remoto (sessão do sistema no
recurso do outro nó, com auto-off). Quando a condição volta, a ação é
**desfeita** (relé off); `notificar` dispara só na entrada.

#### `Pack.onEvent(h)` → Object|null
Evento de threshold pendente da sessão: `{v, dir:"gt"|"lt", at:ms}`. Fila de
1 (o mais recente); a amostra contínua continua no `read`.

#### `Pack.ruleAdd(regra)` → Number
Cria uma regra no NVS (`id` ou `-1`). `regra`: `{sensor, op:"gt"|"lt", valor,
h, alvo, no, on}` para atuador ou `{sensor, op, valor, h, notificar}` para
notificação. Permissão `"system"`.

#### `Pack.ruleDel(id)` → Boolean
Remove a regra pelo id.

#### `Pack.ruleList()` → Array
Regras persistidas: `[{id, sensor, op, valor, h, alvo, no?, on, notificar?}]`.

```javascript
// (perm "system") no no do sensor de luz:
Pack.ruleAdd({ sensor: "lum", op: "lt", valor: 20, h: 2, alvo: "rele1", on: 1 });
Pack.ruleAdd({ sensor: "bat", op: "lt", valor: 15, notificar: "Bateria baixa" });

Pack.ruleList();        // [{id, sensor, op, valor, h, alvo, no?, on, notificar?}]
Pack.ruleDel(1);
```

Pelo shell/celerctl: `svc reflex ls`, `svc reflex add lum lt 20 2 local rele1
on`, `svc reflex add lum gt 35 0 local rele1 off`, `svc reflex notify bat lt
15 1 Bateria baixa`, `svc reflex del 1` (`res rule ...` no celerctl). Sensor
`adc` e sensor remoto não são avaliados por regra nesta versão.

### ACL: quem pode abrir cada recurso

Até a API 46, qualquer membro da matilha privada abria o que estivesse
compartilhado (os interruptores `res_share_*` são por TIPO). A API 47
acrescenta a lista por RECURSO, no NVS do **dono**:

```
res acl                     # catalogo com o modo de cada recurso
res acl rele1 list A1B2     # so o no A1B2 (hexa) pode abrir rele1
res acl lum add C3D4        # acrescenta
res acl rele1 open          # volta a aberta (o default)
res acl rele1 del A1B2      # remove
```

Fora da lista o OPEN é recusado com `denied` (antes da arbitragem de
exclusividade). O PC no cabo conta como nó (`pc-XXXX`): para liberar só ele,
liste o id que aparece no `celerctl mesh status`. A lista é editada
localmente (shell/app); a distribuição assinada com a `adminKey` entra na
próxima rodada, junto com o diálogo de consentimento no dono.

### Descoberta: `CAPS_RES`

O BEAT ganhou o bit `0x80` (`CAPS_RES`): "este nó publica recursos". Os
membros aparecem com `caps` a mais no `Pack.members()` — útil para a UI
filtrar quem tem o que antes mesmo do `Pack.resources()` (o catálogo segue
sendo a fonte da verdade).

## 49. Nível de API 48 — USB Host e input do OS: `USB.*` e `Input.*`

**Onde existe.** Só em firmware compilado com `CELEROS_USB_HOST` (hoje a
placa `devkit-s3`: ESP32-S3 N16R8, com o USB-C nativo em modo **host**) e em
app com a permissão `"usb"` no `app.json`. Teclado e mouse também pedem
`"input"`. Detecte com `System.getInfo().hasUsbHost` e com
`typeof USB !== "undefined"` — nas outras placas o objeto não existe.

**O que o firmware faz.** Enumera os dispositivos, lê os descritores e
executa transfers. **Nenhum driver de dispositivo mora no C++**: ESC/POS,
HID, SCSI, protocolo proprietário... são JS sobre esta API. As deps
`celeros.usb`, `celeros.usb.escpos` e `celeros.usb.hid` do hub trazem os
primeiros drivers de referência.

**Bytes são arrays de números (0..255).** O Duktape do firmware é *lean*:
não há `Uint8Array`/`ArrayBuffer`. O teto é **4096 bytes** por transfer; para
um job maior, grave o binário num arquivo e use `USB.sendFile` (streaming em
chunks de 2 KB no lado C++, sem passar pelo heap do JS).

**Um dono por interface.** `USB.claim` marca a interface para o app/serviço
corrente; claims e listeners são liberados sozinhos quando o app sai (ou no
`svc stop`). Enquanto estiver presa, outro app recebe `false`.

**Hotplug.** `USB.poll()` devolve um evento por dispositivo que entrou ou
saiu; drene até `null` a cada quadro (ou a cada tick de um serviço).

**Console na UART.** No S3 o USB-OTG divide o PHY com a USB-Serial/JTAG: com
o host ligado, o console/celerctl fica na UART0 (conector "UART" do
DevKitC-1). O VBUS do host não é chaveado por software — a placa precisa
fornecer 5 V (use hub alimentado se o dispositivo pedir mais corrente).

### `USB.devices()` (API 48)
Lista os dispositivos enumerados:

```javascript
[ { addr: 1, vid: 0x04B8, pid: 0x0202, cls: 0, subcls: 0, proto: 0,
    speed: 2, claimed: [0],
    ifs: [ { n: 0, alt: 0, cls: 7, subcls: 1, proto: 2,
             eps: [ { addr: 0x01, type: 2, mps: 64, ivl: 0 },
                    { addr: 0x82, type: 2, mps: 64, ivl: 0 } ] } ] } ]
```

`addr` é o endereço USB (1..127) usado nas outras chamadas. `type` do
endpoint: 0 control, 1 iso, 2 bulk, 3 interrupt; `addr` com o bit 7 ligado é
IN. `claimed` lista as interfaces já presas por algum app/serviço e `speed`
é a velocidade negociada (1 low, 2 full, 3 high). Devolve `[]` sem host.

### `USB.poll()` (API 48)
Próximo evento de hotplug ou `null` quando a fila está vazia:
`{type:"add"|"remove", addr, vid, pid}`. Um service que precisa reagir a
plug/unplug drena num `setInterval`.

### `USB.claim(addr, iface[, alt])` (API 48)
Pede a interface `iface` (alternate `alt`, default 0) para o app corrente.
Obrigatório antes de qualquer transfer de endpoint. Devolve `true` no
sucesso; `false` se o device sumiu ou a interface já é de outro dono.

### `USB.release(addr, iface)` (API 48)
Solta a interface (só o dono consegue). A saída do app já faz isso sozinha.

### `USB.controlIn(addr, bmRequestType, bRequest, wValue, wIndex, len[, timeoutMs])` (API 48)
Control transfer IN (ex.: ler o report descriptor HID com
`bmRequestType=0x81, bRequest=6, wValue=0x2200`). Devolve
`{ok, status, len, data}` com até `len` bytes (máximo 2040). `timeoutMs`
default 250, teto 5000.

### `USB.controlOut(addr, bmRequestType, bRequest, wValue, wIndex, data[, timeoutMs])` (API 48)
Control transfer OUT (ex.: `SET_IDLE` de HID, `SET_LINE_CODING` de CDC).
`data` é um array de bytes. Devolve `{ok, status, sent}`.

### `USB.out(addr, ep, data[, timeoutMs])` (API 48)
Bulk/interrupt OUT. `ep` é o endereço do endpoint OUT (sem o bit 7). Envie
comandos de impressora, pacotes de um driver próprio, etc. Devolve
`{ok, status, sent}`. `status`: `"ok"`, `"stall"`, `"timeout"`, `"error"`,
`"gone"`, `"busy"`, `"overflow"`, `"canceled"`.

### `USB.in(addr, ep, len[, timeoutMs])` (API 48)
Bulk/interrupt IN pontual: devolve `{ok, status, len, data}`. Para fluxo
contínuo (teclado/mouse/status) prefira `USB.listen` + `USB.read`: um
`USB.in` por quadro perde reports entre as chamadas.

### `USB.sendFile(addr, ep, path[, maxBytes[, timeoutMs]])` (API 48)
Envia um arquivo do aparelho direto para o endpoint OUT, em chunks de 2 KB
(o conteúdo não entra no heap do JS). Exige a permissão `"fs"` e respeita o
jail do FS. Teto de 512 KB por chamada. Devolve `{ok, status, sent}` —
ideal para um cupom/logo ESC/POS pre-gravado.

### `USB.listen(addr, ep, len[, depth])` (API 48)
Liga a leitura contínua de um endpoint IN (interrupt ou bulk): o core mantém
um anel de `depth` registros de até `len` bytes (1..256) e reenvia o URB
sozinho. Devolve `true` se o listener nasceu. Cada app/serviço tem até 4
listeners simultâneos; eles morrem com o app.

### `USB.read(addr, ep)` (API 48)
Retira o próximo registro do listener: array de bytes ou `null` se vazio.
Drene num `while` a cada quadro.

### `USB.unlisten(addr, ep)` (API 48)
Desliga o listener e libera o anel/URB. Devolve `true` se existia.

### `USB.flush(addr, ep)` (API 48)
Limpa um endpoint preso (depois de `"stall"`/timeout): o URB pendente é
cancelado e o endpoint volta ao estado limpo. Devolve `true` no sucesso.

### Escrevendo um driver: impressora ESC/POS

```javascript
var usb = require("celeros.usb");
var esc = require("celeros.usb.escpos");

if (usb.available()) {
    var p = esc.open(usb.find({ cls: 7 }));   // interface classe 7
    if (p) {
        p.receipt("CELER OS", ["Ola, mundo!", "driver em JS"], "https://os.celer.tec.br");
        p.close();
    }
}
```

A dep `celeros.usb.escpos` é só um exemplo de driver: `p.raw([...])` manda
bytes crus, `p.file("/local/cupom.bin")` manda um job pre-gravado e
`p.text/line/align/size/bold/qr/cut` cobrem o cupom comum; `p.status()` lê o
status em tempo real (DLE EOT 1/2: `{online, erro, esperando, papel,
acabando, raw1, raw2}` — ela mesma repete o ZLP que impressoras Epson
respondem ao primeiro IN depois do abrir). Texto com acento: `p.codepage(16)`
(WPC1252) antes de escrever — os bytes saem como Latin-1. Para um modelo
específico, troque a sequência de comandos — o firmware não muda. A Epson
TM-T20X (vid 04B8, interface 7.1.2, bulk OUT/IN de 64 B) está validada na
bancada pelo app `Impressora` do devkit-s3.

### Lendo um pendrive (MSC)

Pendrive é classe 8, subclasse 6, protocolo 0x50 (Bulk-Only Transport). A
dep `celeros.usb.msc` implementa BOT + SCSI + FAT32/exFAT **em JS**; o
firmware só entrega os bulk transfers. O volume pode estar no LBA 0
(superfloppy) ou numa partição MBR/GPT — o driver localiza a partição:

```javascript
var msc = require("celeros.usb.msc");
var vol = msc.openVolume(usb.find({ cls: 8 }));
if (vol) {
    var i = vol.info();                 // {type,label,totalBytes,...}
    var lista = vol.list("/");          // [{name,dir,size}]
    var bytes = vol.read("/NOTA.TXT", 4096);   // array de bytes (ate 64KB)
    vol.close();
}
```

Somente leitura nesta versão (listar, `stat`, ler arquivo); `writeBlocks`
já existe como primitiva para o driver que alocar FAT. O app `USB Storage`
do hub é a referência de navegação (headless imprime a raiz no logcat).

### `Input.key(usage, mods, down)` (API 48)
Injeta uma tecla no barramento de input do OS (permissão `"input"`).
`usage` é o **usage ID do HID** (0x04=A ... 0x1D=Z, 0x28=Enter, 0x29=Esc,
0x2C=Espaço); `mods` é o byte de modificadores HID (bit0 LCtrl, bit1 LShift,
bit2 LAlt, bit3 LGUI, bit4 RCtrl, ...). Devolve `true` se a fila aceitou.

### `Input.poll()` (API 48)
Próxima tecla injetada: `{key, mods, down}` ou `null` quando a fila está
vazia. Uma fila só: um consumidor por vez (o app em primeiro plano, ou o
serviço que fizer a ponte).

### `Input.move(x, y, buttons)` (API 48)
Move o ponteiro no espaço virtual 240x320. `buttons`: bit0 esquerdo, bit1
direito, bit2 meio. Em placa com tela o ponteiro entra no pipeline de toque
como um dedo sintético (id reservado), então o mouse clica e arrasta na UI
como um toque; em placa headless o app lê com `Input.pointer()`.

### `Input.pointer()` (API 48)
Estado atual do ponteiro: `{x, y, buttons}`.

### `Input.clear()` (API 48)
Zera a fila de teclas e o ponteiro (bench ou driver que desconectou).

### Exemplo: driver de teclado/mouse como serviço

O app de fábrica `USB HID` do `devkit-s3` é a referência completa: roda no
svchost, abre teclado (HID boot protocolo 1) e mouse (protocolo 2), faz o
diff dos reports e chama `Input.key`/`Input.move`. Qualquer app com a
permissão `"input"` lê o resultado:

```javascript
var ev;
while ((ev = Input.poll()) !== null) {
    System.print("tecla " + ev.key + (ev.down ? " down" : " up"));
}
var p = Input.pointer();
System.print("mouse " + p.x + "," + p.y + " botoes " + p.buttons);
```

O firmware não interpreta as teclas: um app escolhe o que fazer com elas
(atalhos, jogos, um editor). Em placa com tela, o ponteiro já dirige o
launcher e os apps; a navegação por teclado na UI do sistema ainda não
existe nesta versão.
