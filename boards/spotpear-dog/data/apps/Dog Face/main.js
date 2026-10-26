// CelerOS Dog Face — a cara do cao robotico (API 11)
// ES5 puro (Duktape). Desenhada para o OLED 128x64 do spotpear-dog: o canvas
// virtual 240x320 escala x0.53/y0.20, entao TEXTO e ilegivel — a interface e
// 100% iconografica (olhos, pupilas, barras). Coordenadas: helper P() mapeia
// fisico(128x64) -> virtual, para raciocinar em pixels reais do vidro.
//
// Tambem e o "cerebro" do robo: gaits das 4 perninhas (maquina de estados,
// um quadro por volta do loop) e servidor Celer Link (comandos JSON via BLE
// pelo app Celer Remote no SmartDisplay) com pareamento por codigo (API 11):
// quem conecta digita o codigo de 6 digitos que aparece na tela; controles
// ja pareados entram direto (hold 5s no touch pad esquece todos).
//
// Repertorio 2.0: SEQUENCIADOR de passos {do:...} que alimenta os truques
// nativos (dancinha sorteada, giro, patinha, xixi...), os truques que o
// dono ensina (/local/dogtricks.json) e a coreografia que a LLM compoe
// (dog_sequence) — mais latidos WAV, emocoes na cara/anel de LED e fala
// (bolha no vidro + texto inteiro no controle pareado).
//
// Tempo real: rampas e fases andam pelo millis() (dt de cada volta), nao
// por contagem de voltas — o flush do OLED por I2C a 100 kHz (~100 ms) e o
// micLevel variam o tempo da volta e antes esticavam/encolhiam o passo.

var T = System.theme();
var PW = 128, PH = 64;  // vidro fisico do OLED

function PX(x) { return Math.round(x * 240 / PW); }
function PY(y) { return Math.round(y * 320 / PH); }
function PW_(w) { return Math.round(w * 240 / PW); }
function PH_(h) { return Math.round(h * 320 / PH); }

// ------------------------------------------------------------ pernas ------
// Pinout JTAG (repo maikramer/zzpet-s3-dog): 17=frente-esq, 13=frente-dir,
// 18=tras-esq, 14=tras-dir. 90 graus = pe de boa (1500 us).
//
// MARCHA PORTADA DO ESP-Hi (Espressif/ESP Friends, componente
// servo_dog_ctrl, gitee.com/esp-friends/esp-hi): cao de 4 SG90 com UMA
// articulacao por perna — a mesma cinematica deste. Nada inventado aqui:
// as tabelas abaixo sao as macros do C (FL/FR/BL/BR_ANGLE_STEP_FORWARD /
// BACKWARD = neutro -/+ 20, STEP_OFFSET = 5) e cada fase e o mesmo laco
// "for (i = 0; i < 40; i++) angulo = inicio +/- i; delay(500/speed)" com o
// speed default do produto (80 -> 6 ms por grau).
//
// O que faz o passo do ESP-Hi andar: o pace alterna as metades e o
// STEP_OFFSET desloca a faixa do FR/BL em 5 graus (salto de ~10 graus na
// troca de fase) — a assimetria quebra o cancelamento dos atritos, e os
// pes curvos das pernas do ESP-Hi fazem o resto.
//
// Offsets sao crus em relacao ao neutro, na convencao de sinais do ESP-Hi
// (FL e BR "pra frente" = angulo menor; FR e BL = angulo maior).
//
// PERNAS DO ESP-HI (2026-10): as perninhas plasticas foram trocadas pelas
// do proprio ESP-Hi. A convencao FISICA deste corpo (decidida na bancada
// 2026-10-04 pelo repouso do hop: traseiras a 110/70 ficavam com os pes
// pra TRAS): ESQUERDAS angulo menor = pata pra FRENTE, DIREITAS angulo
// maior = pata pra FRENTE (SIDE abaixo). As observacoes anteriores (tesoura
// com o SIGN diagonal; 2+2 com o por lado) nao distinguiam as leituras —
// as duas batem com qualquer convencao que inverta FL/FR; o repouso
// separou. Com isso o SIGN certo do C para ca e por EIXO {+1,+1,-1,-1} e o
// pace do esphi pode voltar a ser calibrado (foi re-testado so com os
// SIGNs errados).
//
// CALIBRACAO: mande {"type":"calib"} pelo Celer Remote/nRF Connect — as
// QUATRO patas (FL, FR, BL, BR, nessa ordem) devem ir 25 graus pra FRENTE
// e voltar. Todas pra tras de uma vez = {"type":"tune","flip":true} (vale
// pra creep, esphi e posturas); pata individual errada = inverta o SIGN
// dela. Postura = tune leanF/leanR por eixo (abaixo); trim individual =
// tune "trim" (+ = frente, como o set_leg_offset do C); ritmo = tune
// "speed" (20..250, default 80 do C).
// Historico da postura (2026-10-03): a derivacao pelo fonte do ESP-Hi
// (instalacao em linha a 0/180, neutro 70/110 = 20 graus antes da
// vertical) dava as 4 pernas inclinadas ~20 graus pra frente; no nosso
// corpo isso abaixava a frente e o hop caia DE BOCA — o repouso agora e
// por EIXO (frente ereta). O pace do ESP-Hi com pernas inclinadas segue
// documentado acima p/ quando a montagem das dobras em L for conferida.
// Postura de REPOUSO por EIXO (bench 2026-10-04: frente toda inclinada pra
// frente fazia o robo cair DE BOCA — repouso agora e frente ERETA): eixo
// dianteiro vertical (leanF 0 = frente no maximo de altura) e traseiras
// 20 graus pra frente (leanR 20, a postura do hop). O "lean" antigo seta os
// dois eixos de uma vez (compat); leanF/leanR afinam cada um ao vivo:
// {"type":"tune","leanF":0,"leanR":20}.
// DIRECAO FISICA VALIDADA NA BANCADA (2026-10-04): nas ESQUERDAS angulo
// MENOR = pata pra FRENTE; nas DIREITAS angulo MAIOR = pata pra FRENTE
// (traseiras a 110/70 ficavam com os pes pra TRAS — o contrario do que se
// lia na observacao antiga do "por lado", que nao distinguia qual par ia
// pra onde). SIDE e o sinal de "frente" no angulo de cada perna.
var SIDE = { FL: -1, FR: 1, BL: -1, BR: 1 };
var LEAN = 20;   // legacy: tune "lean" inclina os dois eixos juntos
var LEAN_F = 0;  // eixo dianteiro: inclinacao fisica pra frente (0 = vertical)
var LEAN_R = 25; // eixo traseiro: inclinacao fisica pra frente (bancada: +5 p/ mais impulso no chute)
var TRIM = { FL: 0, FR: 0, BL: 0, BR: 0 };  // trim por perna: + = pata pra frente (set_leg_offset do C)
var NEUTRAL = { FL: 90, FR: 90, BL: 70, BR: 110 };   // = 90 + SIDE*(lean do eixo + TRIM)
function applyStance() {
    NEUTRAL.FL = 90 + SIDE.FL * (LEAN_F + TRIM.FL);
    NEUTRAL.FR = 90 + SIDE.FR * (LEAN_F + TRIM.FR);
    NEUTRAL.BL = 90 + SIDE.BL * (LEAN_R + TRIM.BL);
    NEUTRAL.BR = 90 + SIDE.BR * (LEAN_R + TRIM.BR);
    if (!legsLimp) legsHold();   // ja reescreve a postura nova
}
function setLean(l) { LEAN = l; LEAN_F = l; LEAN_R = l; applyStance(); }
var PIN = { FL: 17, FR: 13, BL: 18, BR: 14 };
var KEYS = ["FL", "FR", "BL", "BR"];
// SIGN converte a convencao do C (FL/BR menor = frente; FR/BL maior =
// frente) para a fisica DESTE corpo (SIDE acima): +1/+1/-1/-1, POR EIXO.
// Com o SIGN por lado das rodadas anteriores o pace girava sem andar —
// as duas primeiras observacoes da bancada (tesoura e 2+2) nao distinguiam
// as duas leituras; a traseira do repouso (2026-10-04) decidiu.
var SIGN = { FL: 1, FR: 1, BL: -1, BR: -1 };
var FLIP = 1;  // -1 = inverte a direcao fisica de TUDO (tune "flip", bancada)

// API 10: servos moram no sub-objeto gpio (desligavel por Kconfig)
var SERVO = (typeof System.gpio !== "undefined" && System.gpio.servo)
    ? System.gpio.servo : null;
System.print('[dog] servo api: ' + (SERVO ? 'ok' : 'NULL'));

var servoFails = 0;
var failLogged = 0;

function leg(pin, angle) {
    if (!SERVO) return;
    if (!SERVO(pin, angle)) {
        servoFails++;
        if (failLogged < 12) { System.print('[dog] servo FAIL pin ' + pin + '@' + angle); failLogged++; }
    }
}

var off = { FL: 0, FR: 0, BL: 0, BR: 0 };     // offset atual por perna
var target = { FL: 0, FR: 0, BL: 0, BR: 0 };  // alvo das posturas (rampa)
var sent = { FL: -1, FR: -1, BL: -1, BR: -1 };  // ultimo angulo escrito

function put(k, o) {
    off[k] = o;
    var a = Math.round(NEUTRAL[k] + FLIP * SIGN[k] * o);
    if (a !== sent[k]) {
        sent[k] = a;
        leg(PIN[k], a);
    }
}

// Reescreve a pose atual (servo solto depois do sono nao sabe onde esta).
function legsHold() {
    for (var i = 0; i < KEYS.length; i++) {
        sent[KEYS[i]] = -1;
        put(KEYS[i], off[KEYS[i]]);
    }
}

// Solta os servos (sem torque = sem corrente de sustentacao).
var legsLimp = false;
function legsRelease() {
    if (legsLimp || !System.gpio || !System.gpio.servoOff) return;
    for (var i = 0; i < KEYS.length; i++) System.gpio.servoOff(PIN[KEYS[i]]);
    legsLimp = true;
}

// ---- tabelas do ESP-Hi ----
// speed e o unico ritmo do produto (step_delay_ms = 500/speed, divisao
// inteira como no C; 80 = default -> 6 ms/grau). Ao vivo:
// {"type":"tune","speed":20..250} — vale na proxima fase e fica salvo.
var SPEED = 80;
var STEP_MS = 6;       // = 500 / SPEED
function setSpeed(s) { SPEED = s; STEP_MS = (500 / s) | 0; }
var STEP_N = 40;       // graus varridos por fase
var PAUSE_MS = 50;     // pausa entre fases (andar pra frente/tras)
var S = 5;             // STEP_OFFSET
var F = { FL: -20, FR: 20, BL: 20, BR: -20 };   // *_ANGLE_STEP_FORWARD - neutro
var B = { FL: 20, FR: -20, BL: -20, BR: 20 };   // *_ANGLE_STEP_BACKWARD - neutro

// Fase = [[inicio FL, FR, BL, BR], [passo por grau FL, FR, BL, BR]]:
// angulo(i) = inicio + passo * i, i = 0..39. Transcricao linha a linha de
// servo_dog_forward/backward/turn_left/turn_right.
var WALKS = {
    walk: { pause: true, phases: [
        [[B.FL, F.FR - S, B.BL - S, F.BR], [-1, -1, +1, +1]],
        [[F.FL, B.FR + S, F.BL + S, B.BR], [+1, +1, -1, -1]]
    ]},
    back: { pause: true, phases: [
        [[F.FL - S, B.FR, F.BL, B.BR - S], [+1, +1, -1, -1]],
        [[B.FL + S, F.FR, B.BL, F.BR + S], [-1, -1, +1, +1]]
    ]},
    left: { pause: false, phases: [
        [[B.FL + S, B.FR, B.BL, B.BR + S], [-1, +1, +1, -1]],
        [[F.FL - S, F.FR, F.BL, F.BR - S], [+1, -1, -1, +1]]
    ]},
    right: { pause: false, phases: [
        [[F.FL, F.FR + S, F.BL + S, F.BR], [+1, -1, -1, +1]],
        [[B.FL - S, B.FR, B.BL, B.BR - S], [-1, +1, +1, -1]]
    ]}
};

// Posturas (alvo da rampa), transcricao do servo_dog_ctrl.c: lay_down varre
// 60 graus; bow/lean_back varrem BOW_OFFSET = 50 (macro real do C — o 30
// daqui era chute de quando o fonte ainda nao tinha sido lido).
var BOW = 50;
var POSES = {
    stand: [0, 0, 0, 0],
    lie: [-60, 60, 60, -60],            // servo_dog_lay_down
    stretch: [-BOW, BOW, -BOW, BOW],    // servo_dog_bow (play bow)
    sit: [BOW, -BOW, BOW, -BOW],        // servo_dog_lean_back
    // Repertorio 2.0 (mesma convencao de offsets; angulos de partida para
    // validar/afinar no vidro pela bancada):
    beg: [65, -65, 55, -55],        // sentado ereto: dobra mais a dianteira
    crouch: [30, -30, -30, 30],     // agachado (4 encurtadas): base do pushup
    pee: [55, -5, 10, -25],         // xixi: encurta a FL (ergue o canto BR)
    shake_hi: [-40, -50, 50, -50],  // sentado oferecendo a pata FL (alta)
    shake_lo: [-52, -50, 50, -50]   // ...e abanando (baixa)
};
var RATE = 6;   // graus por 60 ms nas posturas (lay_down: 1 grau / 10 ms)

// Varredura de UMA fase, bloqueante (~240 ms): igual ao laco do C. O
// relogio manda: se uma volta atrasar (GC), o proximo grau sai no ponto
// certo da reta em vez de acumular atraso.
function runPhase(ph) {
    var st = ph[0], dv = ph[1];
    var t0 = System.millis();
    for (var i = 0; i < STEP_N; i++) {
        put("FL", st[0] + dv[0] * i);
        put("FR", st[1] + dv[1] * i);
        put("BL", st[2] + dv[2] * i);
        put("BR", st[3] + dv[3] * i);
        var wait = t0 + (i + 1) * STEP_MS - System.millis();
        if (wait > 0) System.delay(wait);
    }
}

// Volta ao neutro como o fim de servo_dog_forward: 20 passos de STEP_MS.
function settle() {
    var from = [off.FL, off.FR, off.BL, off.BR];
    for (var i = 1; i <= 20; i++) {
        var f = 1 - i / 20;
        put("FL", from[0] * f);
        put("FR", from[1] * f);
        put("BL", from[2] * f);
        put("BR", from[3] * f);
        System.delay(STEP_MS);
    }
    for (var k = 0; k < KEYS.length; k++) target[KEYS[k]] = 0;
}

// Postura: rampa pelo relogio (nao bloqueia a cara).
function legTick(dt) {
    var step = RATE * dt / 60;
    for (var i = 0; i < KEYS.length; i++) {
        var k = KEYS[i];
        var d = target[k] - off[k];
        if (d > step) d = step;
        else if (d < -step) d = -step;
        if (d !== 0) put(k, off[k] + d);
    }
}

function setPose(p) {
    target.FL = p[0]; target.FR = p[1]; target.BL = p[2]; target.BR = p[3];
}

var gait = null, gaitName = "", gaitPhase = 0, repeatGait = false;
var moveDir = null;   // direcao corrente do movimento (olhos acompanham)
// Dono da gait: "move" do link exige keepalive (linkDrive); gait repetida
// pedida pelo link para se o link cair (linkGait). Gait do pad nao depende
// de link nenhum.
var linkDrive = false, linkGait = false;

function walking() { return gait !== null; }

