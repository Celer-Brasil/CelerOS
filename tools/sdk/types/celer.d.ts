// celer.d.ts — tipos da API JS do CelerOS para o editor (IntelliSense).
// ARTEFATO GERADO por `node tools/sdk/celer.js types` (manifest do firmware
// + guia pt-BR). Nao editar a mao; o `celer.js check` acusa drift.
// API level 49 — 362 funcoes.

interface CelerTheme {
    bg: number; card: number; raised: number; stroke: number;
    accent: number; accentD: number; onAccent: number;
    text: number; textDim: number; ok: number; warn: number; err: number;
}

interface TouchPoint { x: number; y: number; touched: boolean; }

interface TouchState { id: number; x: number; y: number; size: number; }

type UITextRole = "caption" | "body" | "title" | "display";
interface UITextOpts {
    role?: UITextRole; color?: number; align?: "left" | "center" | "right";
    w?: number; lines?: number; bg?: number; id?: number;
}
interface UITouch { down: boolean; x: number; y: number; tap: boolean; released: boolean; moved: boolean; sx: number; sy: number; }
interface UIListItem { label: string; sub?: string; right?: string; rightColor?: number; bars?: number; enabled?: boolean; }

// CelerNet (API 26): malha BLE — poll/nodes/status
interface MeshMessage { from: string; fromName: string; msg: string; hops: number; rssi: number; }
interface PackResource { node: string; nodeName: string; name: string; type: "mic" | "speaker" | "camera" | "data"; busy: boolean; shared: boolean; ready: boolean; }
interface PackSession { state: "opening" | "open" | "refused" | "revoked" | "lost" | "closed" | "done"; reason: string; node: string; name: string; via: "espnow" | "mesh" | ""; bytes?: number; total?: number; frames?: number; }
interface MeshNode { id: string; name: string; rssi: number; hops: number; lastSeen: number; }
interface MeshStatus { active: boolean; relay: boolean; node: string; name: string; net: string; secure: boolean; provisioned: boolean; txQueued: number; txDropped: number; txStarted: number; txFail: number; txNoToken: number; rxDropped: number; relayed: number; relayDropped: number; heard: number; rxAuthFail: number; rxReplay: number; }

declare function setTimeout(callback: () => void, ms: number): number;
declare function setInterval(callback: () => void, ms: number): number;
declare function clearTimeout(id: number): void;
declare function clearInterval(id: number): void;
declare function require(nome: string): any;

