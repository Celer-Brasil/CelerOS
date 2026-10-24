# Robô cachorro (SpotPear ZZPET S3)

[English](/Celer-Brasil/CelerOS/wiki/Robot-Dog) | **Português (BR)**

O primeiro alvo de robótica do CelerOS: o **cachorro robô ESP32-S3 da
SpotPear** (internamente **ZZPET `zzpet-s3`**), um quadrúpede de ~US$20 com
ESP32-S3R8, tela OLED de cara, microfone, alto-falante, touch e lâmpadas
WS2812. O fornecedor se recusa a publicar o esquemático, então o mapa de
hardware completo abaixo foi **extraído ao vivo pelo USB JTAG embutido** (dump
de registradores da matriz GPIO) e validado com um firmware de bring-up
próprio. A referência da comunidade fica em
[maikramer/zzpet-s3-dog](https://github.com/maikramer/zzpet-s3-dog) — pinouts,
análise do firmware, ferramentas de dump/restauração e o firmware de bring-up.

| Com carcaça | Placa nua |
| :---: | :---: |
| <img src="Documentation/assets/imgs/zzpet-dog-case.jpg" width="360" alt="Robô cachorro com carcaça"/> | <img src="Documentation/assets/imgs/zzpet-dog-pcb.jpg" width="360" alt="Placa do robô cachorro"/> |

## Hardware

| Item | Valor |
|---|---|
| SoC | **ESP32-S3R8** — LX7 dual-core, 8 MB PSRAM octal **embutida** (o anúncio mente "S3R2") |
| Flash | 16 MB (Boya), DIO @ 80 MHz — mesma classe do SmartDisplay |
| USB | USB-Serial/JTAG nativo: console, esptool **e** depuração com OpenOCD sem adaptador |
| Firmware original | Chatbot XiaoZhi AI v1.9.2 (ESP-IDF 5.5.1) — fork fechado do [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) |

### Pinout (verdade de hardware)

| Função | GPIO | Observações |
|---|---|---|
| Servo — perna traseira direita | **14** | LEDC, 50 Hz |
| Servo — perna dianteira esquerda | **17** | |
| Servo — perna dianteira direita | **13** | |
| Servo — perna traseira esquerda | **18** | |
| Servo — *despopulado* (cauda opcional) | **12** | canal existe, sem servo nas unidades vendidas |
| Mic — I²S1 RX (WS / BCK / DATA) | **4 / 5 / 6** | mic MEMS I²S padrão, áudio no slot **esquerdo** |
| Alto-falante — I²S0 TX (DOUT / BCLK / LRCK) | **7 / 15 / 16** | amp classe D, 16 kHz mono |
| OLED — I²C0 (SDA / SCL) | **41 / 42** | SH1106 1.3" @ 0x3C (ou SSD1306 0.96" por config) |
| Fitas WS2812 | **8** e **48** | 4 LEDs cada, RMT |
| Touch | **10** | toque = conversa, duplo = ação, longo = lâmpada |
| Botão BOOT | **0** | |
| Divisor da bateria | **2** | ADC1_CH1, divisor 2:1 (≈2066 mV no pino sob USB; `System.battery()` já devolve a célula, ≈4130 mV) |

O OLED é montado girado na cabeça: para dirigi-lo nativamente é preciso
**rotacionar cada glifo 90° horário no lugar e espelhar o frame inteiro em X e
Y** (equivale ao `SWAP_XY+MIRROR_X+MIRROR_Y` do fornecedor). Implementação de
referência no `oled_px()`/`glyph_px()` do firmware de bring-up.

### Armadilhas conhecidas

1. O I²C **deve** rodar a 100 kHz — não há pull-ups externos em 41/42.
2. **Nunca** configure o GPIO4 como ADC — é o clock I²S do mic; isso mata o
   microfone até reinicializar o canal I²S.
3. Segurar servos sob carga derruba a alimentação da USB do PC — use bateria.
4. Dois canais RMT com DMA falham; use sem DMA com `mem_block_symbols=96`.

## Situação no CelerOS