// name: walk/back/left/right (ciclicas, ESP-Hi) ou uma postura de POSES.
// repeat: ciclica segue ate stop; sem repeat anda 2 ciclos (repeat_count
// default do ESP-Hi) e volta ao neutro.
var cyclesLeft = 0;
function startGait(name, repeat) {
    if (!WALKS[name] && !POSES[name] && name !== "hop") return false;
    linkDrive = false;
    linkGait = false;
    if (legsLimp) { legsLimp = false; legsHold(); }
    if (WALKS[name] || name === "hop") {
        if (gait !== null && gaitName === name) {
            repeatGait = repeatGait || !!repeat;
            return true;  // mesma marcha em curso: nao reinicia o passo no meio
        }
        // hop: quadros do pulo (empina/abre/puxa/recolhe). Como MARCHA
        // (walkMode hop): frente = hop, tras = hop reverso, giros = esphi
        if (name === "hop") gait = { frames: true, hop: true, d: 1, list: null };
        else if (walkMode === "hop") {
            gait = (name === "walk") ? { frames: true, hop: true, d: 1, bias: 0, list: null }
                : (name === "back") ? { frames: true, hop: true, d: -1, bias: 0, list: null }
                : (name === "left") ? { frames: true, spin: true, d: 1, list: null }
                : (name === "right") ? { frames: true, spin: true, d: -1, list: null }
                : WALKS[name];
        }
        else gait = walkMode === "creep" ? { frames: true, d: DIRS[name], list: null } : WALKS[name];
        gaitPhase = 0;
        cyclesLeft = 2;
    } else {
        if (gait !== null) settle();
        gait = null;
        setPose(POSES[name]);
    }
    gaitName = name;
    repeatGait = !!repeat;
    moveDir = (name === "back" || name === "left") ? -1 :
              (name === "walk" || name === "right" || name === "hop") ? 1 : null;
    return true;
}

function stopGait() {
    linkDrive = false;
    linkGait = false;
    repeatGait = false;
    if (gait !== null) settle();
    else setPose(POSES.stand);
    gait = null;
    gaitName = "";
    moveDir = null;
}

// Duracao de UM ciclo da marcha corrente na direcao name — para converter o
// "N passos" da voz em ms. Espelha o gait que startGait(name) escolheria
// (hop frente/tras, creep, ou as fases esphi), somando os ms do tune ao vivo.
function gaitCycleMs(name) {
    var i, t = 0;
    if (walkMode === "hop" && (name === "walk" || name === "back")) {
        var hf = hopFrames(name === "back" ? -1 : 1);
        for (i = 0; i < hf.length; i++) t += hf[i].ms;
        return t;
    }
    if (walkMode === "creep") {
        var cf = creepFrames(DIRS[name]);
        for (i = 0; i < cf.length; i++) t += cf[i].ms;
        return t;
    }
    return 2 * (STEP_N * STEP_MS) + (WALKS[name] && WALKS[name].pause ? 2 * PAUSE_MS : 0);
}

// Uma volta do loop: marcha = UMA fase inteira (bloqueante, ~240-290 ms,
// o link e a cara rodam entre as fases); postura = rampa por dt.
function gaitTick(dt) {
    if (legsLimp) return;
    if (!gait) {
        legTick(dt);
        return;
    }
    var len;
    if (gait.frames) {
        if (gaitPhase === 0 || !gait.list) gait.list = gait.hop ? hopFrames(gait.d, gait.bias)
            : (gait.spin ? spinFrames(gait.d) : creepFrames(gait.d));
        runFrame(gait.list[gaitPhase]);
        len = gait.list.length;
    } else {
        runPhase(gait.phases[gaitPhase]);
        if (gait.pause) System.delay(PAUSE_MS);
        len = gait.phases.length;
    }
    gaitPhase++;
    if (gaitPhase >= len) {
        gaitPhase = 0;
        if (!repeatGait && --cyclesLeft <= 0) stopGait();
    }
}

// Calibracao: cada perna vai 25 graus pra FRENTE fisica (a mesma "frente"
// da marcha centopeia, via putA) e volta, na ordem FL, FR, BL, BR. Pata
// indo pra tras = inverta o FWD dela; todas pra tras = {"type":"tune","flip":true}.
function calibrate() {
    if (gait !== null) stopGait();
    if (legsLimp) { legsLimp = false; legsHold(); }
    for (var i = 0; i < KEYS.length; i++) {
        var k = KEYS[i];
        System.print('[dog] calib ' + k + ' (pino ' + PIN[k] + ') pra frente');
        for (var a = 1; a <= 25; a++) { putA(k, a); System.delay(20); }
        System.delay(600);
        for (var b = 24; b >= 0; b--) { putA(k, b); System.delay(20); }
        System.delay(300);
    }
}

// ---------------------------------------------- marcha centopeia ------
// Convencao FISICA: a > 0 = pata pra FRENTE (rumo ao focinho), 0 = perna
// vertical. putA com a>0: esquerdas DESCem e direitas SOBem no angulo —
// a frente fisica validada na bancada (SIDE), com o flip global no put.
//
// Fisica da perna de 1 articulacao: altura do quadril = L * cos(a). Perna
// vertical = mais comprida; inclinada = mais curta. Nao da pra "levantar"
// uma pata, mas da pra ENCURTAR um canto: o corpo gira sobre a diagonal e
// o canto OPOSTO sobe. Encurtar o traseiro-esq ergue o dianteiro-dir (o
// corpo pivota na diagonal FL-BR), e vice-versa:
//
//   pata a mover   canto encurtado (diagonal oposta)
//   FR             BL
//   FL             BR
//   BL             FR
//   BR             FL
//
// Ciclo (d = +1 empurra o corpo pra frente, -1 pra tras; por perna):
//   1. REMADA: as 4 patas no chao varrem de +P*d a -P*d juntas — o atrito
//      de todas empurra pro mesmo lado e o corpo avanca ~2*L*sin(P).
//   2. RECUPERACAO, uma pata por vez (ordem configuravel, default
//      BL, FL, BR, FR = creep classico): inclina o canto oposto mais T
//      graus (encurta, a pata alvo sai do chao), leva a pata alvo de volta
//      a +P*d no ar, desinclina (a pata pousa na frente).
// Movimento quase estatico, lento e robusto; nada empurra pra tras.
//
// Historico: no putA com o sinal literal de F do ESP-Hi a pata erguida
// POUSAVA ATRAS (validado no cao na 1.3) — por isso FWD ficou invertido em
// relacao a F, com o SIGN compensando no caminho contrario; o produto dos
// dois reproduz os angulos do C fielmente.
var FWD = { FL: -1, FR: 1, BL: 1, BR: -1 };
function putA(k, a) { put(k, FWD[k] * a); }
function angA(k) { return FWD[k] * off[k]; }

var UNLOAD = { FR: "BL", FL: "BR", BL: "FR", BR: "FL" };
var CREEP = { P: 20, T: 25, power: 600, tilt: 180, swing: 240, order: ["BL", "FL", "BR", "FR"] };
var DIRS = {
    walk: { FL: 1, FR: 1, BL: 1, BR: 1 },
    back: { FL: -1, FR: -1, BL: -1, BR: -1 },
    left: { FL: -1, FR: 1, BL: -1, BR: 1 },    // lado direito empurra, esquerdo recua
    right: { FL: 1, FR: -1, BL: 1, BR: -1 }
};
var WALK_MODES = ["creep", "esphi", "hop"];
// Marchas que o botao do Remote alterna (tel.modes — o Remote so ecoa a
// lista do robo, nada de marcha endurecida no controle). Default = HOP
// desde 2026-10-04: e a unica marcha VALIDADA no vidro com as pernas novas
// (oficial plan_hop4 #13). Seta pra cima = hop; baixo = hop REVERSO
// (coreografia negada); esquerda/direita = giros das tabelas esphi. O
// esphi (pace do ESP-Hi, SIGN por eixo agora correto) e o creep ficam como
// alternativas para re-calibrar.
var MODES_OK = ["hop", "creep", "esphi"];
var walkMode = "hop";
var FRAME_STEP_MS = 10;

function copyPose(p) { return { FL: p.FL, FR: p.FR, BL: p.BL, BR: p.BR }; }

// Quadros de UM ciclo: [{p: pose fisica, ms}]. Refeito a cada ciclo para
// o tune ao vivo valer ja no proximo passo.
function creepFrames(d) {
    var P = CREEP.P, T = CREEP.T, fr = [];
    var a0 = {}, a1 = {};
    for (var i = 0; i < KEYS.length; i++) {
        a0[KEYS[i]] = P * d[KEYS[i]];
        a1[KEYS[i]] = -P * d[KEYS[i]];
    }
    fr.push({ p: copyPose(a1), ms: CREEP.power });           // 1. remada
    var cur = copyPose(a1);
    for (var j = 0; j < CREEP.order.length; j++) {           // 2. recuperacao
        var k = CREEP.order[j], u = UNLOAD[k];
        var tilt = copyPose(cur);
        tilt[u] = cur[u] + (cur[u] >= 0 ? T : -T);            // encurta o canto oposto
        fr.push({ p: tilt, ms: CREEP.tilt });
        var swing = copyPose(tilt);
        swing[k] = a0[k];                                     // pata alvo vai a frente no ar
        fr.push({ p: swing, ms: CREEP.swing });
        cur = copyPose(swing);
        cur[u] = tilt[u] - (cur[u] >= 0 ? T : -T);           // desinclina: pata pousa
        fr.push({ p: copyPose(cur), ms: CREEP.tilt });
    }
    return fr;
}

// Interpola da pose atual ate fr.p em fr.ms (bloqueante, passo de 10 ms,
// guiado pelo relogio como o runPhase). fr.dly opcional atrasa a partida
// de pernas especificas DENTRO do quadro (a pata espera dly ms parada e
// varre o restante ate o fim do quadro) — e o que faz a abertura das
// dianteiras comecar milissegundos depois do INICIO do chute traseiro,
// ainda no ar, em vez de esperar o chute acabar (bench: esperando, o robo
// ja tinha pousado e a abertura arrastava no chao).
function runFrame(fr) {
    var from = { FL: angA("FL"), FR: angA("FR"), BL: angA("BL"), BR: angA("BR") };
    var n = Math.max(1, Math.round(fr.ms / FRAME_STEP_MS));
    var t0 = System.millis();
    for (var i = 1; i <= n; i++) {
        var t = i * FRAME_STEP_MS;
        for (var q = 0; q < KEYS.length; q++) {
            var k = KEYS[q];
            var d = fr.dly && fr.dly[k] ? fr.dly[k] : 0;
            var f = t <= d ? 0 : Math.min(1, (t - d) / (fr.ms - d));
            putA(k, from[k] + (fr.p[k] - from[k]) * f);
        }
        var wait = t0 + t - System.millis();
        if (wait > 0) System.delay(wait);
    }
}

// ---------------------------------------------- marcha pulo (hop) ---------
// Locomocao por DINAMICA, sem depender do ratchet do pe: o chute rapido
// das traseiras empina o corpo, as dianteiras avancam no ar, na queda elas
// ancoram la na frente e a puxada rapida arrasta o corpo (a familia do
// servo_dog_jump_forward do C). Convencao FISICA (putA): + = pata pra
// frente. Roda no motor de quadros do creep; a lista e refeita a cada
// ciclo, entao o tune vale ja no pulo seguinte. Afinavel ao vivo:
//   {"type":"tune","hop":{...}}
//   prep   = angulo das DIANTEIRAS PRA TRAS na posicao inicial (o "pronto"
//            encolhido: dianteiras tras + traseiras frente — bancada: da o
//            coiled look sem abaixar demais o corpo; nao exagerar)
//   rear   = angulo INICIAL das traseiras PRA FRENTE (mais range no chute;
//            o "recolhe" do fim do ciclo volta pra aqui)
//   kick   = ate onde atras as traseiras chicoteiam (o chute que empina)
//   front  = quanto as dianteiras avancam no ar (varre de -prep ate +front)
//   pull   = ate onde atras as dianteiras puxam o corpo
//   msDeg  = velocidade dos movimentos (ms por grau; 0 = estalo no maximo)
//   air    = defasagem da ABERTURA contra o chute traseiro. POSITIVO:
//            dianteiras partem air ms DEPOIS do chute; NEGATIVO: partem
//            |air| ms ANTES (bancada 2026-10-04: com 0 o conjunto parecia
//            SEQUENCIAL — sob carga o traseiro aparece primeiro e a
//            dianteira chegava atrasada; ela tem de LIDERAR. Default -50;
//            plan_hop2 ja tinha mostrado que atrasos GRANDES perdem o ar)
//   fall    = queda: hold ate o corpo descer sobre as dianteiras plantadas
//   land    = POUSO: hold firme com as dianteiras plantadas pra frente
//            antes do chute delas (contato garantido no chao)
//   settle = espera pos-chute-dianteiro (corpo deslizando) antes de recolher
//   rest   = REPOUSO no fim do ciclo (em pe, frente ereta): o corpo tem de
//            tocar o chao e assentar ANTES do proximo chute (bench: sem
//            isso o robo caia de bochecha no inicio do loop seguinte)
// OFICIAL (plan_hop4 #13 + axugos 2026-10-04): 660 ms/ciclo; air -50
// (dianteira lidera) e leanR 25 (traseiras do repouso 5 graus mais pra
// frente — pedido da bancada). Esperas curtas DEMAIS plantavam bananeira.
//   turn   = assimetria por LADO para VIRAR (gait left/right do modo hop):
//            % de diferenca entre os lados em TODAS as amplitudes — um lado
//            da o pulo cheio, o outro um pulo menor; o empuxo desigual
//            guina e as dianteiras plantam tortas ancorando o giro
var HOP = { prep: 20, rear: 40, kick: 50, front: 40, pull: 35, msDeg: 0,
            air: -50, fall: 120, land: 60, settle: 100, rest: 200, spin: 90 };

// spinFrames: VIRAR DE BARRIGA (receita da bancada 2026-10-04 — o hop
// assimetrico nao girou). Ciclo: (1) ESTICA torcido — esquerdas atras,
// direitas a frente — o corpo bate de barriga no chao (perna horizontal nao
// sustenta; atrito de barriga e baixo); (2) GOLPE rapido: as ESQUERDAS
// varrem pra FRENTE e as DIREITAS pra TRAS ao mesmo tempo (sentidos
// opostos) — a reacao gira o corpo deitado; (3) recolhe LENTO ate em pe
// (varredura devagar nao gira de volta; o "rest" e a duracao desse recolhe)
// e assenta pro proximo ciclo. d=-1 espelha (golpe pro outro lado). Nos
// extremos o servo satura no fim de curso — e o "esticar" pedido.
function spinFrames(dir) {
    var d = dir || 1, s = HOP.spin, m = HOP.msDeg;
    function ms(deg, extra) { return Math.max(60, Math.round(m * deg) + (extra || 0)); }
    return [
        { p: { FL: -s * d, FR: s * d, BL: -s * d, BR: s * d }, ms: ms(2 * s, HOP.fall) },   // estica: barriga no chao
        { p: { FL: s * d, FR: -s * d, BL: s * d, BR: -s * d }, ms: ms(2 * s, HOP.settle) }, // GOLPE: lados opostos
        { p: { FL: 0, FR: 0, BL: 0, BR: 0 }, ms: Math.max(500, HOP.rest * 3) },             // recolhe LENTO e levanta
        { p: { FL: 0, FR: 0, BL: 0, BR: 0 }, ms: HOP.land }                                 // assenta antes do proximo
    ];
}