declare const System: {
    /** aloca um buffer de Sprite persistente off-screen na RAM. Força GC automaticamente e cai para 8 bits para garantir memória contígua. */
    createSprite(width: number, height: number): any;
    /** destrói o Sprite instantaneamente e libera a RAM. Você DEVE chamar isso ao terminar para evitar vazamentos severos de memória! */
    deleteSprite(arg0?: number): void;
    /** empurra todo o buffer oculto para a tela física instantaneamente via DMA. O buffer permanece na RAM e pode ser modificado */
    pushSprite(x: number, y: number, arg2?: number): void;
    /** se true, TODAS as chamadas System.draw... e `System.fill...` subsequentes são interceptadas e desenhadas */
    bindSprite(enabled: boolean): void;
    useSprite(arg0: number): any;
    spriteSlots(): any;
    /** desenho de linha vertical acelerado por hardware. Substancialmente mais rápido que `System.fillRect()` para fatias de */
    drawFastVLine(x: number, y: number, h: number, color: number): void;
    /** desenho de linha horizontal acelerado por hardware. */
    drawFastHLine(x: number, y: number, w: number, color: number): void;
    verletNew(iterations?: number, radius?: number): any;
    verletFree(id: string): void;
    verletAddPoint(id: string, x: number, y: number): any;
    verletStick(id: string, a: number, b: number, len?: number): any;
    verletPin(id: string, idx: number, on?: boolean): any;
    verletSet(id: string, idx: number, x: number, y: number): any;
    verletStep(id: string, dt: number, gx?: number, gy?: number, damp?: number, minX?: number, minY?: number, maxX?: number, maxY?: number, bounce?: number): any;
    verletXY(id: string): any;
    verletSticks(id: string): any;
    verletCount(id: string): any;
    verletDelStick(id: string, i: number): any;
    verletDelPoint(id: string, idx: number): any;
    verletPins(id: string): any;
    rigidNew(iterations?: number): any;
    rigidFree(id: string): void;
    rigidBox(id: string, x: number, y: number, w: number, h: number, angle?: number, density?: number, friction?: number, bounce?: number): any;
    rigidCircle(id: string, x: number, y: number, r: number, density?: number, friction?: number, bounce?: number): any;
    rigidRemove(id: string, idx: number): any;
    rigidSet(id: string, idx: number, x: number, y: number, angle?: number, vx?: number, vy?: number, w?: number): any;
    rigidImpulse(id: string, idx: number, jx: number, jy: number): any;
    rigidStep(id: string, dt: number, gx?: number, gy?: number, maxSub?: number): any;
    rigidState(id: string, buf?: number[]): any;
    rigidCount(id: string): any;
    drawSprite(id: string, x: number, y: number, angle?: number, zoomX?: number, zoomY?: number, key?: string, smooth?: number): void;
    blitSprite(id: string, x: number, y: number, w: number, h: number): void;
    copySprite(id: string, sx: number, sy: number, w: number, h: number, dx: number, dy: number, key?: string): void;
    /** inunda a tela inteira com uma única cor. Extremamente rápido: bypass do loop de pixels usando DMA de SPI direto do hardware. */
    fillScreen(color: number): void;
    /** desenha retângulos vazados ou preenchidos. */
    fillRect(x: number, y: number, w: number, h: number, color: number): void;
    drawRect(x: number, y: number, w: number, h: number, color: number): void;
    /** usa o algoritmo de Bresenham para renderizar uma linha reta entre dois pontos. */
    drawLine(x1: number, y1: number, x2: number, y2: number, color: number): void;
    /** renderiza um único pixel. */
    drawPixel(x: number, y: number, color: number): void;
    drawCircle(x: number, y: number, radius: number, color: number): void;
    /** renderiza círculos perfeitos, vazados ou preenchidos. */
    fillCircle(x: number, y: number, radius: number, color: number): void;
    drawTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, color: number): void;
    /** renderiza triângulos vazados ou preenchidos. Útil para projeções 3D ou indicadores de UI. */
    fillTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, color: number): void;
    drawRoundRect(x: number, y: number, w: number, h: number, radius: number, color: number): void;
    /** desenha retângulo com cantos arredondados na cor especificada. */
    fillRoundRect(x: number, y: number, w: number, h: number, radius: number, color: number): void;
    /** Retângulo (arredondado com radius) com gradiente vertical top → bottom. (API 22) */
    fillGradient(x: number, y: number, w: number, h: number, top: number, bottom: number, radius?: number): void;
    /** Arco cheio entre os raios r0..r1, ângulos em graus (0 = 3h, sentido horário) — anéis de progresso, medidores. (API 22) */
    fillArc(x: number, y: number, r0: number, r1: number, a0: number, a1: number, color: number): void;
    /** Círculo com borda suavizada (anti-aliasing). (API 22) */
    fillSmoothCircle(x: number, y: number, radius: number, color: number): void;
    /** Retângulo arredondado com cantos suavizados. (API 22) */
    fillSmoothRoundRect(x: number, y: number, w: number, h: number, radius: number, color: number): void;
    /** Linha grossa com anti-aliasing (ponteiros de relógio, gráficos). (API 22) */
    drawWideLine(x0: number, y0: number, x1: number, y1: number, width: number, color: number): void;
    mixColor(a: number, b: number, pct: number): number;
    /** lê uma imagem .bmp de 16, 24 ou 32 bits do sistema de arquivos (`/sd/` ou `/local/`) e a transmite em `x, y` sem usar RAM do */
    drawBMP(path: string, x: number, y: number): any;
    /** desenha uma imagem .png do sistema de arquivos (/sd/ ou `/local/`) em `x, y`, decodificada em streaming linha a linha (sem pico de */
    drawPNG(path: string, x: number, y: number): any;
    /** desenha um .jpg baseline (a saída do Pack.snap ou do `Camera.save`) decodificado em blocos 8x8 (sem a imagem inteira na RAM), (API 36) */
    drawJPG(path: string, x: number, y: number): boolean;
    /** renderiza strings em alta velocidade no display. O texto é UTF-8 e todas as fontes cobrem Latin-1 (U+0020..U+00FF), então acentos */
    drawString(text: string, x: number, y: number, font?: number): void;
    /** define as cores ativas de renderização de texto. Com `bg_color`, o texto sobrescreve em nível de hardware, apagando os pixels */
    setTextColor(fg_color: number, bg_color?: number): void;
    /** multiplica a escala da fonte pixel padrão. */
    setTextSize(size: number): void;
    setTextDatum(arg0: number): void;
    textWidth(str: string, font?: number): number;
    fontHeight(font?: number): any;
    /** empacota valores RGB 8/8/8 de 24 bits no formato RGB 5/6/5 de 16 bits esperado pelo hardware. */
    color(r: number, g: number, b: number): any;
    /** largura do canvas de design em que os apps desenham. Em painéis maiores o runtime escala tudo para a tela física (veja a nota do */
    screenWidth(): any;
    /** altura do canvas de design em que os apps desenham. */
    screenHeight(): any;
    /** consulta o controlador de toque. */
    getTouch(): TouchPoint;
    /** consulta TODOS os dedos no controlador de toque (multitoque). Mesma cedida de quadro do `System.getTouch()` — chame UM dos dois por loop, (API 43) */
    getTouches(): TouchState[];
    /** lê o botão físico 1 da placa como input do app (o padrão é o botão ser "home" do SO). Poll consumível no estilo da casa: devolve o (API 17) */
    button(): any;
    /** devolve o uptime total do hardware ESP32 em milissegundos desde o boot. Útil para física com delta-time e temporização de loop. */
    millis(): number;
    /** devolve o uptime total do hardware ESP32 em microssegundos desde o boot. Essencial para temporização de altíssima resolução (ex.: */
    micros(): number;
    /** pausa a execução do JavaScript. CRÍTICO: essa função comanda o kernel C++ para executar Garbage Collection em background. Se */
    delay(ms: number): void;
    /** delays sub-milissegundo de alta precisão, nativamente. Bloqueia a CPU de forma limpa, sem disparar Garbage Collection. Espera */
    delayMicroseconds(us: number): void;
    /** imprime uma mensagem no monitor serial USB físico num computador conectado (baud 115200). Útil para depurar variáveis enquanto a */
    print(str?: string): void;
    /** lê o sensor de temperatura interno do ESP32 e devolve o valor em Celsius. */
    getTemperature(): any;
    /** verifica se a revisão do hardware ESP32 instalada suporta o sensor de temperatura interno (alguns chips novos removeram). Devolve */
    hasTemperatureSensor(): any;
    /** devolve um objeto com o estado atual do hardware ESP32, incluindo uso de memória, velocidade de CPU e especificações. Útil para */
    getInfo(): any;
    /** devolve a hora local atual formatada pelo SO, respeitando automaticamente a preferência do usuário (12 ou 24 horas). */
    getTime(): any;
    /** devolve o segundo local atual direto do RTC. */
    getSeconds(): any;
    /** o instante absoluto em UTC. As demais chamadas de tempo devolvem a hora *local* já formatada; um app que conversa com nuvem (API 49) */
    epoch(): any;
    /** devolve a data local atual formatada como DD/MM/AAAA. */
    getDate(): any;
    /** devolve o ano local atual com 4 dígitos. */
    getYear(): any;
    /** devolve o mês local atual. */
    getMonth(): any;
    /** devolve o dia local atual do mês. */
    getDay(): any;
    /** devolve o offset/fuso horário configurado pelo usuário. */
    getTimezone(): any;
    getWeekday(): any;
    keepAwake(arg0?: number): void;
    /** devolve a string da versão atual do SO. */
    getOSVersion(): any;
    /** devolve o inteiro do Nível de API do SO. */
    getAPILevel(): any;
    /** devolve o endereço IP local atual do ESP32 (ex. "192.168.1.11") se o WiFi estiver conectado. */
    getIPAddress(): any;
    /** devolve true se o ESP32 estiver conectado a uma rede WiFi. */
    isWiFiActive(): any;
    prompt(promptMsg?: string, initialText?: number, options?: Record<string, any>): any;
    keypadOpen(options?: Record<string, any>): any;
    /** bombeia o toque para o teclado, redesenha as teclas quando necessário (feedback de pressionamento, páginas de layout, cursor piscando) */
    keypadPoll(): any;
    keypadText(): any;
    keypadRect(): any;
    keypadDraw(): void;
    keypadClose(): void;
    topbarText(texto: string): void;
    topbarButtons(labels?: number): any;
    topbarPop(): any;
    setBrightness(level: number): void;
    getBrightness(): any;
    setVolume(arg0: number): void;
    getVolume(): any;
    backlightSupported(): any;
    setAutoBrightness(on?: boolean): any;
    getAutoBrightness(): any;
    exitApp(): void;
    launchApp(packageName: string): void;
    present(): void;
    isBuffered(): any;
    wifiStatus(): any;
    md5(str: string): any;
    pinState(): any;
    rescanApps(): void;
    setting(key: string, arg1?: number): any;
    toast(mensagem: number): void;
    beep(arg0: number, arg1: number): any;
    /** leitura media de ADC com cache de ~2 s. No cão robótico SpotPear lê o divisor 2:1 da Li-ion no GPIO2 (~4100 mV na USB, ~3300 mV = vazia). (API 10) */
    battery(): any;
    batteryInfo(): any;
    /** bloqueante curto (~100 ms); o desenho pendente aparece antes. A primeira chamada inicializa o canal RX (~300 ms). (API 10) */
    micLevel(): any;
    /** pad capacitivo avulso (a "cabeca" do cao robotico). A referencia e calibrada na primeira chamada — mantenha o pad solto nesse instante. (API 10) */
    touchPad(): any;
    lightLevel(): any;
    get24hFormat(): any;
    getNtpEnabled(): any;
    theme(): CelerTheme;
    setScreenTimeout(arg0: number): void;
    screenTimeout(): any;
    setAlarm(arg0: number, arg1: number, arg2?: number): any;
    clearAlarm(): void;
    getAlarm(): any;
    alarms(): any;
    addAlarm(arg0?: number): any;
    updateAlarm(arg0: number, arg1?: number): any;
    removeAlarm(arg0: number): any;
    setTimer(seconds: number, label?: string): any;
    getTimer(): any;
    cancelTimer(): void;
    unreadNotifications(): any;
    playTone(arg0?: number): any;
    playWav(arg0: number): any;
    /** uma música por vez; um novo playMusic só entra quando a anterior acaba (ou é cortada). Enquanto toca, o detector de wake word on-device dorm */
    playMusic(song?: Record<string, any>, opcoes?: Record<string, any>): any;
    musicStop(): any;
    sfx(melodia?: number): any;
    musicPlaying(): any;
    musicPos(): any;
    notify(arg0: number, arg1?: number): void;
    setClip(x: number, y: number, w: number, h: number): void;
    clearClip(): void;
    setNativeCanvas(enable: number): any;
    /** desenha um ícone 64x64 de /local/icons/<name>.png com mesclagem de alpha (`.bin` legado aceito). */
    drawIcon(name: string, x: number, y: number): void;
    /** @permission "gpio" */
    led(r?: number, g?: number, b?: number): any;
    /** @permission "gpio" */
    relay(n: number, on: boolean): any;
    /** @permission "gpio" */
    relayState(arg0: number): any;
    /** @permission "gpio" */
    relayCount(): any;
    /** atualiza a fita inteira via RMT (sem DMA). Exemplo: System.neopixel(0, [0xFF0000, 0, 0x00FF00]). As fitas apagam quando o app sai. (API 10) */
    /** @permission "gpio" */
    neopixel(strip: number, cores?: number): any;
    /** reinicia instantaneamente o hardware ESP32. */
    /** @permission "system" */
    restart(): void;
    /** @permission "system" */
    openWifiSetup(): void;
    /** @permission "system" */
    factoryReset(mode?: number): any;
    /** @permission "system" */
    otaCheck(): any;
    /** @permission "system" */
    otaStart(url: string, progressCallback?: number): any;
    /** @permission "system" */
    installZip(zipPath: string, nome: string): any;
    /** @permission "system" */
    appOpen(): any;
    /** @permission "system" */
    updateBusy(): any;
    /** @permission "system" */
    shellActive(): any;
    /** @permission "system" */
    syncTime(): any;
    /** @permission "system" */
    timeValid(): any;
    /** @permission "system" */
    persistTime(): any;
    /** @permission "system" */
    webActive(): any;
    /** @permission "system" */
    webSetActive(arg0: number): void;
    /** @permission "system" */
    webAuthInfo(): any;
    /** @permission "system" */
    webAuthSetPass(arg0: number): any;
    /** @permission "system" */
    deepSleep(arg0: number, arg1?: number): void;
    /** @permission "system" */
    setPin(pin: number): any;
    /** @permission "system" */
    verifyPin(arg0: number): any;
    /** @permission "system" */
    pinClear(): void;
    /** @permission "system" */
    setTimezone(tz: number): any;
    /** @permission "system" */
    setManualTime(arg0: number, arg1: number, arg2: number, arg3: number, arg4: number): any;
    /** @permission "system" */
    set24hFormat(arg0: number): void;
    /** @permission "system" */
    setNtpEnabled(arg0: number): void;
    /** @permission "system" */
    notifications(): any;
    /** @permission "system" */
    notificationsClear(): void;
    gpio: {
        /** define o estado elétrico físico de um pino (ex.: pino 2 como OUTPUT para acender um LED). */
        /** @permission "gpio" */
        pinMode(pin: number, mode: number): void;
        /** aplica 3,3V (HIGH) ou 0V (LOW) num pino específico. */
        /** @permission "gpio" */
        digitalWrite(pin: number, state: number): void;
        /** lê o estado de tensão físico de um pino. */
        /** @permission "gpio" */
        digitalRead(pin: number): any;
        /** aciona o conversor analógico-digital de 12 bits do ESP32 para ler um nível de tensão contínuo. */
        /** @permission "gpio" */
        analogRead(pin: number): any;
        /** inicia um sinal PWM (Pulse Width Modulation) automático de hardware num pino. Útil para controle de motores ou dimmer de LEDs. */
        /** @permission "gpio" */
        analogWrite(pin: number, pwmValue: number): void;
        /** Medição Nativa de Pulsos por Hardware. Suspende o motor JS e delega ao kernel C++ a medição precisa da duração de um pulso de */
        /** @permission "gpio" */
        pulseIn(pin: number, state: number, timeout?: number): any;
        /** move um servo hobby padrão (classe SG90) com PWM de 50 Hz (pulso de 500–2500 µs). O canal LEDC é alocado na primeira escrita do pino. Robôs: (API 10) */
        /** @permission "gpio" */
        servo(pin: number, angulo: number): any;
        /** para o PWM no pino e libera o canal — o servo fica solto (sem torque de sustentação). Chame ao terminar um movimento para economizar energia (API 10) */
        /** @permission "gpio" */
        servoOff(pin: number): any;
        /** constante */
        OUTPUT: number;
        /** constante */
        INPUT: number;
        /** constante */
        INPUT_PULLUP: number;
        /** constante */
        HIGH: number;
        /** constante */
        LOW: number;
    };
};

