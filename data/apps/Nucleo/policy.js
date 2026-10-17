/* Politica PURA do Nucleo — sem device, testavel no js_harness.
 * Era UpdateCheck.h (C, testUpdateCheck no host); o "quando" agora e JS. */

// Gates do check automatico: WiFi no ar, SEM app em foreground, sem check
// em curso, sem sessao celerctl, grace de 60 s pos-conexao e 24 h entre
// checks (o intervalo vale por sessao — reboot reinicia, igual ao nativo).
exports.shouldCheck = function (st) {
    if (!st.wifiConnected || st.appOpen || st.busy || st.shell) return false;
    if (!st.graceOk) return false;
    return st.intervalOk;
};

// "1.2.3" -> [1, 2, 3]; prefixo v/lixo vira 0 (tolerante, igual ao SemVer.h)
function parts(v) {
    var out = [0, 0, 0];
    var p = String(v || "").replace(/^v/, "").split(".");
    for (var i = 0; i < 3 && i < p.length; i++) {
        var n = parseInt(p[i], 10);
        out[i] = isNaN(n) ? 0 : n;
    }
    return out;
}

exports.semverGreater = function (a, b) {
    var pa = parts(a), pb = parts(b);
    for (var i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return true;
        if (pa[i] < pb[i]) return false;
    }
    return false;
};

// Notifica 1x por versao: disponivel maior que a ultima notificada
// (vazia = nunca notificou). Reboot nao re-notifica a mesma versao.
exports.shouldNotify = function (lastNoted, availVer) {
    return !!availVer && exports.semverGreater(availVer, lastNoted || "");
};