// hopFrames(dir, bias): dir -1 = hop reverso; bias (assimetria por lado)
// fica DORMENTE apos o giro virar spinFrames (bancada: o hop assimetrico
// nao girava) — walk/back passam 0.
function hopFrames(dir, bias) {
    var d = dir || 1;   // -1 = hop REVERSO (seta pra tras): coreografia espelhada
    var t = bias || 0;
    var mL = 1 - t, mR = 1 + t;   // multiplicador das pernas esquerdas/direitas
    var b = HOP.prep, r = HOP.rear, k = HOP.kick, f = HOP.front, p = HOP.pull, m = HOP.msDeg;
    function ms(deg, extra) { return Math.max(60, Math.round(m * deg) + (extra || 0)); }
    // chute e abertura NUM quadro so. air < 0: dianteiras LIDERAM (o atraso
    // cai nas traseiras); air > 0: traseiras na frente e abertura atrasada
    var air = Math.round(HOP.air);
    var abre = Math.abs(air) + Math.max(ms(r + k), ms(f + b));
    var dly = null;
    if (air > 0) dly = { FL: air, FR: air };
    else if (air < 0) dly = { BL: -air, BR: -air };
    return [
        { p: { FL: -b * d * mL, FR: -b * d * mR, BL: r * d * mL, BR: r * d * mR }, ms: ms(r + b + 40) },          // pronto: encolhido
        { p: { FL: -b * d * mL, FR: -b * d * mR, BL: -k * d * mL, BR: -k * d * mR }, dly: dly, ms: abre },        // CHUTE + ABRE no ar
        { p: { FL: f * d * mL, FR: f * d * mR, BL: -k * d * mL, BR: -k * d * mR }, ms: HOP.fall + HOP.land },     // queda + pouso plantado
        { p: { FL: -p * d * mL, FR: -p * d * mR, BL: -k * d * mL, BR: -k * d * mR }, ms: ms(f + p, HOP.settle) }, // CHUTE DIANTEIRO: puxa o corpo
        { p: { FL: 0, FR: 0, BL: 0, BR: 0 }, ms: ms(k + 40) },                     // repouso: em pe (frente ereta)
        { p: { FL: 0, FR: 0, BL: 0, BR: 0 }, ms: HOP.rest }                        // assenta antes do proximo ciclo
    ];
}

// ---- ajuste ao vivo ({"type":"tune",...}) e persistencia ----
var TUNE_FILE = "/local/dogtune.json";
// esphi4: hop OFICIAL plan_hop4 #13 (660 ms/ciclo) — descarta o dogtune da
// sessao de testes (a ultima combinacao testada ficou salva)
var TUNE_LEGS = "esphi4";

function clampNum(v, lo, hi, dflt) {
    v = Number(v);
    if (!(v >= lo)) return dflt;  // NaN/undefined tambem
    return v > hi ? hi : v;
}

function applyTune(t) {
    if (!t) return;
    CREEP.P = clampNum(t.P, 5, 45, CREEP.P);
    CREEP.T = clampNum(t.T, 0, 50, CREEP.T);
    CREEP.power = clampNum(t.power, 60, 3000, CREEP.power);
    CREEP.tilt = clampNum(t.tilt, 30, 3000, CREEP.tilt);
    CREEP.swing = clampNum(t.swing, 30, 3000, CREEP.swing);
    if (t.order && t.order.length === 4) {
        var seen = {}, ok = true;
        for (var i = 0; i < 4; i++) {
            if (UNLOAD[t.order[i]] === undefined || seen[t.order[i]]) ok = false;
            seen[t.order[i]] = true;
        }
        if (ok) CREEP.order = [t.order[0], t.order[1], t.order[2], t.order[3]];
    }
    if (t.flip === true) FLIP = -FLIP;   // alterna a direcao fisica de tudo
    else if (t.flip === 1 || t.flip === -1) FLIP = t.flip;
    if (t.lean !== undefined) setLean(clampNum(t.lean, 0, 40, LEAN));
    if (t.speed !== undefined) setSpeed(clampNum(t.speed, 20, 250, SPEED));
    if (t.trim) {
        for (var q = 0; q < KEYS.length; q++) {
            var tk = KEYS[q];
            if (t.trim[tk] !== undefined) TRIM[tk] = clampNum(t.trim[tk], -15, 15, TRIM[tk]);
        }
        applyStance();
    }
    if (t.hop) {
        HOP.prep = clampNum(t.hop.prep, 0, 40, HOP.prep);
        HOP.rear = clampNum(t.hop.rear, 0, 50, HOP.rear);
        HOP.kick = clampNum(t.hop.kick, 0, 60, HOP.kick);
        HOP.front = clampNum(t.hop.front, 0, 50, HOP.front);
        HOP.pull = clampNum(t.hop.pull, 0, 50, HOP.pull);
        HOP.msDeg = clampNum(t.hop.msDeg, 0, 20, HOP.msDeg);
        HOP.air = clampNum(t.hop.air, -200, 800, HOP.air);
        HOP.fall = clampNum(t.hop.fall, 0, 1200, HOP.fall);
        HOP.land = clampNum(t.hop.land, 0, 600, HOP.land);
        HOP.settle = clampNum(t.hop.settle, 0, 800, HOP.settle);
        HOP.rest = clampNum(t.hop.rest, 0, 2000, HOP.rest);
        HOP.spin = clampNum(t.hop.spin, 40, 110, HOP.spin);
    }
    if (t.leanF !== undefined) { LEAN_F = clampNum(t.leanF, 0, 40, LEAN_F); applyStance(); }
    if (t.leanR !== undefined) { LEAN_R = clampNum(t.leanR, 0, 40, LEAN_R); applyStance(); }
    if (t.mode && WALK_MODES.indexOf(t.mode) >= 0) walkMode = t.mode;
}

function saveTune() {
    if (typeof FS === "undefined" || !FS.writeTextFile) return;
    try {
        FS.writeTextFile(TUNE_FILE, JSON.stringify({
            legs: TUNE_LEGS, lean: LEAN, leanF: LEAN_F, leanR: LEAN_R,
            speed: SPEED, trim: TRIM, hop: HOP,
            P: CREEP.P, T: CREEP.T, power: CREEP.power, tilt: CREEP.tilt,
            swing: CREEP.swing, order: CREEP.order, mode: walkMode, flip: FLIP
        }));
    } catch (e) {}
}

function loadTune() {
    if (typeof FS === "undefined" || !FS.exists || !FS.exists(TUNE_FILE)) return;
    try {
        var t = JSON.parse(FS.readTextFile(TUNE_FILE));
        // o P/T/flip/mode salvos com as pernas do ZZPET nao valem mais:
        // so aplica o que foi gravado com as pernas atuais (TUNE_LEGS)
        if (t && t.legs === TUNE_LEGS) applyTune(t);
    } catch (e) {}
}
loadTune();

// ------------------------------------------- repertorio 2.0 -----------------
// Truques coreografados, latidos de verdade (WAVs do app, gerados por
// tools/dog/barks.py), emocoes (cara + anel de LED) e o SEQUENCIADOR: a
// maquina que roda uma fila de passos {do:...} no ritmo do loop principal.
// A mesma fila alimenta os truques nativos (TRICKS), os truques que o dono
// ensina (/local/dogtricks.json) e a coreografia que a LLM compoe na hora
// (dog_sequence). Tudo clampado: atos fora da whitelist sao descartados, a
// fila nao passa de 12 passos nem de 12 s de relogio.

// ---- latidos ----
// Latidos em assets/bark_*.qoa (decoder QOA do firmware, ~60 linhas):
// 5x menores que WAV; sem suporte (firmware velho) playWav devolve false e
// cai na melodia do playTone.
var BARK_DIR = "/local/apps/Dog Face/assets/";
var BARKS = ["woof", "yip", "growl", "whine", "howl"];
var BARK_FALLBACK = {  // sem WAV (imagem antiga): melodia aproximada
    woof: [[220, 90], [150, 130]],
    yip: [[900, 50], [600, 70]],
    growl: [[110, 160], [95, 180], [110, 160]],
    whine: [[900, 160], [1250, 220], [800, 260]],
    howl: [[420, 300], [560, 720], [500, 260]]
};
function playBark(kind, n) {
    if (BARKS.indexOf(kind) < 0) kind = "woof";
    n = Math.round(clampNum(n, 1, 3, 1));
    for (var i = 0; i < n; i++) {
        var played = false;
        try { played = System.playWav(BARK_DIR + "bark_" + kind + ".qoa"); } catch (e) { played = false; }
        if (!played) System.playTone(BARK_FALLBACK[kind]);
        if (i + 1 < n) System.delay(140);
    }
}

// ---- anel de LED (2 fitas x 4) ----
var ledAnim = "off", ledAt = 0, ledFrame = 0;
var LED_COLORS = { happy: 0x20C020, alert: 0xFF2000, heart: 0xE02070,
                   listen: 0x0040FF, err: 0xFF2000, calm: 0x00A0A0 };
function ledDim(c, f) {
    return ((Math.round(((c >> 16) & 255) * f) << 16) |
            (Math.round(((c >> 8) & 255) * f) << 8) | Math.round((c & 255) * f));
}
function ledHsv(h) {   // h 0..1 -> 0xRRGGBB (arco-iris da dancinha)
    var i = Math.floor(h * 6), f = h * 6 - i;
    var v = 0.65, p = 0, q = v * (1 - f);
    var r = 0, g = 0, b = 0;
    var m = i % 6;
    if (m === 0) { r = v; g = v * f; }
    else if (m === 1) { r = q; g = v; }
    else if (m === 2) { g = v; b = v * f; }
    else if (m === 3) { g = q; b = v; }
    else if (m === 4) { r = v * f; b = v; }
    else { r = v; b = p; }
    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}
function setLeds(anim) {
    if (ledAnim === anim) return;
    ledAnim = anim;
    ledFrame = 0;
    if (anim === "off") { System.neopixel(0, [0, 0, 0, 0]); System.neopixel(1, [0, 0, 0, 0]); }
}
function ledsOff() { setLeds("off"); }
function ledTick(now) {   // um quadro a cada 120 ms
    if (ledAnim === "off" || now - ledAt < 120) return;
    ledAt = now;
    ledFrame++;
    var solid = LED_COLORS[ledAnim];
    for (var s = 0; s < 2; s++) {
        var px = [];
        for (var i = 0; i < 4; i++) {
            var c = 0;
            if (ledAnim === "rainbow") c = ledHsv((ledFrame * 0.06 + i * 0.125) % 1);
            else if (ledAnim === "happy" || ledAnim === "alert") c = ((ledFrame >> 1) & 1) === 0 ? solid : 0;
            else if (ledAnim === "heart") c = ledDim(solid, 0.35 + 0.65 * Math.abs(Math.sin(ledFrame * 0.35)));
            else c = solid;
            px.push(c);
        }
        System.neopixel(s, px);
    }
}

// ---- emocoes (cara + LED) ----
var MOODS = ["happy", "love", "curious", "sad", "angry", "sleepy", "alert"];
var mood = "", moodUntil = 0;
function setMood(m, ms) {
    if (MOODS.indexOf(m) < 0) return false;
    moodUntil = System.millis() + (ms || 4000);
    lastActivity = System.millis();
    if (m === "happy") {   // feliz ja tem cara propria (happyUntil)
        mood = "";
        happyUntil = System.millis() + (ms || 1600);
        setLeds("happy");
        return true;
    }
    mood = m;
    if (m === "love") setLeds("heart");
    else if (m === "angry" || m === "alert") setLeds("alert");
    else if (m === "sad" || m === "sleepy") ledsOff();
    else if (m === "curious") setLeds("calm");
    return true;
}

// ---- fala do cao ----
// Bolha na cara + ate 5 caracteres em sete-segmentos (texto e ilegivel no
// vidro; OLA/SIM/87% cabem) + o texto INTEIRO no controle pareado via link.
var sayText = "", sayRaw = "", sayUntil = 0;
function showSay(text, lang, quiet) {
    sayRaw = String(text || "");
    var ok = "";
    for (var i = 0; i < sayRaw.length && ok.length < 5; i++) {
        var ch = sayRaw.charAt(i).toUpperCase();
        if (SEG[ch - "0"] !== undefined || SEG7[ch] !== undefined) ok += ch;
    }
    sayText = ok;
    sayUntil = System.millis() + 3500;
    lastActivity = System.millis();
    reply({ type: "say", text: sayRaw.substring(0, 120), lang: lang || undefined });
    if (!quiet) playBark("yip", 1);   // dog_speak: a voz ja e o som (yip so atrasava)
}

// ---- fala por voz (TTS, API 24) ----
// A tool dog_speak deixa a PROPRIA IA escolher o idioma: ela escreve a
// resposta no idioma da pergunta e o TTS fala o que esta escrito (o gemini
// nao tem parametro de lingua — a lingua e o texto). O download e o
// playback rodam na worker do firmware: aqui so animamos a bolha e
// SURDAMOS o wake word enquanto o cao fala (o proprio alto-falante
// acordaria o "hi celer"). Sem chave/TTS/firmware novo, a tool degrada no
// visual do dog_say de sempre.
var speakBusy = false;
var pendingSpeak = null;   // dog_speak so AGENDA: o loop executa (bancada:
                           // a cadeia inteira dentro do callback do chat
                           // (tom + reply + yip + WakeWord.stop + speak)
                           // estourava a janela de 1 s e matava o app)
function speakReady() {
    return hasAI && typeof AI.speak === "function" &&
           AI.configured("openrouter") && Net.isConnected();
}
// Detector SURDO durante a fala, sem stop/start: o WakeWord.stop+start
// desmontava e remontava modelo TFLite + frontend + task A CADA fala (o
// stop ainda espera a task sair — pesava na janela de 1 s) e as alocacoes
// pequenas do frontend picotavam a RAM interna, a mesma que o TLS precisa.
// O voiceTick drena o poll() enquanto surdo; a cauda cobre o eco do falante.
var WAKE_ECHO_MS = 700;
var wakeMuted = false, wakeMuteUntil = 0;
function speakWake(on) {
    wakeMuted = !on;
    if (on) wakeMuteUntil = System.millis() + WAKE_ECHO_MS;
}
function speakStart(text, lang) {
    showSay(text, lang, speakReady());  // com voz: sem o yip na frente
    System.delay(1);       // cede: a janela renova entre as etapas pesadas
    if (!speakReady()) return true;   // so o visual (fallback silencioso)
    speakWake(false);                 // o cao nao pode se ouvir
    var ok = false;
    try {
        ok = AI.speak({ text: String(text).substring(0, 290) }, function (r) {
            speakBusy = false;
            speakWake(true);          // eco da fala ja passou (cb e pos-playback)
            if (r.ok) cueDone();      // fim da fala: interacao completa
            else {
                cueVoice(false);
                System.print('[voz] speak erro: ' + (r.error || r.status) +
                             (r.detail ? ' - ' + r.detail : ''));
            }
            lastActivity = System.millis();
        });
    } catch (e) {
        System.print('[voz] speak erro: ' + e);
    }
    if (ok) {
        speakBusy = true;
        System.print('[voz] speak (' + (lang || '?') + '): ' +
                     String(text).substring(0, 80));
    } else {
        speakWake(true);              // pedido nao entrou: detector de volta
    }
    return true;
}

// ---- sequenciador ----
var SEQ_MAX_STEPS = 12;     // passos por fila (dono ensina ate 20)
var SEQ_STEP_MS = 3000;     // teto de UM passo
var SEQ_TOTAL_MS = 12000;   // teto da fila inteira
var seqSteps = null, seqIdx = 0, seqUntil = 0, seqMove = false;
function seqActive() { return seqSteps !== null; }
function seqClear() { seqSteps = null; seqIdx = 0; seqUntil = 0; }

function clampMs(v, dflt) { return Math.round(clampNum(v, 150, SEQ_STEP_MS, dflt)); }

// Valida UM passo cru (JSON da LLM ou do dono); truque devolve array expandido.
function seqStep(s, depth) {
    if (!s || typeof s !== "object") return null;
    var act = String(s.do || "");
    if (act === "move") {
        if (!WALKS[s.dir]) return null;
        return { do: "move", dir: String(s.dir), ms: clampMs(s.ms, 900) };
    }
    if (act === "pose") {
        if (!POSES[s.name]) return null;
        return { do: "pose", name: String(s.name), ms: clampMs(s.ms, 700) };
    }
    if (act === "trick") {
        if (depth >= 2) return null;   // truque dentro de truque dentro de truque: nao
        return trickSteps(String(s.name || ""), depth);
    }
    if (act === "bark") {
        var k = BARKS.indexOf(s.kind) >= 0 ? String(s.kind) : "woof";
        return { do: "bark", kind: k, n: Math.round(clampNum(s.n, 1, 3, 1)) };
    }
    if (act === "leds") {
        var an = ["off", "happy", "rainbow", "alert", "heart"].indexOf(s.anim) >= 0
            ? String(s.anim) : "happy";
        return { do: "leds", anim: an };
    }
    if (act === "emotion") {
        if (MOODS.indexOf(s.mood) < 0) return null;
        return { do: "emotion", mood: String(s.mood) };
    }
    if (act === "wait") return { do: "wait", ms: clampMs(s.ms, 300) };
    if (act === "say") {
        if (!s.text) return null;
        return { do: "say", text: String(s.text).substring(0, 60) };
    }
    return null;
}