declare const Storage: {
    get(arg0: number, arg1?: number): any;
    set(arg0: number, arg1?: number): any;
    remove(arg0: number): void;
    clear(): any;
    /** @permission "system" */
    clearFor(arg0: number): any;
};

declare const Sensors: {
    accel(): any;
    steps(): any;
    temp(): any;
    stepHistory(): any;
};

declare const UI: {
    /** Abre o frame: leva o quadro anterior ao vidro, lê o toque uma vez (tap/arrasto/pressão para todos os widgets do frame) e trata a topbar (X d (API 22) */
    begin(bg?: number): boolean;
    /** Fecha o frame: present + espera até completar 1000/fps ms desde o último end (padrão 30, teto 60). Substitui o System.delay do laço. (API 22) */
    end(fps?: number): void;
    /** Marca o próximo frame como total (troca de tela, dados novos). (API 22) */
    invalidate(): void;
    touch(): UITouch;
    /** Aviso curto (pílula na base da tela, padrão 1800 ms) dentro do app, desenhado pelo UI.end — o System.toast só aparece quando o app sai. Ao v (API 22) */
    toast(msg: string, ms?: number): void;
    /** Texto com as fontes de papel do sistema (FreeSans/DejaVu escolhidas pela densidade da tela). Redesenha sozinho quando o conteúdo muda. (API 22) */
    text(s: string, x: number, y: number, opts?: UITextOpts): number;
    measure(s: string, role?: UITextRole): number;
    lineHeight(role?: UITextRole): number;
    measureWrap(s: string, w: number, role?: UITextRole): number;
    /** Cabeçalho do app (faixa de 40 px no topo do canvas, abaixo da topbar do sistema) no visual das telas nativas. (API 22) */
    header(title: string, opts?: { sub?: string; back?: boolean }): boolean;
    button(label: string, x: number, y: number, w: number, h: number, opts?: { style?: "primary" | "ghost" | "danger"; disabled?: boolean; id?: number; color?: number; textColor?: number; role?: UITextRole }): boolean;
    toggle(x: number, y: number, on?: boolean, opts?: { id?: number }): boolean;
    slider(x: number, y: number, w: number, value: number, opts?: { min?: number; max?: number; step?: number; id?: number }): number;
    /** Barra de progresso 0..100. (API 22) */
    progress(x: number, y: number, w: number, h: number, pct: number): void;
    /** Arco girando (redesenha a cada frame) — espera de rede/IA. (API 22) */
    spinner(cx: number, cy: number, r: number, color?: number): void;
    /** Lista rolável com arrasto + inércia nativos (estado de rolagem guardado pelo id). (API 22) */
    list(id: string, x: number, y: number, w: number, h: number, items?: Array<string | UIListItem>, opts?: { rowH?: number; selected?: number }): number;
    tabs(x: number, y: number, w: number, h: number, labels?: string[], sel?: number): number;
    /** Superfície arredondada; os widgets seguintes usam a cor do card como fundo até UI.cardEnd(). (API 22) */
    card(x: number, y: number, w: number, h: number, opts?: { color?: number; radius?: number; stroke?: boolean }): void;
    /** Fecha o card (volta ao fundo anterior). (API 22) */
    cardEnd(): void;
    /** Área rolável genérica (recorte + arrasto + inércia). Rolar marca o próximo frame como total, então o conteúdo vai dentro do if (full). Toque (API 22) */
    scrollBegin(id: string, x: number, y: number, w: number, h: number, contentH: number): number;
    /** Fecha a área (restaura o recorte e desenha a barra de rolagem). (API 22) */
    scrollEnd(): void;
    /** Volta ao topo a lista/área id (troca de tela). (API 22) */
    resetScroll(id: string): void;
    /** Posiciona a lista/área id no deslocamento y (um valor grande vai ao fim — o próximo UI.list/UI.scrollBegin limita ao conteúdo) e para a inér (API 22) */
    scrollTo(id: string, y: number): void;
    badge(text: string, x: number, y: number, opts?: { color?: number; textColor?: number }): number;
    /** Diálogo modal bloqueante (como System.prompt) sobre a tela escurecida. Ao voltar, o próximo UI.begin é total. (API 22) */
    confirm(title: string, body?: string, opts?: { yes?: string; no?: string; danger?: boolean }): boolean;
    /** Aviso modal bloqueante com um botão. (API 22) */
    alert(title: string, body?: string, ok?: string): void;
};

