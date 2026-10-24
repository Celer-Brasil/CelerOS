// celeros.cloud — cliente do plano de controle Celer para apps de
// dispositivo (API 49: Net.request com headers). Standalone (nao decora o
// CelerKit): devolve o proprio objeto.
//
// Config: /local/celercloud.json
//   { "url": "https://<projeto>.supabase.co",     // base OU endpoint completo
//     "key": "sb_publishable_...",
//     "tenantId": "<uuid>", "deviceId": "a0b1c2d3e4f5",
//     "secret": "<segredo do device>",
//     "kind": "totem", "label": "Cancela 1", "board": "devkit-s3",
//     "heartbeatMs": 60000, "timeoutMs": 8000,
//     "endpoint": "..." }                          // opcional
//
// Uso tipico (app de totem/sensor):
//   var cloud = require("celeros.cloud");
//   if (!cloud.init()) { /* sem provisionamento: opera offline */ }
//   var desired = cloud.heartbeat();               // throttled por heartbeatMs
//   var cmds = cloud.commands();                   // drena comandos recebidos
//   cloud.ack(cmds[0].id);                         // confirma no proximo beat
//   cloud.report({type: "printer.paper_out", severity: "warning"});
//
// Contrato: nunca lanca; rede/HTTP ruim devolve null e mantem a fila local.
// A outbox (/local/cloud_outbox.json) viaja no proximo heartbeat. O segredo
// sai do device apenas no corpo do POST (TLS); a resposta nao o devolve.
//
// Permissoes do app.json: "net" (e "fs" para a outbox/config).
//
// 1.1.0: caps/resources (CelerNet/sensores), firmware/API auto e fila de
// comandos persistida (sobrevive a reboot; ack remove da fila).

var cloud = { version: '1.1.0' };

var CONFIG_PATH = '/local/celercloud.json';
var OUTBOX_PATH = '/local/cloud_outbox.json';
var DESIRED_PATH = '/local/cloud_desired.json';
var COMMANDS_PATH = '/local/cloud_commands.json';
var MAX_OUTBOX = 50;
var MAX_COMMANDS = 50;

var _cfg = null;
var _lastBeat = 0;
var _desired = null;
var _commands = [];
var _acks = [];
var _seq = 0;
var _lastError = '';

function readJSON(path, fallback) {
    try {
        if (typeof FS === 'undefined' || !FS.exists(path)) return fallback;
        var text = FS.readTextFile(path);
        if (!text) return fallback;
        return JSON.parse(text);
    } catch (e) {
        return fallback;
    }
}

function writeJSON(path, value) {
    try {
        FS.writeTextFile(path, JSON.stringify(value));
        return true;
    } catch (e) {
        return false;
    }
}

function millis() {
    try { return System.millis(); } catch (e) { return Date.now ? Date.now() : 0; }
}

function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
}

function netReady() {
    return typeof Net !== 'undefined' && typeof Net.request === 'function';
}

function osVersion() {
    try {
        return (typeof System !== 'undefined' && typeof System.getOSVersion === 'function')
            ? String(System.getOSVersion() || '') : '';
    } catch (e) { return ''; }
}

function osApiLevel() {
    try {
        return (typeof System !== 'undefined' && typeof System.getAPILevel === 'function')
            ? (Number(System.getAPILevel()) || 0) : 0;
    } catch (e) { return 0; }
}

function persistCommands() {
    if (_commands.length > MAX_COMMANDS) {
        _commands = _commands.slice(_commands.length - MAX_COMMANDS);
    }
    return writeJSON(COMMANDS_PATH, _commands);
}

cloud.init = function (path) {
    _cfg = null;
    _desired = null;
    _commands = readJSON(COMMANDS_PATH, []);
    if (!isArray(_commands)) _commands = [];
    _acks = [];
    _lastBeat = 0;
    _lastError = '';
    var cfg = readJSON(path || CONFIG_PATH, null);
    if (!cfg || !cfg.url || !cfg.key || !cfg.tenantId || !cfg.deviceId || !cfg.secret) {
        _lastError = 'config ausente/incompleta em ' + (path || CONFIG_PATH);
        return false;
    }
    var base = String(cfg.url).replace(/\/+$/, '');
    cfg.endpoint = cfg.endpoint || (base + '/functions/v1/device-heartbeat');
    cfg.heartbeatMs = typeof cfg.heartbeatMs === 'number' ? cfg.heartbeatMs : 60000;
    cfg.timeoutMs = typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 8000;
    _cfg = cfg;
    _desired = readJSON(DESIRED_PATH, null);
    return true;
};

cloud.configured = function () {
    return !!_cfg;
};

cloud.lastError = function () {
    return _lastError;
};

// Ultimo estado desejado recebido (cache em memoria; cai para o arquivo).
cloud.desired = function () {
    if (_desired === null) _desired = readJSON(DESIRED_PATH, null);
    return _desired;
};

// Comandos recebidos e ainda nao confirmados (persistidos no FS). O app deve
// chamar ack(id) depois de aplicar; ack remove da fila.
cloud.commands = function () {
    return _commands.slice(0);
};