// Fila valida: descarta passos invalidos, expande truques, respeta os
// tetos de passos e de duracao total.
function buildSeq(raw, maxSteps, depth) {
    var out = [];
    if (!raw || typeof raw.length !== "number") return out;
    for (var i = 0; i < raw.length && out.length < maxSteps; i++) {
        var st = seqStep(raw[i], depth || 0);
        if (st === null) continue;
        if (st.length !== undefined) {   // truque expandido: absorve os passos
            for (var j = 0; j < st.length && out.length < maxSteps; j++) out.push(st[j]);
        } else out.push(st);
    }
    var fin = [], total = 0;
    for (var q = 0; q < out.length; q++) {
        var ms = out[q].ms || (out[q].do === "bark" ? 600 * out[q].n : 0);
        if (total + ms > SEQ_TOTAL_MS) break;
        total += ms;
        fin.push(out[q]);
    }
    return fin;
}

function runSeq(steps, kind) {
    seqClear();
    if (!steps || !steps.length) return false;
    if (legsLimp) { legsLimp = false; legsHold(); }
    seqSteps = steps;
    seqIdx = 0;
    seqUntil = 0;
    System.print('[dog] sequencia ' + (kind || '') + ': ' + steps.length + ' passos');
    return true;
}

// Uma volta do loop: passos instantaneos (bark/leds/emotion/say) saem em
// rajada ate o proximo passo com duracao; move/pose/wait ocupam a fila ate
// seqUntil. Bark e bloqueante (playWav toca inteiro): a dancinha da uma
// pausa natural a cada latido.
function seqTick(now) {
    if (!seqSteps) return;
    if (seqUntil > now) return;
    if (seqUntil !== 0) {
        seqUntil = 0;
        seqIdx++;
        if (seqMove) { seqMove = false; stopGait(); }
        if (seqIdx >= seqSteps.length) { seqEnd(); return; }
    }
    while (seqIdx < seqSteps.length) {
        var s = seqSteps[seqIdx];
        if (s.do === "move") {
            if (startGait(s.dir, true)) { seqMove = true; seqUntil = now + s.ms; break; }
        } else if (s.do === "pose") {
            if (startGait(s.name, false)) { seqUntil = now + s.ms; break; }
        } else if (s.do === "wait") {
            seqUntil = now + s.ms;
            break;
        } else if (s.do === "bark") {
            playBark(s.kind, s.n);
        } else if (s.do === "leds") {
            setLeds(s.anim);
        } else if (s.do === "emotion") {
            setMood(s.mood, 4000);
        } else if (s.do === "say") {
            showSay(s.text);
        }
        seqIdx++;
    }
    if (seqIdx >= seqSteps.length) seqEnd();
}

function seqEnd() {
    seqClear();
    if (seqMove) { seqMove = false; stopGait(); }
    ledsOff();
}

// ---- truques nativos ----
// A danca e uma funcao: sorteia a coreografia a cada chamada (nunca a
// mesma dancinha). Os demais sao filas fixas.
var HEAVY_TRICKS = ["dance", "spin", "excited"];
var TRICKS = {
    dance: function () {
        var pool = [
            { do: "pose", name: "sit", ms: 420 },
            { do: "pose", name: "stand", ms: 320 },
            { do: "pose", name: "stretch", ms: 400 },
            { do: "pose", name: "crouch", ms: 400 },
            { do: "move", dir: "left", ms: 420 },
            { do: "move", dir: "right", ms: 420 },
            { do: "move", dir: "walk", ms: 480 },
            { do: "bark", kind: "yip", n: 1 }
        ];
        var steps = [{ do: "leds", anim: "rainbow" }];
        var n = 6 + Math.floor(Math.random() * 3);
        for (var i = 0; i < n; i++) steps.push(pool[Math.floor(Math.random() * pool.length)]);
        steps.push({ do: "emotion", mood: "happy" });
        steps.push({ do: "leds", anim: "off" });
        return steps;
    },
    spin: [
        { do: "bark", kind: "yip", n: 1 },
        { do: "move", dir: "left", ms: 2200 },
        { do: "emotion", mood: "happy" }
    ],
    shake: function () {   // patinha: senta e oferece a FL abanando
        var s = [{ do: "pose", name: "sit", ms: 600 }];
        for (var i = 0; i < 4; i++) s.push({ do: "pose", name: i % 2 ? "shake_lo" : "shake_hi", ms: 200 });
        s.push({ do: "pose", name: "sit", ms: 300 });
        s.push({ do: "bark", kind: "yip", n: 1 });
        return s;
    },
    pushup: [
        { do: "pose", name: "crouch", ms: 420 },
        { do: "pose", name: "stand", ms: 320 },
        { do: "pose", name: "crouch", ms: 420 },
        { do: "pose", name: "stand", ms: 320 },
        { do: "pose", name: "crouch", ms: 420 },
        { do: "pose", name: "stand", ms: 320 },
        { do: "bark", kind: "woof", n: 1 }
    ],
    excited: [
        { do: "bark", kind: "yip", n: 2 },
        { do: "move", dir: "walk", ms: 320 },
        { do: "move", dir: "back", ms: 320 },
        { do: "move", dir: "walk", ms: 320 },
        { do: "move", dir: "back", ms: 320 },
        { do: "emotion", mood: "happy" }
    ],
    hello: [
        { do: "pose", name: "sit", ms: 500 },
        { do: "pose", name: "shake_hi", ms: 220 },
        { do: "pose", name: "shake_lo", ms: 220 },
        { do: "pose", name: "shake_hi", ms: 220 },
        { do: "say", text: "OLA" },
        { do: "bark", kind: "yip", n: 1 }
    ],
    pee: [
        { do: "pose", name: "pee", ms: 1200 },
        { do: "bark", kind: "yip", n: 1 },
        { do: "pose", name: "stand", ms: 500 }
    ]
};

// "Super Truco" -> super_truco (mesma normalizacao da carga do arquivo)
function trickKey(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_")
               .replace(/^_+|_+$/g, "").substring(0, 16);
}

// Expandir truque pelo nome -> fila valida (ou null)
function trickSteps(name, depth) {
    name = trickKey(name);
    var def = TRICKS[name];
    if (def !== undefined) {
        var raw = typeof def === "function" ? def() : def;
        return buildSeq(raw, SEQ_MAX_STEPS, (depth || 0) + 1);
    }
    // truque do dono: so no nivel raiz (custom nao referencia custom — a
    // carga e uma passada so e a ordem das chaves nao pode importar)
    if (!depth && customTricks[name]) return customTricks[name];
    return null;
}

// ---- truques que o dono ensina (/local/dogtricks.json) ----
// {"super truco": [{do:"bark",kind:"woof"},{do:"pose",name:"lie",ms:400},...]}
// Mesmo schema do sequenciador (e o que a LLM compoe no dog_sequence); os
// nomes entram na tool dog_trick e no prompt, entao "hi celer, faz o super
// truco" funciona. Criar/editar pelo celerctl (push) ou editor web e mandar
// {"type":"tricks_reload"} pelo link — ou reboot.
var TRICKS_FILE = "/local/dogtricks.json";
var customTricks = {};
function loadCustomTricks() {
    customTricks = {};
    if (typeof FS === "undefined" || !FS.exists || !FS.exists(TRICKS_FILE)) return;
    var names = [];
    try {
        var t = JSON.parse(FS.readTextFile(TRICKS_FILE));
        for (var name in t) {
            // "Super Truco" -> super_truco (o dono fala/escreve como quiser)
            var key = trickKey(name);
            if (!key || TRICKS[key] !== undefined) continue;
            // depth 1: dentro do custom so valem atos basicos e truques nativos
            var seq = buildSeq(t[name], 20, 1);
            if (seq && seq.length) { customTricks[key] = seq; names.push(key); }
        }
        if (names.length) System.print('[dog] truques do dono: ' + names.join(', '));
    } catch (e) {
        System.print('[dog] dogtricks.json invalido: ' + e);
    }
}
loadCustomTricks();

function trickNames() {
    var n = [];
    for (var k in TRICKS) n.push(k);
    for (var c in customTricks) n.push(c);
    return n;
}

// Lista para a telemetria: caber no frame do link (240 B) junto do resto
function telTricks() {
    var names = trickNames();
    while (names.length && JSON.stringify(names).length > 96) names.pop();
    return names;
}

function battPct() {
    if (lastBatt < 0) return 100;
    var f = (lastBatt - 3300) / 900;
    if (f < 0) f = 0;
    if (f > 1) f = 1;
    return Math.round(f * 100);
}

function runTrick(name) {
    name = trickKey(name);
    // bateria fraca recusa truque pesado com drama (e evita brownout)
    if (HEAVY_TRICKS.indexOf(name) >= 0 && battPct() < 15) {
        playBark("whine", 1);
        setMood("sad", 3000);
        showSay("cansado");
        return false;
    }
    var steps = trickSteps(name, 0);
    if (!steps || !steps.length) return false;
    happyUntil = System.millis() + 900;
    return runSeq(steps, "trick:" + name);
}

// ------------------------------------------------------------ estado ------
var blinkAt = System.millis() + 1800;
var blinkUntil = 0;
var happyUntil = 0;
var lookX = 0, lookY = 0;
var lookT = System.millis() + 900;
var breath = 0;
var lastMic = 0, micAt = 0;
var lastBatt = -1, battAt = -100000;
var battWarned = false;      // ganido da bateria fraca: uma vez por cruzamento
var padZeros = 0;           // leituras soltas seguidas (debounce da soltura)
var lastActivity = System.millis();
var sleeping = false;
var padHeld = false, padDownAt = 0;
var GAIT_CYCLE = ["stand", "walk", "sit", "lie", "stretch"];
var gaitIdx = 0;

function cycleGait() {
    seqClear();   // o pad manda: interrompe truque/sequencia em curso
    gaitIdx = (gaitIdx + 1) % GAIT_CYCLE.length;
    var name = GAIT_CYCLE[gaitIdx];
    System.print('[dog] touch gait: ' + name);
    startGait(name, name === "walk");
    happyUntil = System.millis() + 800;
}

function drawEyes(open, pupilR, lx, ly) {
    if (sleeping) open = false;
    var ey = 24 + Math.round(Math.sin(breath) * 1.5);
    var eh = open ? 22 : 3;
    System.fillRoundRect(PX(18), PY(ey - eh / 2), PW_(34), PH_(eh), PH_(6), 0xFFFF);
    System.fillRoundRect(PX(76), PY(ey - eh / 2), PW_(34), PH_(eh), PH_(6), 0xFFFF);
    if (open) {
        // lx/ly explicitos = rosto de performance (dog_script); sem eles o
        // olhar vivo do loop (lookX/lookY)
        var px = Math.round((lx === undefined ? lookX : lx) * 6);
        var py = Math.round((ly === undefined ? lookY : ly) * 3);
        System.fillCircle(PX(35 + px), PY(ey + py), PW_(pupilR), 0xFFFF);
        System.fillCircle(PX(93 + px), PY(ey + py), PW_(pupilR), 0xFFFF);
    }
}

function drawHappy() {
    System.fillRect(PX(22), PY(20), PW_(10), PH_(3), 0xFFFF);
    System.fillRect(PX(32), PY(23), PW_(10), PH_(3), 0xFFFF);
    System.fillRect(PX(80), PY(20), PW_(10), PH_(3), 0xFFFF);
    System.fillRect(PX(90), PY(23), PW_(10), PH_(3), 0xFFFF);
    System.fillRoundRect(PX(52), PY(40), PW_(24), PH_(8), PH_(3), 0xFFFF);
}

// ---- emocoes na cara (repositorio 2.0) ----
function drawHeart(cx, cy, s) {
    System.fillCircle(PX(cx - s / 2 + 1), PY(cy - s / 4), PW_(s / 2 + 1), 0xFFFF);
    System.fillCircle(PX(cx + s / 2 - 1), PY(cy - s / 4), PW_(s / 2 + 1), 0xFFFF);
    System.fillTriangle(PX(cx - s), PY(cy - 2), PX(cx + s), PY(cy - 2),
                        PX(cx), PY(cy + s), 0xFFFF);
}

function drawZ(x, y, s, now) {   // "Z" com 3 tracos, flutuando
    var bob = Math.round(Math.sin(now / 400) * 2);
    System.drawLine(PX(x), PY(y + bob), PX(x + s), PY(y + bob), 0xFFFF);
    System.drawLine(PX(x + s), PY(y + bob), PX(x), PY(y + s + bob), 0xFFFF);
    System.drawLine(PX(x), PY(y + s + bob), PX(x + s), PY(y + s + bob), 0xFFFF);
}

function drawMood(now) {
    if (mood === "love") {
        drawHeart(38, 22, 14);
        drawHeart(90, 22, 14);
    } else if (mood === "angry") {
        drawEyes(true, 8);
        // sobrancelhas em V (grossas, caindo pro centro)
        System.fillTriangle(PX(14), PY(8), PX(52), PY(15), PX(14), PY(15), 0xFFFF);
        System.fillTriangle(PX(114), PY(8), PX(76), PY(15), PX(114), PY(15), 0xFFFF);
    } else if (mood === "sad") {
        drawEyes(true, 6);
        var ty = 30 + (((now / 350) | 0) % 6);   // lagrima caindo
        System.fillRect(PX(98), PY(ty), PW_(3), PH_(4), 0xFFFF);
    } else if (mood === "sleepy") {
        drawEyes(false, 0);
        drawZ(96, 8, 9, now);
        drawZ(110, 1, 6, now);
    } else {   // curious / alert: olhos abertos, pupilas grandes
        drawEyes(true, mood === "alert" ? 13 : 12);
    }
    System.fillRect(PX(60), PY(36), PW_(8), PH_(3), 0xFFFF);   // nariz
}

// arco de cima (leque de WiFi) em segmentos, coordenadas do vidro 128x64:
// sem apagar nada embaixo (a cara mora ali)
function wifiArc(cx, cy, r) {
    var px = cx + r * Math.cos(Math.PI * 1.20), py = cy + r * Math.sin(Math.PI * 1.20);
    for (var a = 1.30; a <= 1.81; a += 0.10) {
        var x = cx + r * Math.cos(Math.PI * a), y = cy + r * Math.sin(Math.PI * a);
        System.drawLine(PX(px), PY(py), PX(x), PY(y), 0xFFFF);
        px = x; py = y;
    }
}

function drawStatus() {
    // bateria: canto superior DIREITO (deixa o alto-esquerdo limpo pra cara)
    if (lastBatt >= 0) {
        var frac = (lastBatt - 3300) / (4200 - 3300);
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
        System.drawRect(PX(100), PY(2), PW_(20), PH_(8), 0xFFFF);
        System.fillRect(PX(121), PY(4), PW_(2), PH_(4), 0xFFFF);   // bico
        System.fillRect(PX(102), PY(4), Math.max(1, PW_(16 * frac)), PH_(4), 0xFFFF);
        if (frac < 0.15 && ((System.millis() / 500) | 0) % 2 === 0) {
            System.fillRect(PX(100), PY(2), PW_(23), PH_(8), 0xFFFF);  // pisca
        }
    }
    // link BLE: pontinho aceso quando conectado (esquerda da bateria)
    if (linkUp) System.fillCircle(PX(93), PY(6), PW_(2), 0xFFFF);
    // internet: leque de WiFi (3 arcos + ponto) a esquerda do link
    if (netUp) {
        System.fillCircle(PX(74), PY(9), PW_(1), 0xFFFF);
        wifiArc(74, 9, 4);
        wifiArc(74, 9, 7);
    }
    // saude dos servos: so aparece se algo falhar (canto alto-esquerdo)
    if (!SERVO || servoFails > 0) {
        System.fillRect(PX(3), PY(3), PW_(2), PH_(5), 0xFFFF);
        System.fillRect(PX(7), PY(3), PW_(2), PH_(5), 0xFFFF);
    }
    if (lastMic > 0) {
        System.fillRect(PX(0), PY(62), Math.min(PW, Math.round(lastMic * PW / 100)), PH_(2), 0xFFFF);
    }
    // wake word escutando: microfone pequeno a esquerda do ponto do link —
    // aceso = pode dizer "hi celer"
    if (voiceReady && !voiceBusy) {
        System.fillRoundRect(PX(83), PY(2), PW_(4), PH_(6), PW_(2), 0xFFFF);
        System.fillRect(PX(84), PY(9), PW_(2), PH_(1), 0xFFFF);
    }
}