declare const Net: {
    /** executa um HTTP GET. Segue redirects. Lança erro se o WiFi não estiver conectado. O corpo tem **teto de 32 KB** (`NET_MAX_BODY`): */
    /** @permission "net" */
    get(url?: string): any;
    /** como Net.get(), mas parseia o corpo como JSON. Mesmo **teto de 32 KB** do `Net.get()`: um JSON maior que o teto chega truncado e */
    /** @permission "net" */
    getJSON(url?: string): any;
    /** executa um HTTP POST. Lança erro se o WiFi não estiver conectado. */
    /** @permission "net" */
    post(url?: string, body?: string, contentType?: number): any;
    /** @permission "net" */
    request(opts?: Record<string, any>): any;
    /** @permission "net+fs" */
    download(url: string, caminho: number, onProgress?: (...args: any[]) => any): any;
    /** @permission "net" */
    beginGet(url: string): any;
    /** @permission "net" */
    pollGet(arg0: number): any;
    /** @permission "net" */
    cancelGet(arg0: number): void;
    /** devolve true se o WiFi estiver conectado. */
    /** @permission "net" */
    isConnected(): any;
    /** @permission "net" */
    wifiScan(): any;
    /** @permission "net+system" */
    wifiConnect(arg0: number, arg1?: number): any;
    /** @permission "net+system" */
    wifiDisconnect(): void;
};