* **[feito]** Dossiê de hardware completo (pinout, orientação da tela, loopback
  de áudio, mapeamento servo↔perna, canal da bateria) — veja o
  [repo zzpet-s3-dog](https://github.com/maikramer/zzpet-s3-dog).
* **[feito]** **Celer Link via BLE** (API 9) + **servos no JS**
  (`System.gpio.servo`, API 10): a SmartDisplay 4848 dirige o cachorro com o
  app **Celer Remote** do hub — comandos do D-pad e telemetria (bateria,
  estado) pelo link. O hardware de placa de robô (bateria, microfone, pad de
  toque, NeoPixel) também entrou na API JS no nível 10.
* **[feito]** Board `main/Boards/spotpear-dog/`: boota no launcher e abre
  sozinho o app **Dog Face** (`homeApp` do perfil; app exclusivo da placa via
  overlay `boards/<placa>/data/`). Dog Face: olhos expressivos, reações ao
  toque e ao som, bateria, sono na inatividade e gaits com rampas
  (andar/ré/virar/sentar/deitar/alongar) com keepalive dead-man — o cachorro
  para sozinho se o controle soltar a seta ou o link cair.
* **[feito]** **Dog Face 1.5.1**: pernas portadas das tabelas C do ESP-Hi
  (Espressif) — gaits cíclicos walk/back/left/right mais a marcha "creep"
  (centopeia) como modo default `esphi`; posturas stand/lie/stretch/sit;
  espelho de servos FR/BL com sinais por perna. Calibração por perna pelo
  Celer Remote/nRF Connect (`{"type":"calib"}`, ajuste fino
  `{"type":"tune"}`) salva em `/local/dogtune.json`; o comando `modes`
  lista os gaits.
* **[feito]** **Repertório 2.0** (Dog Face 1.7/1.8): um **sequenciador**
  roda filas de passos `{do:"move"|"pose"|"trick"|"bark"|"leds"|
  "emotion"|"wait"|"say", ...}` no ritmo do loop, com clamps de segurança
  (12 passos, 3 s por passo, 12 s de fila, atos fora da whitelist são
  descartados). Da mesma fila saem:
  * **Truques nativos**: `dance` (coreografia **sorteada** a cada chamada —
    nunca a mesma dancinha), `spin`, `shake` (patinha), `pushup`,
    `excited`, `hello` e `pee` (o clássico de 3 patas); posturas novas
    `beg` e `pee`.
  * **Latidos de verdade**: 5 WAVs sintetizados (`woof`, `yip`, `growl`,
    `whine`, `howl`) embutidos no app — gerados por
    `tools/dog/barks.py` (síntese aditiva stdlib pura, semente fixa);
    sem o arquivo cai para melodia em `playTone`.
  * **Emoções**: `love` (corações), `angry` (sobrancelhas em V), `sad`
    (lágrima), `sleepy` (Zzz), `curious`/`alert` (pupilas) na cara +
    animações no anel de LED (arco-íris na dança, pulso rosa do amor,
    alerta piscando).
  * **Guardas**: bateria <15% recusa truque pesado com ganido + cara
    triste + "cansado" no controle; cruzou 20% ganido uma vez (histerese
    de 25%).
  * **Protocolo**: `{"type":"trick","name":"dance"}` pelo Celer Link
    responde `{"type":"trick_res","ok":...}`; "hi celer", D-pad, touch pad
    e stop interrompem a sequência na hora.
* **[feito]** **Locomoção 2.0 — o hop** (Dog Face 1.9): a **marcha hop**
  (o chute das traseiras alivia o corpo, as dianteiras abrem no ar,
  pousam plantadas e o chute frontal puxa) é a caminhada oficial —
  660 ms/ciclo, afinada na bancada em ~80 variantes de sweep
  (`tools/dog/plan_hop*.json`, aplicadas ao vivo pelo dogtune). A voz
  ganha **passos e duração** no `dog_move` ("ande 10 passos", "ande por
  1 minuto" → marcha contínua com prazo); **virar** é um hop
  assimétrico (um lado chuta cheio, o outro menor — knob `turn`) e o
  **giro de barriga** derruba o cachorro de barriga para torcer o corpo
  (knob `spin`, 40..110°). Todo knob da marcha é **afinável ao vivo por
  BLE** no painel **AFINAR do Celer Remote** (Remote 1.7+: abertura,
  inclinação traseira, esperas do hop, turn/spin — cada toque manda
  `{type:"tune"}`, o robô aplica na hora e persiste no
  `/local/dogtune.json`) — bancada sem cabo. Endurecimento de bancada
  que estabilizou: SHA em software + buffers RX do WiFi estáticos +
  canal do alto-falante criado no boot (criação lazy perdia a disputa de
  RAM interna para o NimBLE e o cachorro ficava mudo até reiniciar).
* **[feito]** **Latidos 2.0** — takes reais de cachorro renderizados por
  IA (text-to-sound, masterizados para o alto-falante pequeno:
  high-pass 250 Hz, saturação tanh, uma oitava acima do primeiro corte)
  viajam como arquivos **QOA** (`assets/*.qoa`, ~40 KB os cinco — 5x
  menores que WAV), decodificados pelo decoder ponto-fixo de ~60 linhas
  do firmware (a pilha MP3 saiu). Pipeline + prompts em
  `tools/dog/barks_ai.py`; o sintético `barks.py` segue de fallback.
* **[feito]** **Truques ensináveis** (`/local/dogtricks.json`): o dono
  cadastra sequências com nome no **mesmo schema que a LLM compõe** —
  `{"Super Truco":[{"do":"bark","kind":"howl"},{"do":"pose","name":"lie",
  "ms":400}]}` via `celerctl push` ou editor web. Os nomes (normalizados:
  "Super Truco" → `super_truco`) entram na tool `dog_trick` e no prompt,
  então **"hi celer, faz o super truco" funciona**. `{"type":"
  tricks_reload"}` recarrega pelo link; a telemetria lista `tricks`.
* **[feito]** **Celer Remote 1.5**: grade de truques na tela de controle
  (a lista vem do robô via `tel.tricks` — robô antigo não mostra) e as
  **respostas do cachorro** (`{"type":"say"}` do `dog_say`) aparecem como
  nota por 6 s.
* **[feito]** **Watchdog de bateria** no deep sleep: o coprocessador
  ULP-RISC-V (`DogUlp.cpp` + `ulp/ulp_main.c`) lê o ADC da bateria
  (ADC1_CH1, GPIO2, divisor 2:1) a cada ~60 s e acorda os núcleos se a
  célula cair abaixo de ~3,30 V — o cachorro dorme seguro. O cachorro só
  dorme via `System.deepSleep(ms)` e o timer sempre acorda.

### Voz e wake word

* **[feito]** **Wake word "Hi Celer"** on-device: detector microWakeWord
  próprio (`main/Hardware/WakeWord.cpp`) com streaming TFLite Micro —
  modelo int8 embutido na flash (~60 KB), arena de 32 KB que vai para a
  PSRAM quando disponível, em task própria. JS
  `WakeWord.start()/stop()/poll()/level()/running()` (API 20), com a
  mesma permissão `mic` no app.json do `Mic.*`.
* **[feito]** **Voz 2.0 — a LLM coreografa** (Dog Face 1.8): "hi celer"
  abre a janela de escuta (beep + anel de LED), grava até 3,5 s e envia o
  áudio ao qwen omni (OpenRouter) — que agora recebe **10 tools** e não um
  enum de 8 comandos:
  * `dog_move(direction, ms, steps)` — "anda um pouquinho pra frente", "vira
    à esquerda", "ande 10 passos" viram movimento com duração;
  * `dog_posture(pose)` — posturas incluindo `beg` e `pee`;
  * `dog_trick(name)` — truques nativos **e os ensináveis**;
  * `dog_sequence(steps[])` — **coreografia livre**: a IA compõe até 10
    passos na hora ("dança e depois late feliz" vira uma fila diferente a
    cada vez);
  * `dog_script(code)` — **a IA escreve JavaScript** (Dog Face 1.10.0):
    o próprio script ES5 dela roda no cachorro numa sandbox de
    coreografia — cara, pernas, LEDs e som juntos por uma mini-API
    (`face.*`, `legs.*` ±45°, `leds.set`, `sound.*`), com guardas de
    entrada, clamps físicos, relógio de 20 s, toque aborta e o
    exec-timeout do firmware como último guarda-chuva. Peça algo único e
    ela compõe na hora; `{"type":"script","code":...}` pelo Celer Link
    dispara performance direto do controle (bancada sem voz);
  * `dog_bark(kind, times)` — escolhe woof/yip/growl/whine/howl;
  * `dog_emotion(mood)` — cara + anel de LED;
  * `dog_say(text)` — resposta **silenciosa**: frase no controle pareado +
    resumo em sete-segmentos no vidro + yip;
  * `dog_speak(text, lang)` — **o cachorro FALA** (Dog Face 1.9.14, API 24):
    a IA escreve a resposta **no idioma da pergunta** (português, inglês,
    espanhol...) e o TTS do firmware (`AI.speak`, gemini tts pela chave
    OpenRouter, voz grave Charon) fala em voz alta no alto-falante — o
    download toca AO VIVO (nada na RAM), em task própria. Durante a fala
    o detector de wake word desliga (o cachorro não pode se ouvir) e a
    bolha fica no vidro; o campo `lang` vai no eco `{"type":"say"}`
    pro controle. Sem chave/WiFi, degrada no visual do `dog_say`;
  * `dog_stop` — para tudo.
  Fallback offline por palavra-chave (modelo sem tool_call/chave) cobre
  posturas/marchas **e** truques/latidos/emoções: dança, patinha, xixi,
  gira, flexão, late, uiva, rosna, te amo, bravo... (PT/EN, com as
  variantes acentuadas do STT). Andar por voz sem duração explícita
  continua limitado a 3 s.
* Pilha de voz na API JS: **18** AI, **19** `Mic.*`, **20** function
  calling + `WakeWord.*`, **24** `AI.speak` (TTS).

Restaurar o firmware original a qualquer momento é um comando único a partir
do dump completo (`tools/flash_backup_restore.sh` no repo do cachorro) — o
porte para o CelerOS nunca toca no bootloader do fornecedor.