// Comando de voz na tela (o texto e ilegivel no vidro: so desenho).
// Gravando = microfone grande + barras que seguem o volume (fale agora);
// esperando a IA = tres pontos andando.
function drawVoice(now) {
    if (voiceRec) {
        System.fillRoundRect(PX(58), PY(12), PW_(12), PH_(24), PW_(6), 0xFFFF);
        System.drawRoundRect(PX(54), PY(24), PW_(20), PH_(18), PW_(9), 0xFFFF);
        System.fillRect(PX(63), PY(42), PW_(2), PH_(8), 0xFFFF);
        System.fillRect(PX(56), PY(50), PW_(16), PH_(2), 0xFFFF);
        for (var i = 0; i < 3; i++) {
            var h = Math.round(4 + (voiceLvl / 100) * (30 - i * 7));
            if (h > 34) h = 34;
            var y = 30 - Math.round(h / 2);
            System.fillRect(PX(40 - i * 8), PY(y), PW_(3), PH_(h), 0xFFFF);
            System.fillRect(PX(85 + i * 8), PY(y), PW_(3), PH_(h), 0xFFFF);
        }
        return;
    }
    var on = ((now / 250) | 0) % 3;
    for (var k = 0; k < 3; k++) {
        System.fillCircle(PX(46 + k * 18), PY(32), PW_(k === on ? 5 : 3), 0xFFFF);
    }
}

// Fala do cao na tela: balao + rabo + ate 5 caracteres em sete-segmentos
// (o texto inteiro vai pro controle pareado via link). Enquanto o TTS
// desce/rola (speakBusy) os pontinhos passeiam: a bolha "viva" mascara a
// espera da voz.
function drawSay() {
    System.drawRoundRect(PX(4), PY(6), PW_(120), PH_(42), PW_(8), 0xFFFF);
    System.fillTriangle(PX(28), PY(48), PX(40), PY(48), PX(33), PY(57), 0xFFFF);
    var n = sayText.length;
    var x0 = Math.round((PW - n * 14) / 2);
    for (var i = 0; i < n; i++) drawSegDigit(x0 + i * 14, 14, sayText.charAt(i));
    if (speakBusy) {
        var on = ((System.millis() / 300) | 0) % 3;
        for (var i = 0; i < 3; i++) {
            System.fillCircle(PX(50 + i * 14), PY(40), PW_(i === on ? 2 : 1), 0xFFFF);
        }
    }
}

function draw() {
    System.fillScreen(0);
    var now = System.millis();
    if (pairShow) {
        drawPair();      // codigo de pareamento no lugar da cara
    } else if (voiceBusy) {
        drawVoice(now);  // ouvindo o comando / esperando a IA
    } else if (now < sayUntil || speakBusy) {
        drawSay();       // respondendo (dog_say) / falando (dog_speak)
    } else if (now < happyUntil) {
        drawHappy();
    } else if (mood) {
        drawMood(now);   // emocao corrente (love/angry/sad/sleepy/...)
    } else {
        drawEyes(now >= blinkUntil, 10);
        System.fillRect(PX(60), PY(36), PW_(8), PH_(3), 0xFFFF);
    }
    drawStatus();
}

// ------------------------------------------------------- celer link -------
var linkUp = false;
var hasLink = (typeof CelerLink !== "undefined");
// API 11: pareamento por codigo — quem conecta digita o codigo que aparece
// AQUI na tela antes de poder mandar qualquer coisa. Controles ja
// pareados (memoria do firmware) entram direto.
if (hasLink) CelerLink.start("Celer-Dog", { pairing: true });

// Tela de pareamento: cadeado + codigo em sete-segmentos (texto e ilegivel
// no vidro). pairShow fica aceso enquanto o handshake pendura.
var pairShow = false, pairWas = false, pairCode = "";

// Segmentos de cada digito (a=topo, b/c=dir, d=base, e/f=esq, g=meio) e
// das letras que a fala do cao usa (OLA/SIM/NAO/87%...); M e Q nao dao
var SEG = {
    0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg",
    5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg"
};
var SEG7 = {
    A: "abcefg", B: "bcdef", C: "adef", D: "bcdeg", E: "adefg", F: "aefg",
    G: "acdef", H: "bcefg", I: "bc", L: "def", N: "ceg", O: "abcdef",
    P: "abefg", R: "eg", S: "acdfg", T: "defg", U: "bdef", Y: "bcdfg"
};
function drawSegDigit(x, y, ch) {
    var on = SEG[ch - "0"] || SEG7[ch] || SEG[8];
    // celula 12x22 fisica, trilho 2px; horizontal no meio da largura
    if (on.indexOf("a") >= 0) System.fillRect(PX(x + 2), PY(y), PW_(8), PH_(2), 0xFFFF);
    if (on.indexOf("g") >= 0) System.fillRect(PX(x + 2), PY(y + 10), PW_(8), PH_(2), 0xFFFF);
    if (on.indexOf("d") >= 0) System.fillRect(PX(x + 2), PY(y + 20), PW_(8), PH_(2), 0xFFFF);
    if (on.indexOf("f") >= 0) System.fillRect(PX(x), PY(y + 2), PW_(2), PH_(8), 0xFFFF);
    if (on.indexOf("b") >= 0) System.fillRect(PX(x + 10), PY(y + 2), PW_(2), PH_(8), 0xFFFF);
    if (on.indexOf("e") >= 0) System.fillRect(PX(x), PY(y + 12), PW_(2), PH_(8), 0xFFFF);
    if (on.indexOf("c") >= 0) System.fillRect(PX(x + 10), PY(y + 12), PW_(2), PH_(8), 0xFFFF);
}

// Cadeado pulsando (o codigo expira em 60 s: chama atencao) + 6 digitos em
// 2 grupos de 3: 2*(3*12+2*2) + 8 de respiro = 88px, centrado no vidro.
function drawPair() {
    var now = System.millis();
    if (((now / 500) | 0) % 2 === 0) {  // corpo do cadeado pisca
        System.fillRect(PX(56), PY(11), PW_(16), PH_(9), 0xFFFF);
        System.fillRect(PX(59), PY(14), PW_(10), PH_(3), 0);      // buraco da fechadura
        System.fillRect(PX(59), PY(5), PW_(3), PH_(6), 0xFFFF);   // arco
        System.fillRect(PX(68), PY(5), PW_(3), PH_(6), 0xFFFF);
        System.fillRect(PX(59), PY(5), PW_(12), PH_(3), 0xFFFF);
    }
    for (var i = 0; i < 6; i++) {
        if (i >= pairCode.length) break;
        drawSegDigit(20 + i * 14 + (i >= 3 ? 8 : 0), 28, pairCode.charAt(i));
    }
}

function reply(obj) {
    if (hasLink && linkUp) CelerLink.send(obj);
}

// dir do Celer Remote -> gait (todas continuas, param no stop)
var MOVE2GAIT = { up: "walk", down: "back", left: "left", right: "right" };

function sendTel() {
    reply({ type: "tel", batt: lastBatt, mic: lastMic, state: gaitName || "stand",
            sleep: sleeping, mode: walkMode, modes: MODES_OK,
            tricks: telTricks(),   // o Remote 1.5 monta a grade de truques com ela
            tune: 1,               // anuncia painel de afino (Remote 1.6: air/leanR/esperas ao vivo)
            wifi: canWifi, net: hasNet && Net.isConnected() });
}

// ---- WiFi pelo Celer Remote (API 21) ---------------------------------------
// O cao nao tem teclado: o Remote pede a lista de redes que ELE ve
// ({type:"wifi_scan"}, aberto — SSID nao e segredo) e manda a senha SELADA
// (CelerLink.sendSealed: AES-GCM com a chave do pareamento). A credencial so
// e aceita pelo pollSealed() — um {type:"wifi"} em texto aberto e ignorado.
var hasNet = (typeof Net !== "undefined" && typeof Net.isConnected === "function");
var netUp = false;  // internet no ar (icone na barra; relido a cada 2 s)
var netAt = 0;
var canWifi = hasLink && hasNet && typeof CelerLink.pollSealed === "function" &&
              typeof Net.wifiConnect === "function" && typeof Net.wifiScan === "function";

function wifiScanReply() {
    if (!canWifi) { reply({ type: "wifi_list", nets: [], err: "sem suporte" }); return; }
    stopGait();
    var list = Net.wifiScan() || [];
    list.sort(function (a, b) { return b.rssi - a.rssi; });
    var nets = [], seen = {};
    for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (!n.ssid || seen[n.ssid]) continue;
        seen[n.ssid] = true;
        nets.push([String(n.ssid).substring(0, 24), n.rssi, n.secure ? 1 : 0]);
        // cabe numa mensagem do link (240 B) com folga para o envelope
        if (JSON.stringify({ type: "wifi_list", nets: nets }).length > 220) { nets.pop(); break; }
    }
    reply({ type: "wifi_list", nets: nets });
}

function wifiApply(m) {
    if (!canWifi || !m.ssid) return;
    stopGait();
    System.neopixel(0, [0x00A0A0, 0x00A0A0, 0x00A0A0, 0x00A0A0]);  // ciano: conectando
    System.neopixel(1, [0x00A0A0, 0x00A0A0, 0x00A0A0, 0x00A0A0]);
    var ok = Net.wifiConnect(String(m.ssid), String(m.pass || ""));  // salva + conecta (ate 15 s)
    m.pass = null;
    System.neopixel(0, [0, 0, 0, 0]);
    System.neopixel(1, [0, 0, 0, 0]);
    if (ok) { happyUntil = System.millis() + 1400; netUp = true; }
    System.print("[wifi] " + m.ssid + ": " + (ok ? "conectado " + System.getIPAddress() : "falhou"));
    reply({ type: "wifi_res", ok: !!ok, ssid: String(m.ssid), ip: ok ? System.getIPAddress() : "" });
}

function handleMsg(m) {
    if (m && m.type === "wifi_scan") { wifiScanReply(); return; }
    if (!m || !m.type) {
        // compat: forma antiga {cmd:"gait"|"stop"|"pet"|"info"}
        if (m && m.cmd === "gait") {
            seqClear();
            if (startGait(String(m.name), !!m.repeat)) {
                linkGait = !!m.repeat;
                happyUntil = System.millis() + 800;
            }
        } else if (m && m.cmd === "stop") {
            seqClear();
            stopGait();
        } else if (m && m.cmd === "pet") {
            setMood("happy", 1600);
        } else if (m && m.cmd === "info") {
            sendTel();
        }
        return;
    }
    switch (m.type) {
        case "move":
            // O Remote repete o move a cada ~250 ms enquanto a seta esta
            // pressionada: a mesma gait em curso so renova o keepalive
            // (reiniciar no quadro 0 travaria o passo no meio).
            seqClear();   // o D-pad manda: interrompe truque/sequencia
            var g = MOVE2GAIT[m.dir] || "walk";
            var same = gaitName === g && repeatGait && linkDrive;
            moveAt = System.millis();
            if (startGait(g, true)) {
                linkDrive = true;
                if (!same) happyUntil = System.millis() + 600;
            }
            break;
        case "stop":
            seqClear();
            stopGait();
            break;
        case "pet":
            setMood("happy", 1600);
            break;
        case "trick":
            // {"type":"trick","name":"dance"} — truque coreografado (o
            // Remote 1.5 e a voz chamam pela mesma porta)
            var tok = runTrick(m.name);
            reply({ type: "trick_res", ok: !!tok, name: String(m.name || "") });
            break;
        case "tricks_reload":
            // dono atualizou /local/dogtricks.json: recarrega e devolve a lista
            loadCustomTricks();
            reply({ type: "tricks_res", names: trickNames() });
            break;
        case "script":
            // {"type":"script","code":"..."} — performance da IA direto do
            // controle pareado (bancada: dispara sem passar pela voz)
            if (m.code) runAiScript(String(m.code));
            break;
        case "gait":
            if (startGait(String(m.name), !!m.repeat)) {
                linkGait = !!m.repeat;
                happyUntil = System.millis() + 800;
            }
            break;
        case "info":
            sendTel();
            break;
        case "calib":
            calibrate();
            break;
        case "mode":
            // {"type":"mode","walk":"esphi"|"creep"} nomeado ou sem walk =
            // proximo das marchas liberadas (MODES_OK); escolha fica salva
            // no dogtune.json (junto com a marca das pernas atuais)
            if (gait !== null) stopGait();
            var wm = WALK_MODES.indexOf(String(m.walk));
            walkMode = wm >= 0 ? WALK_MODES[wm]
                : MODES_OK[(MODES_OK.indexOf(walkMode) + 1) % MODES_OK.length];
            System.print('[dog] marcha: ' + walkMode);
            saveTune();
            sendTel();
            break;
        case "tune":
            // {"type":"tune","lean":20,"speed":80,"trim":{"FL":5},"flip":true,
            //  "hop":{"rear":30,"kick":40,"msDeg":2},"P":20,"T":25,"power":600,
            //  "tilt":180,"swing":240,"order":["BL","FL","BR","FR"]} — lean/
            //  speed/trim/flip/hop ja valem na hora (postura/ritmo/pulo), o
            //  resto no proximo ciclo; tudo fica salvo
            applyTune(m);
            saveTune();
            reply({ type: "tune", lean: LEAN, P: CREEP.P, T: CREEP.T, power: CREEP.power,
                    tilt: CREEP.tilt, swing: CREEP.swing, order: CREEP.order, mode: walkMode,
                    flip: FLIP, speed: SPEED, trim: TRIM });
            reply({ type: "hop", prep: HOP.prep, rear: HOP.rear, kick: HOP.kick,
                    front: HOP.front, pull: HOP.pull, msDeg: HOP.msDeg,
                    air: HOP.air, fall: HOP.fall, land: HOP.land,
                    settle: HOP.settle, rest: HOP.rest, spin: HOP.spin });
            reply({ type: "stance", leanF: LEAN_F, leanR: LEAN_R });
            break;
    }
}

// ------------------------------------------------------------ voz -------
// Comandos por voz (API 20): "hi celer" detectado NO CHIP (WakeWord, modelo
// proprio microWakeWord) abre uma janela de gravacao; o audio vai pro
// qwen omni (AI.chat com tools) e o tool_call dog_command dispara o gait —
// "hi celer, senta" faz sentar. Tudo feature-detect: sem WakeWord (build
// sem CELEROS_WAKE_WORD), sem microfone ou sem IA o cao segue igual.
var voiceReady = (typeof WakeWord !== "undefined" && typeof Mic !== "undefined");
var voiceBusy = false;        // da janela de escuta ate a resposta da IA
var voiceRec = false;
var voiceHeard = false;       // nivel subiu ao menos 1x (tem alguem falando)
var voiceQuietAt = 0;
var voiceWalkUntil = 0;       // prazo da marcha por voz (dog_move longo ou fallback 3 s)
var VOICE_WALK_MS = 3000;
var VOICE_MOVE_MAX_MS = 60000;  // teto do dog_move da voz: steps x ciclo ou duracao
var hasAI = (typeof AI !== "undefined" && typeof Net !== "undefined");
var voiceErrorAt = 0;
var voiceLvl = 0;             // volume ao vivo da janela de gravacao (tela)
var voiceT0 = 0;              // marcos de latencia (logcat): wake, fim da fala
var voiceTEnd = 0;