declare const AI: {
    /** Assíncrono: o POST HTTPS roda em task própria (timeout de 60 s) enquanto o app continua desenhando. O callback recebe {ok, status, content,  (API 18) */
    /** @permission "net" */
    chat(opts: Record<string, any>, cb: (...args: any[]) => any): any;
    /** o download toca ao vivo (o som sai no primeiro byte da resposta, não no fim do arquivo; corpo de erro nunca toca no alto-falante). O callbac (API 24) */
    /** @permission "net" */
    speak(opts: Record<string, any>, cb: (...args: any[]) => any): any;
    /** abre a conexão TLS com o provider agora, para o próximo AI.chat/AI.speak pular DNS + TCP + handshake (~2 s no S3). Não ocupa o slot serial:  (API 24) */
    /** @permission "net" */
    warm(provider?: number): any;
    /** true quando existe chave daquele provider provisionada no aparelho. Use junto de Net.isConnected() antes de conversar. (API 18) */
    /** @permission "net" */
    configured(provider?: number): any;
    /** @permission "net" */
    cancel(): any;
};

declare const Mic: {
    /** Inicia a captura. No teto de ms o gravador para sozinho (Mic.recording() vira false; o buffer espera o Mic.stop()). (API 19) */
    /** @permission "mic" */
    start(opts?: Record<string, any>): any;
    /** Encerra a captura e devolve o áudio. Uma gravação por vez. O silêncio das pontas sai cortado (160 ms antes da primeira voz, 240 ms depois da (API 19) */
    /** @permission "mic" */
    stop(opts?: Record<string, any>): any;
    /** @permission "mic" */
    recording(): any;
    /** Para o medidor VU ao vivo. Com gravação em curso, o System.micLevel() devolve o mesmo nível ao vivo (compartilham o canal I2S). (API 19) */
    /** @permission "mic" */
    level(): any;
};

