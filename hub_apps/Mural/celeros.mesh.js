// celeros.mesh — o boilerplate dos apps da malha CelerNet (API 27+) num
// require: gate de "ligue a malha" (card + botao), presenca/caps do Pack,
// e o drain da fila de quadros. Sem dependencias alem do firmware.
//
// Uso tipico (veja Sonar/Coral/Mural/Sentinela/Batata Quente):
//   var mesh = require("celeros.mesh");
//   while (true) {
//       var full = UI.begin();
//       if (UI.header("App", { back: true })) System.exitApp();
//       if (!mesh.gate("Ligue a malha (app Matilha) para ...")) { UI.end(); continue; }
//       var me = mesh.me();                  // {name, caps} do Pack (cacheado)
//       var now = System.millis();
//       mesh.each(onMsg, now);               // drena CelerNet.poll()
//       ...
//       UI.end();
//   }
//
// O gate devolve true quando a malha esta ATIVA (app segue o frame normal)
// e false quando desenhou o portao — nesse caso so falta UI.end() + continue.
// Em placa sem BT no firmware (globais ausentes) o card e fixo, sem botao.

var mesh = { version: '1.0.1' };

// firmware com CelerNet+Pack (placa com BT e build que os expoe)
mesh.available = function () {
    return typeof CelerNet !== "undefined" && typeof Pack !== "undefined";
};

// malha ligada e pronta (o app pode enviar/drenar)
mesh.active = function () {
    return mesh.available() && CelerNet.status().active;
};

// Portao dentro do UI.begin: card de aviso + botao "Ligar a malha" quando
// disponivel; card fixo quando a placa nao tem BT. opts.noRam muda o toast
// de RAM insuficiente do radio.
mesh.gate = function (msg, opts) {
    opts = opts || {};
    if (mesh.active()) return true;
    var T = System.theme();
    if (mesh.available()) {
        UI.card(10, 56, 220, 100);
        UI.text(msg || "Ligue a malha (app Matilha) para falar com os aparelhos ao redor.",
                22, 70, { w: 196, lines: 4 });
        UI.cardEnd();
        if (UI.button("Ligar a malha", 10, 168, 220, 36)) {
            if (!CelerNet.start({})) UI.toast(opts.noRam || "Sem RAM para o rádio agora");
        }
    } else {
        UI.card(10, 56, 220, 90);
        UI.text("Esta placa não tem Bluetooth no firmware.", 22, 70, { w: 196, lines: 3 });
        UI.cardEnd();
    }
    return false;
};

// Papel/capacidades do aparelho no bando (Pack.me), cacheado por execucao
mesh.me = function () {
    if (!mesh._me) mesh._me = Pack.me();
    return mesh._me;
};

// Drena a fila de quadros: cada quadro vai ao callback cb(m, now).
// Devolve quantos quadros entregou (0 = nada novo neste frame).
mesh.each = function (cb, now) {
    var n = 0, m;
    while ((m = CelerNet.poll()) !== null) {
        cb(m, now);
        n++;
    }
    return n;
};

module.exports = mesh;