function cueVoice(ok) {
    // ack do wake: duas notas subindo (ouvindo) ou duas graves (erro)
    // (playTone nao aceita frequencia 0 como pausa: RangeError derrubava o
    // app justo no momento do wake)
    if (ok) System.playTone([[900, 60], [1350, 90]]);
    else System.playTone([[400, 90], [330, 120]]);
}

// ---- bipes de estado da cadeia da voz (pedido da bancada) ----
// Marcos audiveis curtos entre as etapas: ENVIADO (1 blip: a fala saiu pro
// servidor), RECEBIDO (2 notas claras: a IA respondeu) e FIM (trinado de 3;
// no dog_speak ele toca no fim da FALA, nao no fim do dispatch). Todos
// bloqueantes curtos (~0,1 s), como o ack do wake.
function cueSent() { System.playTone([[1320, 70]]); }
function cueGot()  { System.playTone([[1180, 45], [1480, 60]]); }
function cueDone() { System.playTone([[980, 40], [1240, 40], [1560, 70]]); }

function voiceRing(on, err) {
    // anel de LED: azul = ouvindo/pensando, vermelho = erro (os anims do
    // repertorio 2.0 seguem no ledTick; aqui o quadro sai na hora)
    setLeds(err ? "err" : (on ? "listen" : "off"));
    if (on) {
        var c = err ? LED_COLORS.err : LED_COLORS.listen;
        System.neopixel(0, [c, c, c, c]);
        System.neopixel(1, [c, c, c, c]);
    }
}

// ---- fallback offline por palavra-chave ----
// Cobre o modelo responder texto em vez de tool_call (e o PT/EN, com as
// variantes acentuadas que o STT devolve). Casamento pelo texto mais longo
// primeiro; truques/latidos/emocoes alem das posturas/marchas de sempre.
var VOICE_GAITS = {
    sit: "sit", senta: "sit", sentar: "sit", sentado: "sit", "senta aí": "sit",
    lie: "lie", down: "lie", deita: "lie", deitar: "lie", deitado: "lie",
    "lay down": "lie",
    stand: "stand", levanta: "stand", levantar: "stand", em_pe: "stand", up: "stand",
    stretch: "stretch", alonga: "stretch", alongar: "stretch", bow: "stretch",
    walk: "walk", anda: "walk", andar: "walk", "vai": "walk", frente: "walk",
    pula: "hop", pulo: "hop", salta: "hop", saltar: "hop", hop: "hop", empina: "hop",
    esquerda: "left", esquerdo: "left", left: "left",
    direita: "right", direito: "right", right: "right",
    back: "back", tras: "back", recua: "back",
    stop: "stop", para: "stop", pare: "stop", passo: "stop", quieta: "stop"
};
var VOICE_TRICKS = {
    "dança": "dance", "danca": "dance", "dançar": "dance", "dancar": "dance",
    "dancinha": "dance", dance: "dance",
    "giro": "spin", girar: "spin", gira: "spin", spin: "spin",
    "patinha": "shake", shake: "shake", paw: "shake",
    xixi: "pee", "xixizinho": "pee", pee: "pee",
    "flexão": "pushup", "flexao": "pushup", pushup: "pushup", polichinelo: "pushup",
    "olá": "hello", ola: "hello", hello: "hello", cumprimenta: "hello",
    anima: "excited", animado: "excited", excited: "excited", festeja: "excited"
};
var VOICE_BARKS = {
    late: "woof", bark: "woof", woof: "woof",
    uiva: "howl", uivar: "howl", uivo: "howl", howl: "howl",
    rosna: "growl", rosnar: "growl", growl: "growl",
    "geme": "whine", ganir: "whine", whine: "whine", chora: "whine"
};
var VOICE_MOODS = {
    feliz: "happy", happy: "happy",
    "te amo": "love", love: "love",
    bravo: "angry", brava: "angry", angry: "angry",
    triste: "sad", sad: "sad",
    sono: "sleepy", "com sono": "sleepy", sleepy: "sleepy",
    curioso: "curious", alerta: "alert"
};

function voiceRunGait(cmd) {
    var name = VOICE_GAITS[String(cmd).toLowerCase()];
    System.print('[voz] comando "' + cmd + '" -> ' + (name || "desconhecido"));
    if (!name) return false;
    if (name === "stop") { seqClear(); stopGait(); voiceWalkUntil = 0; return true; }
    var cont = (name === "walk" || name === "back" || name === "left" ||
                name === "right" || name === "hop");
    if (startGait(name, cont)) {
        if (cont) voiceWalkUntil = System.millis() + VOICE_WALK_MS;
        happyUntil = System.millis() + 900;
        return true;
    }
    return false;
}

var VOICE_WORDS = null;
function voiceFromText(t) {
    if (!t) return false;
    t = String(t).toLowerCase();
    if (!VOICE_WORDS) {
        VOICE_WORDS = [];
        function add(map, act) {
            for (var k in map) VOICE_WORDS.push({ k: k, act: act, v: map[k] });
        }
        add(VOICE_TRICKS, "trick");
        add(VOICE_BARKS, "bark");
        add(VOICE_MOODS, "mood");
        add(VOICE_GAITS, "gait");
        VOICE_WORDS.sort(function (a, b) { return b.k.length - a.k.length; });
    }
    for (var i = 0; i < VOICE_WORDS.length; i++) {
        var w = VOICE_WORDS[i];
        if (t.indexOf(w.k) < 0) continue;
        if (w.act === "trick") return runTrick(w.v);
        if (w.act === "bark") { playBark(w.v, 1); setMood("happy", 1200); return true; }
        if (w.act === "mood") return setMood(w.v, 4000);
        return voiceRunGait(w.v);
    }
    return false;
}

// ---- ferramentas da LLM (voz 2.0) ----
// A IA deixa de ser um seletor de 8 comandos e vira COREOGRAFA: compoe
// sequencias de passos, escolhe latidos e emocoes e responde perguntas
// com o dog_say. A telemetria viva vai no prompt (bateria/postura/marcha
// e os truques que o dono ensinou), entao "tudo bem?" tem resposta em
// UMA rodada, sem devolver tool result pro modelo.
function voicePrompt() {
    var p = "Voce e o Celercao, um cachorro robotico carismatico, brincalhao " +
        "e um pouco dramatico. O audio e o dono falando com voce (portugues ou " +
        "ingles). Telemetria: bateria " + battPct() + "%, postura " +
        (gaitName || "stand") + ", marcha " + walkMode + ". ";
    var customs = [];
    for (var k in customTricks) customs.push(k);
    if (customs.length) p += "Truques que o dono te ensinou: " + customs.join(", ") + ". ";
    p += "Responda chamando EXATAMENTE UMA ferramenta. Pedido simples de " +
        "movimento: dog_move ou dog_posture. Truque conhecido: dog_trick. " +
        "Pedido com varios passos ou coreografia livre: dog_sequence (compoe " +
        "os passos voce mesmo, criativo e ritmado). Pedido de musica, batida, " +
        "som animado ou FESTA com cores: dog_music (voce orquestra o groove " +
        "bateria+baixo+tema no mesmo compasso; as luzes e a dancinha sao " +
        "automaticas). " +
        "Se expressar de um jeito " +
        "PROPRIO e original (dancinha so sua, comemorar a sua maneira, " +
        "performance criativa que nenhuma tool cobre): dog_script, voce " +
        "ESCREVE o script JS ES5 pela API descrita na ferramenta (cara, " +
        "pernas, LEDs e som juntos). " +
        "Reacao ou animo: dog_bark " +
        "ou dog_emotion. Pergunta ou conversa com o dono (bateria, nome, " +
        "como voce esta, oi): dog_speak com resposta CURTA e com graca (ate " +
        "150 caracteres - e FALADA) NO IDIOMA em que o dono falou (portugues, " +
        "ingles, espanhol...). Pedido de 'fala'/'diga algo' tambem e dog_speak " +
        "(voz), NAO dog_bark. Frase silenciosa (so no controle pareado, sem " +
        "voz): dog_say. Audio vazio, ruido ou conversa sem pedido: nao chame " +
        "nenhuma ferramenta.";
    return p;
}

function voiceTools() {
    var tricks = trickNames();   // nativos + do dono
    return [
        { type: "function", function: { name: "dog_move",
          description: "Anda ou gira na direcao por N passos ou por um tempo",
          parameters: { type: "object", properties: {
              direction: { type: "string", enum: ["walk", "back", "left", "right"] },
              steps: { type: "integer", description: "numero de passos (1 passo = 1 ciclo de marcha); tem prioridade sobre ms" },
              ms: { type: "integer", description: "duracao em ms, 150 a 60000" }
          }, required: ["direction"] } } },
        { type: "function", function: { name: "dog_posture",
          description: "Assume uma postura parado",
          parameters: { type: "object", properties: {
              pose: { type: "string", enum: ["stand", "sit", "lie", "stretch", "beg", "pee"] }
          }, required: ["pose"] } } },
        { type: "function", function: { name: "dog_trick",
          description: "Executa um truque coreografado",
          parameters: { type: "object", properties: {
              name: { type: "string", enum: tricks }
          }, required: ["name"] } } },
        { type: "function", function: { name: "dog_sequence",
          description: "Compoe uma coreografia livre de ate 10 passos, na ordem",
          parameters: { type: "object", properties: {
              steps: { type: "array", maxItems: 10, items: { type: "object" },
                  description: 'passos: {do:"move",dir:"walk|back|left|right",ms} ' +
                      '{do:"pose",name:"stand|sit|lie|stretch|beg|pee",ms} ' +
                      '{do:"trick",name} {do:"bark",kind:"woof|yip|growl|whine|howl",n} ' +
                      '{do:"leds",anim:"rainbow|happy|alert|heart|off"} ' +
                      '{do:"emotion",mood:"happy|love|curious|sad|angry|sleepy|alert"} ' +
                      '{do:"wait",ms} {do:"say",text:"ate 60 chars"}' }
          }, required: ["steps"] } } },
        { type: "function", function: { name: "dog_bark",
          description: "Late: escolha o som que combina com a resposta",
          parameters: { type: "object", properties: {
              kind: { type: "string", enum: BARKS },
              times: { type: "integer", description: "1 a 3" }
          }, required: ["kind"] } } },
        { type: "function", function: { name: "dog_emotion",
          description: "Expressa uma emocao na cara e no anel de LED",
          parameters: { type: "object", properties: {
              mood: { type: "string", enum: MOODS }
          }, required: ["mood"] } } },
        { type: "function", function: { name: "dog_say",
          description: "Frase curta SILENCIOSA: so no controle pareado e resumo no vidro (sem voz)",
          parameters: { type: "object", properties: {
              text: { type: "string", description: "ate 60 caracteres, portugues" }
          }, required: ["text"] } } },
        { type: "function", function: { name: "dog_speak",
          description: "FALA em voz alta (voz do cao): perguntas, conversa, saudacao e pedidos de 'fala'/'diga algo' (isto NAO e latido). Frase CURTA (ate 150 caracteres) NO MESMO IDIOMA em que o dono falou - a voz fala o que esta escrito. Pode prefixar o tom (ex.: 'Diga animado: ...')",
          parameters: { type: "object", properties: {
              text: { type: "string", description: "frase para FALAR no idioma da pergunta, ate 150 caracteres" },
              lang: { type: "string", description: "idioma da fala, ex.: pt-BR, en-US, es-ES" }
          }, required: ["text"] } } },
        { type: "function", function: { name: "dog_music",
          description: "Musica ao vivo (chiptune de ate 4 canais) com festa de LEDs e dancinha AUTOMATICAS: voce orquestra um groove (bateria + baixo + tema curto) e o cao toca piscando as luzes e balancando no ritmo",
          parameters: { type: "object", properties: {
              bpm: { type: "integer", description: "andamento 60..200 (128 = festa)" },
              loops: { type: "integer", description: "repeticoes do padrao, 1..8 (default 4)" },
              tracks: { type: "array", maxItems: 4, items: { type: "object" },
                  description: 'trilhas: {drum:true,vol,notes:[[36,2],[42,1],[42,1],[38,2],[42,1],[42,1]]} = bateria GM ' +
                      '(36 bumbo, 38 caixa, 42 chimbal); {wave:"sq"|"sq25"|"tri"|"saw",vol,notes:[[midi,semicolcheias],...]} = melodia/baixo. ' +
                      'Nota [midi 0..96, duracao em SEMICOLCHEIAS; 0 = pausa]. COMPACTO: 8..16 notas por trilha, ' +
                      'todas as trilhas do mesmo comprimento total (somam as semicolcheias) para girarem juntas' }
          }, required: ["tracks"] } } },
        { type: "function", function: { name: "dog_script",
          description: "Performance LIVRE e unica: voce escreve um script JS ES5 e o cao roda ao vivo (cara no display, pernas, LEDs e som juntos). Use para se expressar do seu jeito",
          parameters: { type: "object", properties: {
              code: { type: "string", description:
                  'JS ES5 puro (SEM const/let/arrow/template string), ate 1200 chars, ' +
                  'loops com limite fixo (max 30) e SEMPRE wait(ms) entre passos. ' +
                  'API: face.clear() face.eyes(open,lx,ly,pupilaR) face.heart(x,y,s) ' +
                  'face.fillRect(x,y,w,h) face.rect/circle/fillCircle/line/tri(x0,y0,x1,y1,x2,y2)/roundRect/fillRoundRect. ' +
                  'coordenadas do vidro 0..127 x 0..63, display MONO (aceso/apagado). ' +
                  'legs.set("FL"|"FR"|"BL"|"BR",graus -45..45) legs.pose("stand|sit|lie|stretch|beg|pee") ' +
                  'legs.step("walk|back|left|right",ciclos 1..20) legs.release(). ' +
                  'leds.set(fita 0|1,[cores 0xRRGGBB ou "#rrggbb", 1..4]) leds.off(). ' +
                  'sound.bark("woof|yip|growl|whine|howl",n 1..3) sound.tone([[freq,ms],...]). ' +
                  'say("frase curta") wait(ms) print(msg). ' +
                  'Musica nao bloqueante: music.play({bpm,loops,tracks}(como dog_music)) music.stop() ' +
                  'music.playing() music.pos(): coreografe luzes/patas no loop enquanto toca' }
          }, required: ["code"] } } },
        { type: "function", function: { name: "dog_stop",
          description: "Para movimento/truque na hora",
          parameters: { type: "object", properties: {} } } }
    ];
}