declare const Camera: {
    /** @permission "camera" */
    setup(opts?: Record<string, any>): any;
    /** @permission "camera" */
    capture(): any;
    /** @permission "camera+fs" */
    save(id: string, path: string): any;
    /** @permission "camera" */
    free(id: string): void;
    /** @permission "camera" */
    led(on: boolean): void;
    /** @permission "camera" */
    scanQR(opts?: Record<string, any>): any;
};

declare const WakeWord: {
    /** @permission "mic" */
    start(): any;
    /** Encerra a detecção, destrói o modelo e libera a RAM (~35 KB + arena). O runtime também encerra quando o app sai. (API 20) */
    /** @permission "mic" */
    stop(): void;
    /** @permission "mic" */
    poll(): any;
    /** @permission "mic" */
    level(): any;
    /** @permission "mic" */
    running(): any;
};

declare const FS: {
    /** carregador de alta velocidade para RAM. Lê o arquivo inteiro num bloco contíguo de String na RAM. Não use em arquivos maiores */
    /** @permission "fs" */
    readTextFile(path: string): string | null;
    /** @permission "fs" */
    readFile(arg0: number, arg1?: number): any;
    /** apaga qualquer arquivo existente e escreve a totalidade de `content` no disco. */
    /** @permission "fs" */
    writeTextFile(path: string, content: number): any;
    /** @permission "fs" */
    writeFile(arg0: number, arg1: number): any;
    /** acrescenta a string ao final de um arquivo existente. */
    /** @permission "fs" */
    appendTextFile(path: string, content: number): any;
    /** apaga permanentemente um arquivo da partição. */
    /** @permission "fs" */
    deleteFile(path: string): any;
    /** renomeia um arquivo ou o move entre diretórios na mesma partição. */
    /** @permission "fs" */
    renameFile(pathFrom: number, pathTo: number): any;
    /** valida se um arquivo ou pasta existe fisicamente. */
    /** @permission "fs" */
    exists(path: string): any;
    /** percorre um diretório e devolve um array de caminhos absolutos (ex.: `["/local/app.js"]`). */
    /** @permission "fs" */
    listDir(path: string): string[];
    /** cria um novo diretório. */
    /** @permission "fs" */
    mkdir(path: string): any;
    /** remove um diretório vazio. */
    /** @permission "fs" */
    rmdir(path: string): any;
    /** avalia se o caminho alvo é diretório ou arquivo. */
    /** @permission "fs" */
    isDirectory(path: string): any;
    /** @permission "fs" */
    isFile(arg0: number): any;
    /** devolve o tamanho físico total de um arquivo em bytes. */
    /** @permission "fs" */
    getFileSize(path: string): any;
    /** devolve métricas exatas de armazenamento da partição indicada. */
    /** @permission "fs" */
    getTotalSpace(drive: number): any;
    /** @permission "fs" */
    getUsedSpace(arg0: number): any;
    /** @permission "fs" */
    getFreeSpace(arg0: number): any;
    /** usa o motor criptográfico mbedtls acelerado por hardware para processar o arquivo em streaming e devolver seu hash MD5 preciso. */
    /** @permission "fs" */
    getFileMD5(path: string): any;
    /** dispara um remount/unmount SPI do cartão SD físico. */
    /** @permission "fs" */
    mountSD(): any;
    /** @permission "fs" */
    unmountSD(): void;
    /** @permission "fs" */
    copyFile(arg0: number, arg1: number): any;
    /** @permission "fs" */
    copyDirectory(arg0: number, arg1: number): any;
    /** @permission "fs" */
    removeDirectory(arg0: number): any;
    /** @permission "fs" */
    appData(): any;
};