// Confirma um comando (id) ou lista; vai no proximo heartbeat e sai da fila.
cloud.ack = function (id) {
    var ids = isArray(id) ? id : [id];
    for (var i = 0; i < ids.length && _acks.length < 20; i++) {
        var cid = ids[i];
        if (!cid) continue;
        var s = String(cid);
        _acks.push(s);
        for (var j = 0; j < _commands.length; j++) {
            if (_commands[j] && _commands[j].id === s) {
                _commands.splice(j, 1);
                j--;
            }
        }
    }
    persistCommands();
    return _acks.length;
};

// Enfileira evento idempotente (event_id gerado se ausente). Nunca lanca.
cloud.report = function (event) {
    if (!event || !event.type) return false;
    var outbox = readJSON(OUTBOX_PATH, []);
    if (!isArray(outbox)) outbox = [];
    if (outbox.length >= MAX_OUTBOX) outbox.shift();
    _seq++;
    outbox.push({
        id: event.id ? String(event.id) : ('ev-' + (_cfg ? _cfg.deviceId : 'dev') + '-' + millis() + '-' + _seq),
        type: String(event.type),
        severity: event.severity || 'info',
        payload: event.payload || {}
    });
    return writeJSON(OUTBOX_PATH, outbox);
};

cloud.pending = function () {
    var outbox = readJSON(OUTBOX_PATH, []);
    return isArray(outbox) ? outbox.length : 0;
};

// Heartbeat: POST autenticado com o outbox e acks pendentes.
// extra: { kind, label, board, firmware, apiLevel, uptimeS, rssi, apps }
// force: ignora o throttle de heartbeatMs.
// Devolve o desired (objeto) em sucesso; null em falha/sem config.
cloud.heartbeat = function (extra, force) {
    if (!_cfg) return null;
    if (!netReady()) {
        _lastError = 'Net.request indisponivel (API < 49)';
        return null;
    }
    var now = millis();
    if (!force && _lastBeat && (now - _lastBeat) < _cfg.heartbeatMs) {
        return cloud.desired();
    }
    extra = extra || {};
    var outbox = readJSON(OUTBOX_PATH, []);
    if (!isArray(outbox)) outbox = [];

    var body = {
        tenant_id: _cfg.tenantId,
        device_id: _cfg.deviceId,
        secret: _cfg.secret,
        kind: extra.kind || _cfg.kind || 'generic',
        label: extra.label || _cfg.label || '',
        board: extra.board || _cfg.board || '',
        firmware: extra.firmware || _cfg.firmware || osVersion(),
        api_level: typeof extra.apiLevel === 'number'
            ? extra.apiLevel
            : (typeof _cfg.apiLevel === 'number' ? _cfg.apiLevel : osApiLevel()),
        uptime_s: typeof extra.uptimeS === 'number' ? extra.uptimeS : 0,
        events: outbox,
        ack: _acks
    };
    if (typeof extra.rssi === 'number') body.rssi = extra.rssi;
    if (isArray(extra.apps)) body.apps = extra.apps;
    if (extra.caps && typeof extra.caps === 'object') body.caps = extra.caps;
    if (isArray(extra.resources)) body.resources = extra.resources.slice(0, 32);

    var response = null;
    try {
        response = Net.request({
            url: _cfg.endpoint,
            method: 'POST',
            body: JSON.stringify(body),
            contentType: 'application/json',
            headers: {
                apikey: _cfg.key,
                Authorization: 'Bearer ' + _cfg.key
            },
            timeoutMs: _cfg.timeoutMs
        });
    } catch (e) {
        response = null;
        _lastError = 'Net.request: ' + e;
    }

    if (!response) {
        if (!_lastError) _lastError = 'sem rede';
        return null;
    }
    if (response.status < 200 || response.status >= 300) {
        _lastError = 'HTTP ' + response.status;
        return null;
    }

    var parsed = null;
    try { parsed = JSON.parse(response.body); } catch (e2) { parsed = null; }
    if (!parsed || parsed.ok !== true) {
        _lastError = 'resposta invalida';
        return null;
    }

    _lastBeat = now;
    _lastError = '';
    if (parsed.desired) {
        _desired = parsed.desired;
        writeJSON(DESIRED_PATH, _desired);
    }
    if (isArray(parsed.commands) && parsed.commands.length) {
        var added = false;
        for (var ci = 0; ci < parsed.commands.length; ci++) {
            var cmd = parsed.commands[ci];
            if (!cmd || !cmd.id) continue;
            var known = false;
            for (var cj = 0; cj < _commands.length; cj++) {
                if (_commands[cj] && _commands[cj].id === cmd.id) { known = true; break; }
            }
            if (!known) {
                _commands.push(cmd);
                added = true;
            }
        }
        if (added) persistCommands();
    }
    // Servidor aceitou: outbox e acks entregues.
    writeJSON(OUTBOX_PATH, []);
    _acks = [];
    return _desired;
};

cloud.reset = function () {
    _cfg = null;
    _desired = null;
    _commands = [];
    _acks = [];
    _lastBeat = 0;
    _seq = 0;
    _lastError = '';
};

module.exports = cloud;