// Despacho de UM tool_call: tudo passa pelo sequenciador (mesmos clamps
// e interrupcoes dos truques).
function voiceRunTool(call) {
    if (!call || !call.name) return false;
    var a = call.args || {};
    if (call.name === "dog_move") {
        var dir = WALKS[a.direction] ? String(a.direction) : "walk";
        happyUntil = System.millis() + 900;
        // "ande 10 passos" (steps x ciclo da marcha) ou "ande por 1 minuto"
        // (ms). Ate SEQ_STEP_MS vai pela fila como antes; acima disso a
        // marcha vira continua com prazo proprio (corta no prazo, pelo wake
        // word ou dog_stop) — o teto de 3 s da fila engolia qualquer pedido.
        var nSteps = Math.round(clampNum(a.steps, 1, 120, 0));
        var ms = nSteps ? nSteps * gaitCycleMs(dir)
                        : clampNum(a.ms, 150, VOICE_MOVE_MAX_MS, 1200);
        if (ms > VOICE_MOVE_MAX_MS) ms = VOICE_MOVE_MAX_MS;
        System.print('[voz] move ' + dir + ' ' + ms + ' ms (' +
            (nSteps ? nSteps + ' passos' : 'duracao') + ')');
        if (ms <= SEQ_STEP_MS) {
            return runSeq(buildSeq([{ do: "move", dir: dir, ms: ms }], 4, 0), "voz:move");
        }
        seqClear();
        if (startGait(dir, true)) {
            voiceWalkUntil = System.millis() + ms;
            return true;
        }
        return false;
    }
    if (call.name === "dog_posture") {
        if (!POSES[a.pose]) return false;
        happyUntil = System.millis() + 900;
        return runSeq(buildSeq([{ do: "pose", name: String(a.pose), ms: 800 }], 4, 0), "voz:pose");
    }
    if (call.name === "dog_trick") return runTrick(a.name);
    if (call.name === "dog_sequence") {
        var seq = buildSeq(a.steps, 10, 0);
        if (!seq.length) return false;
        System.print('[voz] coreografia: ' + JSON.stringify(a.steps).substring(0, 200));
        return runSeq(seq, "voz:sequencia");
    }
    if (call.name === "dog_bark") {
        playBark(a.kind, a.times);
        setMood("happy", 1500);
        return true;
    }
    if (call.name === "dog_emotion") return setMood(a.mood, 4500);
    if (call.name === "dog_say") {
        if (!a.text) return false;
        showSay(String(a.text));
        return true;
    }
    if (call.name === "dog_speak") {
        if (!a.text) return false;
        pendingSpeak = { text: String(a.text), lang: a.lang ? String(a.lang) : "" };
        return true;   // o loop executa com cedidas entre as etapas
    }
    if (call.name === "dog_music") {
        var aiSong = musicClampSong(a);
        if (!aiSong) { System.print('[voz] musica rejeitada: vazia'); return false; }
        pendingMusic = aiSong;
        return true;   // o loop executa (a festa dura segundos)
    }
    if (call.name === "dog_script") {
        var scode = String(a.code || "");
        var sguard = scriptGuards(scode);
        if (sguard) { System.print('[voz] script rejeitado: ' + sguard); return false; }
        pendingScript = scode;
        return true;   // o loop executa com cedidas entre as etapas
    }
    if (call.name === "dog_stop") {
        seqClear();
        stopGait();
        voiceWalkUntil = 0;
        return true;
    }
    return false;
}

function voiceRequest(audioB64) {
    if (!hasAI) { voiceDone(false); return; }
    var tStop = System.millis();
    voiceTEnd = voiceTEnd || tStop;
    try {
        var started = AI.chat({
            provider: "openrouter",
            messages: [
                { role: "system", content: voicePrompt() },
                { role: "user", content: [
                    { type: "input_audio", input_audio: { data: audioB64, format: "wav" } }
                ]}
            ],
            tools: voiceTools(),
            tool_choice: "auto",
            max_tokens: 1000,  // groove de 3 trilhas em notas compactas
            reasoning: { effort: "low" }
        }, function (r) {
            cueGot();   // resposta da IA chegou (bancada: fim da espera muda)
            var done = false;
            var tCb = System.millis();
            System.print('[voz] tempos: fala ' + (voiceTEnd - voiceT0) + ' ms, stop ' +
                (tStop - voiceTEnd) + ' ms, chat ' + (tChat - tStop) + ' ms, ia ' +
                (tCb - tChat) + ' ms, total pos-fala ' + (tCb - voiceTEnd) + ' ms, audio ' +
                (audioB64 ? audioB64.length : 0) + ' B');
            // o que o modelo respondeu (diagnostico no logcat: sem isto um
            // "nao deu certo" nao tinha como ser explicado)
            System.print('[voz] ia: ' + JSON.stringify({
                ok: r && r.ok, status: r && r.status, fim: r && r.finishReason,
                tools: r && r.toolCalls, txt: r && r.content ? String(r.content).substring(0, 160) : null,
                erro: r && r.error ? String(r.error).substring(0, 120) : null }));
            if (r && r.ok && r.toolCalls && r.toolCalls.length) {
                for (var i = 0; i < r.toolCalls.length && !done; i++) done = voiceRunTool(r.toolCalls[i]);
            }
            if (!done && r && r.ok) done = voiceFromText(r.content);
            voiceDone(done);
        });
        var tChat = System.millis();
        if (!started) voiceDone(false);
        else cueSent();   // fala enviada: blip unico (bancada: saber que saiu)
    } catch (e) {
        System.print('[voz] erro: ' + e);
        voiceDone(false);
    }
}

function voiceDone(ok) {
    voiceBusy = false;
    voiceRing(false, !ok);
    // fim: trinado de sucesso — salvo quando a fala ainda vai tocar (ja
    // agendada ou em curso: o "fim" dessa interacao e o fim do PLAYBACK)
    if (ok && !speakBusy && pendingSpeak === null) cueDone();
    else if (!ok) cueVoice(false);
    if (ok) happyUntil = System.millis() + 1600;
    lastActivity = System.millis();
    voiceErrorAt = ok ? 0 : System.millis();
}

function voiceTick(now) {
    if (!voiceReady) return;
    // janela de gravacao: fim por teto, por silencio pos-fala ou por tempo
    if (voiceRec) {
        var lvl = Mic.level();
        voiceLvl = lvl > 0 ? lvl : 0;
        if (lvl > 22) { voiceHeard = true; voiceQuietAt = 0; }
        else if (voiceHeard && lvl < 5) {
            if (!voiceQuietAt) voiceQuietAt = now + 550;
            else if (now >= voiceQuietAt) { voiceRec = false; voiceTEnd = now; voiceRequest(Mic.stop()); }
        }
        if (voiceRec && !Mic.recording()) { voiceRec = false; voiceTEnd = now; voiceRequest(Mic.stop()); }
        return;
    }
    // wake -> abre a janela (a task do detector descansa sozinha durante
    // a gravacao — micRecActive no firmware). Fala do TTS em curso (e a
    // cauda do eco): o detector segue vivo, mas surdo — o poll e drenado.
    if (wakeMuted || speakBusy || now < wakeMuteUntil) {
        WakeWord.poll();   // drena: deteccao do eco da propria voz nao vale
        return;
    }
    if (!voiceBusy &&
        (voiceErrorAt === 0 || now - voiceErrorAt > 2500) && WakeWord.poll()) {
        if (seqActive() || voiceWalkUntil) {   // "hi celer" corta dancinha/marcha
            seqClear(); stopGait(); voiceWalkUntil = 0;
        }
        voiceBusy = true;
        voiceHeard = false;
        voiceQuietAt = 0;
        voiceT0 = now;
        voiceTEnd = 0;
        lastActivity = now;
        cueVoice(true);
        voiceRing(true, false);
        if (Mic.start({ ms: 3500 })) {
            voiceRec = true;
            // TLS aberto enquanto o dono fala: o chat do fim da janela pula
            // DNS+TCP+handshake (~2,2 s medidos no log de bancada)
            if (hasAI && typeof AI.warm === "function") AI.warm("openrouter");
        } else {
            voiceDone(false);
        }
    }
}

if (voiceReady) {
    if (WakeWord.start()) {
        System.print('[voz] wake word "hi celer" ativo');
    } else {
        System.print('[voz] wake word indisponivel (modelo/RAM)');
        voiceReady = false;
    }
}

// ------------------------------ performances da IA (dog_script) -----------
// A tool dog_script deixa a LLM ESCREVER a propria performance: um script
// ES5 que roda aqui com uma mini-API de coreografia (cara, pernas, LEDs e
// som) e so isso — os bindings do app (System, FS, Net, AI...) ficam
// invisiveis por shadowing de parametros do new Function (o mesmo eval que
// o Terminal ja usa, so que cercado). Clamps fisicos moram na propria API
// (angulos ±45, 4 LEDs por fita, teto de notas), a entrada rejeita loop
// infinito obvio e ha teto de relogio; o exec-timeout de 1 s do firmware e
// o ultimo guarda-chuva (loop que nao cede mata o app, nao o cao). A
// performance bloqueia o loop pelo mesmo modelo das marchas (runFrame):
// cada wait() cede via System.delay -> present(). Cutucar o touch pad
// interrompe na hora (scriptAlive) — bench e dono sempre tem um freio.
var SCRIPT_MAX = 1600;   // chars de codigo (o prompt pede <= 1200)
var SCRIPT_MS = 20000;   // teto de relogio da performance
var SCRIPT_AMP = 45;     // graus fisicos do legs.set (poses nativas podem mais)
var scriptUntil = 0, scriptAbort = false;
var pendingScript = null;   // dog_script so AGENDA: o loop executa (o padrao
                            // pendingSpeak — a cadeia inteira dentro do
                            // callback do chat estourava a janela de 1 s)

function scriptAlive() {
    if (scriptAbort) return false;
    if (System.touchPad() === 1) { scriptAbort = true; return false; }
    return System.millis() <= scriptUntil;
}

function scriptGuards(code) {
    if (code.length < 10) return "codigo curto demais";
    if (code.length > SCRIPT_MAX) return "codigo passa de " + SCRIPT_MAX + " chars";
    var z = code.replace(/\s+/g, "");   // sem espacos: while ( true ) nao escapa
    if (z.indexOf("while(true)") >= 0 || z.indexOf("while(1)") >= 0 ||
        z.indexOf("for(;") >= 0)
        return "loop infinito proibido (use for com limite + wait)";
    return "";
}

// Rampa ate target[] — a mesma do legTick do loop, so que bloqueante (o
// loop esta parado dentro da performance). Cada passo cede com delay(10).
function scriptRamp() {
    var last = System.millis();
    while (scriptAlive()) {
        var now = System.millis();
        var dt = now - last; last = now;
        if (dt > 150) dt = 150;
        legTick(dt);
        var done = true;
        for (var i = 0; i < KEYS.length; i++)
            if (Math.abs(target[KEYS[i]] - off[KEYS[i]]) > 0.5) { done = false; break; }
        if (done) break;
        System.delay(10);
    }
    return true;
}

// Anda N ciclos da marcha SEM dono de tela: ninguem desenha, o rosto do
// script fica congelado no vidro enquanto as pernas trabalham.
function scriptStep(dir, cycles) {
    if (!WALKS[dir]) return false;
    cycles = Math.round(clampNum(cycles, 1, 20, 1));
    seqClear();
    if (!startGait(dir, true)) return false;
    var until = System.millis() + cycles * gaitCycleMs(dir);
    var last = System.millis();
    while (scriptAlive()) {
        var now = System.millis();
        var dt = now - last; last = now;
        if (dt > 150) dt = 150;
        gaitTick(dt);
        if (now >= until) break;
        System.delay(15);
    }
    if (gait !== null) stopGait();
    return true;
}

// Cor "0xRRGGBB" numero ou "#rrggbb" -> 0xRRGGBB (o que o neopixel fala).
function scriptLedColor(c) {
    if (typeof c === "number") return c & 0xFFFFFF;
    if (typeof c === "string") {
        var h = c.charAt(0) === "#" ? c.substring(1) : c;
        if (/^[0-9a-fA-F]{6}$/.test(h)) return parseInt(h, 16);
    }
    return 0;
}

// A mini-API que o script da IA ve (e tudo o que ele ve): coordenadas de
// cara no vidro FISICO 128x64 (conversao PX/PY interna), pernas na
// convencao fisica + = pata pra frente, LEDs 2 fitas x 4, sons clampados.
function scriptApi() {
    function cx(v) { return clampNum(v, -512, 512, 0); }
    function cw(v) { return Math.abs(cx(v)) || 1; }
    function cr(v, dflt) { return clampNum(v, 1, 64, dflt); }
    var face = {
        clear: function () { System.fillScreen(0); },
        // olhos do cachorro: open (0/1), olhar lx/ly -1..1, raio da pupila
        eyes: function (open, lx, ly, r) {
            drawEyes(!!open, clampNum(r, 2, 14, 10),
                     clampNum(lx, -1, 1, 0), clampNum(ly, -1, 1, 0));
        },
        heart: function (x, y, s) { drawHeart(cx(x), cx(y), clampNum(s, 4, 40, 12)); },
        rect: function (x, y, w, h) {
            System.drawRect(PX(cx(x)), PY(cx(y)), PW_(cw(w)), PH_(cw(h)), 0xFFFF); },
        fillRect: function (x, y, w, h) {
            System.fillRect(PX(cx(x)), PY(cx(y)), PW_(cw(w)), PH_(cw(h)), 0xFFFF); },
        circle: function (x, y, r) {
            System.drawCircle(PX(cx(x)), PY(cx(y)), PW_(cr(r, 4)), 0xFFFF); },
        fillCircle: function (x, y, r) {
            System.fillCircle(PX(cx(x)), PY(cx(y)), PW_(cr(r, 4)), 0xFFFF); },
        line: function (x0, y0, x1, y1) {
            System.drawLine(PX(cx(x0)), PY(cx(y0)), PX(cx(x1)), PY(cx(y1)), 0xFFFF); },
        tri: function (x0, y0, x1, y1, x2, y2) {
            System.fillTriangle(PX(cx(x0)), PY(cx(y0)), PX(cx(x1)), PY(cx(y1)),
                                PX(cx(x2)), PY(cx(y2)), 0xFFFF); },
        roundRect: function (x, y, w, h, r) {
            System.drawRoundRect(PX(cx(x)), PY(cx(y)), PW_(cw(w)), PH_(cw(h)),
                                 PW_(clampNum(r, 0, 32, 4)), 0xFFFF); },
        fillRoundRect: function (x, y, w, h, r) {
            System.fillRoundRect(PX(cx(x)), PY(cx(y)), PW_(cw(w)), PH_(cw(h)),
                                 PW_(clampNum(r, 0, 32, 4)), 0xFFFF); }
    };
    var legs = {
        set: function (k, deg) {
            k = String(k || "").toUpperCase();
            if (KEYS.indexOf(k) < 0) return false;
            if (gait !== null) stopGait();
            target[k] = FWD[k] * clampNum(deg, -SCRIPT_AMP, SCRIPT_AMP, 0);
            return scriptRamp();
        },
        pose: function (name) {
            if (!POSES[name]) return false;
            if (gait !== null) stopGait();
            setPose(POSES[name]);
            return scriptRamp();
        },
        step: function (dir, cycles) { return scriptStep(String(dir), cycles); },
        release: function () { legsRelease(); return true; }
    };
    var leds = {
        set: function (strip, colors) {
            var s = strip === 1 || strip === "b" ? 1 : 0;
            var px = [];
            if (colors && colors.length)
                for (var i = 0; i < colors.length && i < 4; i++)
                    px.push(scriptLedColor(colors[i]));
            if (!px.length) return false;
            ledAnim = "off";   // o ledTick do loop nao briga com o script
            return !!System.neopixel(s, px);
        },
        off: function () { return ledsOff(); }
    };
    var sound = {
        bark: function (kind, n) { playBark(kind, n); return true; },
        tone: function (notes) {
            // firmware: 64 notas / 15 s no total / nota 1-2000 ms — clampado
            // aqui em 32 notas e 15 s antes de chegar no RangeError dele
            var seq = [], total = 0;
            if (notes && notes.length)
                for (var i = 0; i < notes.length && seq.length < 32; i++) {
                    var nt = notes[i];
                    if (!nt || nt.length < 2) continue;
                    var ms = Math.round(clampNum(nt[1], 1, 2000, 100));
                    if (total + ms > 15000) break;
                    total += ms;
                    seq.push([Math.round(clampNum(nt[0], 20, 20000, 440)), ms]);
                }
            if (!seq.length) return false;
            return System.playTone(seq) > 0;
        }
    };
    return {
        face: face, legs: legs, leds: leds, sound: sound,
        say: function (text) {
            showSay(String(text || "").substring(0, 60), "", true);
            return true;
        },
        wait: function (ms) {
            ms = Math.round(clampNum(ms, 0, 3000, 0));
            var t0 = System.millis();
            while (System.millis() - t0 < ms) {
                if (!scriptAlive()) return false;
                var left = ms - (System.millis() - t0);
                System.delay(left > 100 ? 100 : left);   // fatia: aborta rapido
            }
            return true;
        },
        music: {
            // a musica roda no firmware (nao bloqueia): coreografe luzes e
            // patas no loop do script enquanto ela toca
            play: function (song) {
                var s2 = musicClampSong(song);
                if (!s2 || typeof System.playMusic !== "function") return false;
                try { return !!System.playMusic(s2); } catch (e) { return false; }
            },
            stop: function () { if (typeof System.musicStop === "function") System.musicStop(); return true; },
            playing: function () {
                if (typeof System.musicPlaying !== "function") return false;
                try { return System.musicPlaying() === true; } catch (e) { return false; }
            },
            pos: function () {
                if (typeof System.musicPos !== "function") return -1;
                try { return System.musicPos(); } catch (e) { return -1; }
            }
        },
        print: function (msg) { System.print('[script] ' + msg); }
    };
}