declare const CelerLink: CelerLinkApi | undefined

interface CelerLinkApi {
    start(nome?: string, opcoes?: Record<string, any>): any;
    stop(): any;
    scan(timeoutMs?: number): any;
    connect(idOuNome: string, timeoutMs?: number): any;
    disconnect(): any;
    send(mensagem?: number): any;
    poll(): any;
    /** Envia a mensagem cifrada e autenticada ao peer conectado. Mensagem maior que o teto lança RangeError. (API 21) */
    sendSealed(mensagem?: number): any;
    /** O poll() comum nunca entrega quadros selados, e um selo que não confere é descartado pelo firmware — então o que sai daqui veio de quem pare (API 21) */
    pollSealed(): any;
    status(): any;
    verify(codigo: number): any;
    unpair(id?: string): any;
}

declare const CelerNet: {
    start(opcoes?: { name?: string; /** ignorado desde a API 37 */ net?: string; relay?: boolean }): boolean;
    stop(): boolean;
    broadcast(mensagem?: string | object, ttl?: number): boolean;
    send(destino: string, mensagem?: number, opcoes?: Record<string, any>): any;
    poll(): MeshMessage | null;
    nodes(): MeshNode[];
    status(): MeshStatus;
};

declare const Pack: {
    me(): any;
    members(): any;
    send(destino: string, mensagem?: number, opcoes?: Record<string, any>): any;
    poll(): any;
    handoffMusic(destino?: string): any;
    join(nome: string, senha: string): any;
    leave(): any;
    acceptInvite(on?: boolean): any;
    invite(): any;
    inviteStatus(): any;
    resources(tipo?: "mic" | "speaker" | "camera" | "data"): PackResource[];
    open(no: string, nome: string, opts?: object): number;
    status(h: number): PackSession | null;
    read(h: number): string | null;
    onEvent(h: number): { v: number; dir: "gt" | "lt"; at: number } | null;
    ruleAdd(regra?: { sensor: string; op: "gt" | "lt"; valor: number; h?: number; alvo?: string; no?: string; on?: boolean | number; notificar?: string }): number;
    ruleDel(id: number): boolean;
    ruleList(): Array<{ id: number; sensor: string; op: "gt" | "lt"; valor: number; h: number; alvo?: string; no?: string; on?: boolean; notificar?: string }>;
    write(h: number, dado?: string | object): boolean;
    close(h: number): void;
    expose(nome: string, opts?: { shared?: boolean }): boolean;
    unexpose(nome: string): boolean;
    publish(nome: string, dado?: string | object): number;
    sessions(nome: string): number;
    pollWrite(): { res: string; from: string; fromName: string; data: string } | null;
    listen(no?: string): number;
    speak(no?: string): number;
    record(no?: string, opts?: { ms?: number }): number;
    recording(h: number): boolean;
    level(): number;
    recordStop(h: number, opts?: { raw?: boolean; path?: string }): string | boolean | null;
    snap(no?: string, opts?: { path?: string; quality?: number }): number;
    view(no?: string, opts?: { fps?: number; quality?: number }): number;
    drawFrame(h: number, x: number, y: number): boolean;
};

