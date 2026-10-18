




















var mesh = { version: '1.0.1' };


mesh.available = function () {
return typeof CelerNet !== "undefined" && typeof Pack !== "undefined";
};


mesh.active = function () {
return mesh.available() && CelerNet.status().active;
};




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


mesh.me = function () {
if (!mesh._me) mesh._me = Pack.me();
return mesh._me;
};



mesh.each = function (cb, now) {
var n = 0, m;
while ((m = CelerNet.poll()) !== null) {
cb(m, now);
n++;
}
return n;
};

module.exports = mesh;