// Globais que o script NAO ve: entram como parametro do new Function com
// valor undefined (shadowing). Sandbox soft por intencao: o modelo so
// conhece a mini-API documentada na tool e os clamps fisicos estao na
// propria API — nao e uma barreira contra codigo hostil.
var SCRIPT_SHADOW = "System,FS,Net,AI,Mic,WakeWord,CelerLink,Storage,UI,Sensors," +
    "Phone,setTimeout,setInterval,clearTimeout,clearInterval,require," +
    "face,legs,leds,sound,say,wait,music,print";

function runAiScript(code) {
    var t0 = System.millis();
    code = String(code || "");
    var err = scriptGuards(code);
    if (!err) {
        // a performance e dona do cao: para marcha/fila, acorda e surda o
        // wake word (os proprios tons/latidos acordariam o "hi celer")
        seqClear();
        if (gait !== null) stopGait();
        if (legsLimp) { legsLimp = false; legsHold(); }
        sleeping = false;
        scriptUntil = t0 + SCRIPT_MS;
        scriptAbort = false;
        speakWake(false);
        try {
            var fn = new Function(SCRIPT_SHADOW, code);
            var api = scriptApi();
            fn(undefined, undefined, undefined, undefined, undefined, undefined,
               undefined, undefined, undefined, undefined, undefined, undefined,
               undefined, undefined, undefined, undefined,
               api.face, api.legs, api.leds, api.sound, api.say, api.wait,
               api.music, api.print);
        } catch (e) {
            err = String(e && e.message ? e.message : e).substring(0, 120);
        }
        // restaura: target = off para a rampa do loop nao desfazer a pose
        // final; LEDs apagados (mood/happy do after reacendem; zero direto —
        // o setLeds("off") early-returna se ledAnim ja vale "off" do script);
        // detector de volta com a cauda de eco coberta
        for (var i = 0; i < KEYS.length; i++) target[KEYS[i]] = off[KEYS[i]];
        ledAnim = "off";
        System.neopixel(0, [0, 0, 0, 0]);
        System.neopixel(1, [0, 0, 0, 0]);
        speakWake(true);
        happyUntil = System.millis() + 900;
        lastActivity = System.millis();
        draw();
    }
    var ms = System.millis() - t0;
    System.print('[voz] script ' + (err ? 'erro: ' + err : 'ok') +
                 ' (' + ms + ' ms, ' + code.length + ' chars)');
    reply({ type: "script", ok: !err, ms: ms, err: err || undefined });
    return !err;
}

// ------------------------------ musica da IA (dog_music) -------------------
// "Clima de festa": a LLM orquestra um MIDI de poucos canais (tool
// dog_music) e o firmware mistura ao vivo (System.playMusic, API 25 —
// chiptune com bateria GM). Aqui nos so coreografamos: LEDs piscam na
// colcheia e as dianteiras balancam na batida, acompanhando musicPos().
// Firmware antigo (sem playMusic) cai no jingle de playTone com a MESMA
// festa de luz/patas — a tool funciona sempre.
var pendingMusic = null;

function musicClampSong(a) {
    if (!a) return null;
    var s = { bpm: Math.round(clampNum(a.bpm, 60, 200, 120)),
              loops: Math.round(clampNum(a.loops, 1, 8, 4)), tracks: [] };
    var tr = a.tracks || [];
    var WAVES = ["sq", "sq25", "tri", "saw"];
    for (var i = 0; i < tr.length && s.tracks.length < 4; i++) {
        var t = tr[i] || {};
        var nt = { drum: t.drum === true,
                   wave: WAVES.indexOf(t.wave) >= 0 ? t.wave : "sq",
                   vol: Math.round(clampNum(t.vol, 0, 100, 80)), notes: [] };
        var ns = t.notes || [];
        for (var k = 0; k < ns.length && nt.notes.length < 48; k++) {
            var pr = ns[k];
            if (!pr || pr.length < 2) continue;
            nt.notes.push([Math.round(clampNum(pr[0], 0, 96, 0)),
                           Math.round(clampNum(pr[1], 1, 64, 4))]);
        }
        if (nt.notes.length) s.tracks.push(nt);
    }
    return s.tracks.length ? s : null;
}

// Duracao total estimada (mesma conta do motor: trilha mais longa manda).
function musicTotalMs(song) {
    var beatMs = 60000 / song.bpm;
    var longest = 0;
    for (var i = 0; i < song.tracks.length; i++) {
        var sum = 0;
        var ns = song.tracks[i].notes;
        for (var k = 0; k < ns.length; k++) sum += ns[k][1];
        if (sum > longest) longest = sum;
    }
    return longest * beatMs / 4 * song.loops;
}

// Festa de luzes: hue gira por colcheia, strobe forte/fraco no tempo.
function partyLights(step) {
    var c = ledHsv((step * 0.125) % 1);
    var lo = ledDim(c, 0.25);
    var px = (step & 1) ? [c, lo, c, lo] : [lo, c, lo, c];
    System.neopixel(0, px);
    System.neopixel(1, px);
}

function musicShow(song) {
    var t0 = System.millis();
    seqClear();
    if (gait !== null) stopGait();
    if (legsLimp) { legsLimp = false; legsHold(); }
    sleeping = false;
    speakWake(false);   // a propria musica acordaria o "hi celer"
    ledAnim = "off";
    var totalMs = musicTotalMs(song);
    if (totalMs > 120000) totalMs = 120000;
    var beatMs = 60000 / song.bpm;
    var live = false;
    if (typeof System.playMusic === "function") {
        try { live = System.playMusic(song); } catch (e) { live = false; }
    }
    if (!live) {
        // firmware antigo / falante ocupado: jingle da 1a trilha melodica
        var mel = null;
        for (var i = 0; i < song.tracks.length && !mel; i++)
            if (!song.tracks[i].drum) mel = song.tracks[i];
        if (mel) {
            var seqT = [];
            for (var k = 0; k < mel.notes.length && seqT.length < 24; k++) {
                var nn = mel.notes[k];
                if (nn[0] > 0) seqT.push([
                    Math.round(440 * Math.pow(2, (nn[0] - 69) / 12)),
                    Math.round(nn[1] * beatMs / 4)]);
            }
            if (seqT.length) System.playTone(seqT);
        } else {
            playBark("yip", 2);
        }
    }
    System.print('[musica] festa ' + song.bpm + ' bpm, ' + song.tracks.length +
                 ' trilhas, ' + Math.round(totalMs) + ' ms (' +
                 (live ? 'synth' : 'jingle') + ')');
    var lastStep = -1, last = System.millis();
    while (true) {
        var now = System.millis();
        var pos = live ? System.musicPos() : (now - t0 < totalMs ? now - t0 : -1);
        if (pos < 0) break;                        // acabou (ou cortaram)
        if (System.touchPad() === 1) {             // cutucar para a festa
            if (live && System.musicStop) System.musicStop();
            break;
        }
        var step = Math.floor(pos / (beatMs / 2));  // colcheias
        if (step !== lastStep) {
            lastStep = step;
            partyLights(step);
            if (step % 2 === 0) {                   // na batida: bob das dianteiras
                var a = (step % 4 === 0) ? 12 : -12;
                target.FL = FWD.FL * a;
                target.FR = FWD.FR * a;             // opostas: balanco
            }
        }
        var dt = now - last; last = now;
        if (dt > 150) dt = 150;
        legTick(dt);    // rampa suave das patinhas
        System.delay(30);
    }
    setPose(POSES.stand);
    var settle0 = System.millis();
    while (System.millis() - settle0 < 300) { legTick(30); System.delay(30); }
    ledAnim = "off";
    System.neopixel(0, [0, 0, 0, 0]);
    System.neopixel(1, [0, 0, 0, 0]);
    speakWake(true);
    happyUntil = System.millis() + 1200;
    lastActivity = System.millis();
    draw();
    reply({ type: "music", ok: true, ms: System.millis() - t0, bpm: song.bpm });
    return true;
}

var telAt = 0;
var moveAt = 0;
var MOVE_KEEPALIVE_MS = 900;  // sem move novo nesse prazo = para (failsafe)
function linkTick(now) {
    if (!hasLink) return;
    var st = CelerLink.status();
    linkUp = !!(st && st.connected);
    // Handshake pendente: status.code so existe no periferico (API 11);
    // firmware derruba sozinho em 60 s ou 3 codigos errados
    pairShow = !!(st && st.pairing && st.code);
    if (pairShow) pairCode = String(st.code);
    if (pairWas && !pairShow && linkUp) {
        happyUntil = System.millis() + 1400;  // codigo aceito: festa
    }
    pairWas = pairShow;
    if (pairShow) lastActivity = now;  // alguem vai digitar: sem dormir
    // esvazia a fila: o loop e lento (~60 ms + desenho) e o Remote manda
    // em rajadas; so um por volta acumularia comandos velhos
    for (var k = 0; k < 8; k++) {
        var msg = CelerLink.poll();
        if (msg === null || msg === undefined) break;
        if (msg === "") continue;
        var m = null;
        try { m = JSON.parse(msg); } catch (e) { m = null; }
        if (m) handleMsg(m);
    }
    // canal selado: so credenciais autenticadas com o pareamento
    if (canWifi) {
        for (var q = 0; q < 2; q++) {
            var sm = CelerLink.pollSealed();
            if (sm === null || sm === undefined) break;
            var sv = null;
            try { sv = JSON.parse(sm); } catch (e2) { sv = null; }
            sm = null;
            if (sv && sv.type === "wifi") wifiApply(sv);
        }
    }
    // failsafe: link caiu ou o controle parou de repetir o move (soltou a
    // seta e o stop se perdeu) -> o robo nao sai andando sozinho
    if (linkDrive && (!linkUp || System.millis() - moveAt > MOVE_KEEPALIVE_MS)) {
        stopGait();
    } else if (linkGait && !linkUp) {
        stopGait();
    }
    if (hasNet && now - netAt > 2000) {
        netAt = now;
        netUp = !!Net.isConnected();
    }
    // telemetria periodica enquanto conectado (o remote mostra batt/state)
    if (linkUp) lastActivity = now;
    if (linkUp && now - telAt > 1500) {
        telAt = now;
        sendTel();
    }
}

// ------------------------------------------------------------------ main ---
// despertar: pulso de centro em cada perna (servo solto nao segura posicao),
// olhos fecham e abrem devagar
legsHold();
System.delay(250);
blinkUntil = System.millis() + 900;
happyUntil = System.millis() + 1400;

var FRAME_MS = 60;
var SLEEP_MS = 120000;      // 2 min sem comando/toque e sem link
var lastLoop = System.millis();
while (true) {
    var now = System.millis();
    var dt = now - lastLoop;
    lastLoop = now;
    if (dt > 150) dt = 150;     // volta travada (scan, flush longo): sem salto de pose

    if (now >= blinkAt) {
        blinkUntil = now + 140;
        blinkAt = now + 1600 + Math.floor(Math.random() * 3200);
    }
    if (moveDir !== null) {
        lookX = moveDir;            // andando: olhos na direcao do movimento
        lookY = 0;
    } else if (now >= lookT) {
        lookT = now + 700 + Math.floor(Math.random() * 1500);
        lookX = Math.random() * 2 - 1;
        lookY = Math.random() * 1.4 - 0.7;
    }
    breath += 0.13 * dt / 60;

    // sono: sem comando/toque e sem link = olhos fechados, servos soltos
    // (parado em pe o servo gasta corrente segurando), mic mais espacado
    if (!sleeping && now - lastActivity > SLEEP_MS && !linkUp && !pairShow && !gait && !seqActive()) {
        sleeping = true;
        seqClear();
        ledsOff();
        legsRelease();
    }
    if (sleeping && (linkUp || pairShow || happyUntil > now)) {
        sleeping = false;
        lastActivity = now;
        if (legsLimp) { legsLimp = false; legsHold(); }
    }

    // andando: mic mede o ruido dos proprios servos, e cada leitura atrasa
    // a proxima fase — pula
    if (!walking() && !voiceRec && now - micAt > (sleeping ? 1500 : 400)) {
        micAt = now;
        lastMic = System.micLevel();
        if (lastMic < 0) lastMic = 0;
        if (sleeping && lastMic > 45) happyUntil = now + 1200;   // barulho acorda
        else if (lastMic > 30 && happyUntil < now) lookY = -1;
    }
    if (now - battAt > 10000) {
        battAt = now;
        lastBatt = System.battery();
        // primeira vez abaixo de 20%: ganido + cara triste (uma vez so;
        // rearma acima de 25% — histerese contra o ruido do divisor)
        if (battPct() < 20 && !battWarned) {
            battWarned = true;
            playBark("whine", 1);
            setMood("sad", 2500);
        } else if (battPct() > 25) battWarned = false;
    }
    // pad lido toda volta; a soltura so vale apos 2 leituras soltas
    // seguidas (um 0 espurio no meio do toque nao vira "carinho")
    var pad = System.touchPad();
    if (pad === 1) {
        padZeros = 0;
        if (!padDownAt) padDownAt = now;
        padHeld = true;
    } else if (padHeld && ++padZeros >= 2) {
        // soltou: >5s = esquece os controles pareados; longo (>600ms) =
        // ciclo de gait; curto = carinho
        lastActivity = now;
        if (padDownAt && now - padDownAt > 5000) {
            if (hasLink && CelerLink.unpair) CelerLink.unpair();
            System.print('[dog] pareamentos esquecidos (hold 5s)');
            happyUntil = now + 2000;
        } else if (padDownAt && now - padDownAt > 600) cycleGait();
        else happyUntil = now + 1600;
        padHeld = false;
        padDownAt = 0;
        padZeros = 0;
    }

    voiceTick(now);
    if (voiceWalkUntil && now > voiceWalkUntil) {
        voiceWalkUntil = 0;
        seqClear();
        stopGait();
    }
    // fala agendada pelo dog_speak (fora do callback do chat: cada etapa
    // pesada ganha sua propria janela de execucao entre cedidas)
    if (pendingSpeak !== null && !voiceBusy) {
        var ps = pendingSpeak;
        pendingSpeak = null;
        speakStart(ps.text, ps.lang);
    }
    // performance da IA (dog_script): depois de qualquer fala — mover
    // durante o TTS trocaria os sons
    if (pendingScript !== null && !voiceBusy && !speakBusy &&
        pendingSpeak === null) {
        var aiCode = pendingScript;
        pendingScript = null;
        runAiScript(aiCode);
    }
    // festa musical (dog_music): por ultimo — dura mais que tudo
    if (pendingMusic !== null && !voiceBusy && !speakBusy &&
        pendingSpeak === null && pendingScript === null) {
        var aiTune = pendingMusic;
        pendingMusic = null;
        musicShow(aiTune);
    }
    linkTick(now);
    if (mood && now > moodUntil) mood = "";
    ledTick(now);
    seqTick(now);   // sequenciador roda ANTES da gait: o passo move ja vale
    gaitTick(dt);
    // andando, o flush do OLED (~100 ms no I2C) entre as fases viraria
    // pausa extra no meio do passo: desenha so uma vez por ciclo
    if (!walking() || gait.frames || gaitPhase === 0) draw();
    var spent = System.millis() - now;
    System.delay(spent < FRAME_MS - 10 ? FRAME_MS - spent : 10);
}