declare const Phone: {
    status(): any;
    setEnabled(on?: boolean): void;
    music(cmd: number): any;
    musicInfo(): any;
    weather(): any;
    find(on?: boolean): any;
    forget(): void;
};

declare const Input: {
    /** @permission "input" */
    key(usage: number, mods: number, down: boolean): boolean;
    /** @permission "input" */
    poll(): { key: number; mods: number; down: boolean } | null;
    /** @permission "input" */
    move(x: number, y: number, buttons: number): void;
    /** @permission "input" */
    pointer(): { x: number; y: number; buttons: number };
    /** @permission "input" */
    clear(): void;
};

declare const USB: {
    /** @permission "usb" */
    devices(): Array<{ addr: number; vid: number; pid: number; cls: number; subcls: number; proto: number; speed: number; claimed: number[]; ifs: Array<{ n: number; alt: number; cls: number; subcls: number; proto: number; eps: Array<{ addr: number; type: number; mps: number; ivl: number }> }> }>;
    /** @permission "usb" */
    poll(): { type: "add" | "remove"; addr: number; vid: number; pid: number } | null;
    /** @permission "usb" */
    claim(addr: number, iface: number, alt?: number): boolean;
    /** @permission "usb" */
    release(addr: number, iface: number): boolean;
    /** @permission "usb" */
    controlIn(addr: number, bmRequestType: number, bRequest: number, wValue: number, wIndex: number, len: number, timeoutMs?: number): { ok: boolean; status: string; len: number; data: number[] };
    /** @permission "usb" */
    controlOut(addr: number, bmRequestType: number, bRequest: number, wValue: number, wIndex: number, data?: number[], timeoutMs?: number): { ok: boolean; status: string; sent: number };
    /** @permission "usb" */
    out(addr: number, ep: number, data?: number[], timeoutMs?: number): { ok: boolean; status: string; sent: number };
    /** @permission "usb" */
    in(addr: number, ep: number, len: number, timeoutMs?: number): { ok: boolean; status: string; len: number; data: number[] };
    /** @permission "usb+fs" */
    sendFile(addr: number, ep: number, path: string, maxBytes?: number, timeoutMs?: number): { ok: boolean; status: string; sent: number };
    /** @permission "usb" */
    listen(addr: number, ep: number, len: number, depth?: number): boolean;
    /** @permission "usb" */
    read(addr: number, ep: number): number[] | null;
    /** @permission "usb" */
    unlisten(addr: number, ep: number): boolean;
    /** @permission "usb" */
    flush(addr: number, ep: number): boolean;
};

declare const BLACK: number;
declare const WHITE: number;
declare const RED: number;
declare const GREEN: number;
declare const BLUE: number;
declare const YELLOW: number;
declare const CYAN: number;
declare const MAGENTA: number;
declare const ORANGE: number;
declare const DARKGREY: number;

