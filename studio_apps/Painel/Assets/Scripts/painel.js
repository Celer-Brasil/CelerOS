// Controlador da tela "Painel" (runtime app): le o aparelho a cada segundo
// e aplica brilho/volume/auto-brilho quando os widgets mudam. O estado da tela
// (ctx.st) e o mesmo objeto que os widgets leem por chave.
exports.props = {
    intervalo: { type: 'int', default: 1000, min: 200, max: 10000, label: 'Intervalo (ms)' }
};

exports.create = function (ctx) {
    return { t: 0 };
};

function ler(ctx) {
    var st = ctx.st;
    var info = System.batteryInfo ? System.batteryInfo() : null;
    var pct = info && info.pct !== undefined ? info.pct : -1;
    st.bateria = pct >= 0 ? pct : 0;
    st.bateriaTexto = pct >= 0
        ? (pct + '%' + (info.charging ? ' carregando' : ''))
        : 'sem leitura';
    var wifi = System.isWiFiActive ? !!System.isWiFiActive() : false;
    st.redeTexto = wifi ? 'Wi-Fi ligado' : 'Wi-Fi desligado';
    st.ipTexto = wifi && System.getIPAddress ? String(System.getIPAddress()) : 'sem IP';
    st.versao = 'CelerOS ' + System.getOSVersion() + ' (API ' + System.getAPILevel() + ')';
}

exports.start = function (ctx) {
    var st = ctx.st;
    if (st.brilho === undefined) st.brilho = System.getBrightness ? System.getBrightness() : 60;
    if (st.volume === undefined) st.volume = System.getVolume ? System.getVolume() : 50;
    if (st.auto === undefined) st.auto = System.getAutoBrightness ? !!System.getAutoBrightness() : false;
    ler(ctx);
};

exports.update = function (dt, ctx) {
    this.t += dt;
    if (this.t >= (this.fields.intervalo || 1000)) {
        this.t = 0;
        ler(ctx);
    }
};

exports.event = function (name, value, ctx) {
    if (name === 'brilho') {
        if (System.setBrightness) System.setBrightness(value);
    } else if (name === 'volume') {
        if (System.setVolume) System.setVolume(value);
    } else if (name === 'auto') {
        if (System.setAutoBrightness) System.setAutoBrightness(!!value);
    } else if (name === 'atualizar') {
        ler(ctx);
        ctx.toast('Atualizado');
    }
};
