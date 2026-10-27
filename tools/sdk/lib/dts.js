'use strict';
// Gerador do celer.d.ts (autocomplete no editor) a partir do manifest do
// firmware (tools/app_lint) e dos headings do guia pt-BR (nomes de args e
// resumo). Artefato GERADO — regenerar com `celer.js types` apos mudar a API.

const fs = require('fs');
const path = require('path');
const { buildManifest } = require('../../app_lint/lint.js');

const GUIDE_PT = path.resolve(__dirname, '../../../Documentation/JS_API_Guide.pt-BR.md');

// Overrides de tipo onde a assinatura generica mentiria. O resto dos
// retornos com valor vira `any` (honesto e nao trava o autocomplete).
const RETURNS = {
    'System.theme': 'CelerTheme',
    'System.getTouch': 'TouchPoint',
    'System.getTouches': 'TouchState[]',
    'System.millis': 'number',
    'System.micros': 'number',
    'System.textWidth': 'number',
    'FS.readTextFile': 'string | null',
    'FS.listDir': 'string[]',
    'System.mixColor': 'number',
    // UI (API 22)
    'UI.begin': 'boolean',
    'UI.touch': 'UITouch',
    'UI.header': 'boolean',
    'UI.button': 'boolean',
    'UI.toggle': 'boolean',
    'UI.confirm': 'boolean',
    'UI.text': 'number',
    'UI.measure': 'number',
    'UI.lineHeight': 'number',
    'UI.measureWrap': 'number',
    'UI.slider': 'number',
    'UI.list': 'number',
    'UI.tabs': 'number',
    'UI.scrollBegin': 'number',
    'UI.badge': 'number',
    'UI.custom': 'boolean',   // API 52: desenhou neste frame?
    // CelerNet (API 26): malha BLE por flood de advertising
    'CelerNet.start': 'boolean',
    'CelerNet.stop': 'boolean',
    'CelerNet.broadcast': 'boolean',
    'CelerNet.poll': 'MeshMessage | null',
    'CelerNet.nodes': 'MeshNode[]',
    'CelerNet.status': 'MeshStatus',
    // Recursos da matilha (API 36)
    'Pack.resources': 'PackResource[]',
    'Pack.open': 'number',
    'Pack.status': 'PackSession | null',
    'Pack.read': 'string | null',
    'Pack.write': 'boolean',
    'Pack.expose': 'boolean',
    'Pack.unexpose': 'boolean',
    'Pack.publish': 'number',
    'Pack.sessions': 'number',
    'Pack.pollWrite': '{ res: string; from: string; fromName: string; data: string } | null',
    'Pack.listen': 'number',
    'Pack.speak': 'number',
    'Pack.record': 'number',
    'Pack.recording': 'boolean',
    'Pack.level': 'number',
    'Pack.recordStop': 'string | boolean | null',
    'Pack.snap': 'number',
    'Pack.view': 'number',
    'Pack.drawFrame': 'boolean',
    // API 47: sensores/atuadores da matilha
    'Pack.onEvent': '{ v: number; dir: "gt" | "lt"; at: number } | null',
    'Pack.ruleAdd': 'number',
    'Pack.ruleDel': 'boolean',
    'Pack.ruleList': 'Array<{ id: number; sensor: string; op: "gt" | "lt"; valor: number; h: number; alvo?: string; no?: string; on?: boolean; notificar?: string }>',
    'System.drawJPG': 'boolean',
    // USB Host e input do OS (API 48)
    'USB.devices': 'Array<{ addr: number; vid: number; pid: number; cls: number; subcls: number; proto: number; speed: number; claimed: number[]; ifs: Array<{ n: number; alt: number; cls: number; subcls: number; proto: number; eps: Array<{ addr: number; type: number; mps: number; ivl: number }> }> }>',
    'USB.poll': '{ type: "add" | "remove"; addr: number; vid: number; pid: number } | null',
    'USB.claim': 'boolean',
    'USB.release': 'boolean',
    'USB.controlIn': '{ ok: boolean; status: string; len: number; data: number[] }',
    'USB.controlOut': '{ ok: boolean; status: string; sent: number }',
    'USB.out': '{ ok: boolean; status: string; sent: number }',
    'USB.in': '{ ok: boolean; status: string; len: number; data: number[] }',
    'USB.sendFile': '{ ok: boolean; status: string; sent: number }',
    'USB.listen': 'boolean',
    'USB.read': 'number[] | null',
    'USB.unlisten': 'boolean',
    'USB.flush': 'boolean',
    'Input.key': 'boolean',
    'Input.poll': '{ key: number; mods: number; down: boolean } | null',
    'Input.pointer': '{ x: number; y: number; buttons: number }',
};

// Tipos de argumento por funcao (objetos de opcoes do toolkit UI)
const PARAM_TYPES = {
    'UI.text.opts': 'UITextOpts',
    'UI.header.opts': '{ sub?: string; back?: boolean }',
    'UI.button.opts': '{ style?: "primary" | "ghost" | "danger"; disabled?: boolean; id?: number; color?: number; textColor?: number; role?: UITextRole }',
    'UI.toggle.opts': '{ id?: number }',
    'UI.slider.opts': '{ min?: number; max?: number; step?: number; id?: number }',
    'UI.list.items': 'Array<string | UIListItem>',
    'UI.list.opts': '{ rowH?: number; selected?: number }',
    'UI.tabs.labels': 'string[]',
    'UI.card.opts': '{ color?: number; radius?: number; stroke?: boolean }',
    'UI.badge.opts': '{ color?: number; textColor?: number }',
    'UI.confirm.opts': '{ yes?: string; no?: string; danger?: boolean }',
    'UI.alert.ok': 'string',
    'System.rigidState.buf': 'number[]',   // API 34: array do quadro anterior (preenchido no lugar)
    'UI.measure.role': 'UITextRole',
    'UI.lineHeight.role': 'UITextRole',
    'UI.measureWrap.role': 'UITextRole',
    'CelerNet.start.opcoes': '{ name?: string; /** ignorado desde a API 37 */ net?: string; relay?: boolean }',
    'CelerNet.broadcast.mensagem': 'string | object',
    'CelerNet.broadcast.ttl': 'number',
    'Pack.resources.tipo': '"mic" | "speaker" | "camera" | "data"',
    'Pack.open.no': 'string',
    'Pack.open.opts': 'object',
    'Pack.write.dado': 'string | object',
    'Pack.publish.dado': 'string | object',
    'Pack.expose.opts': '{ shared?: boolean }',
    'Pack.listen.no': 'string',
    'Pack.speak.no': 'string',
    'Pack.record.no': 'string',
    'Pack.record.opts': '{ ms?: number }',
    'Pack.recordStop.opts': '{ raw?: boolean; path?: string }',
    'Pack.snap.no': 'string',
    'Pack.snap.opts': '{ path?: string; quality?: number }',
    'Pack.view.no': 'string',
    'Pack.view.opts': '{ fps?: number; quality?: number }',
    // API 47: sensores/atuadores da matilha
    'Pack.onEvent.h': 'number',
    'Pack.ruleAdd.regra': '{ sensor: string; op: "gt" | "lt"; valor: number; h?: number; alvo?: string; no?: string; on?: boolean | number; notificar?: string }',
    'Pack.ruleDel.id': 'number',
    // USB (API 48): payloads sao arrays de bytes, nao um numero
    'USB.controlOut.data': 'number[]',
    'USB.out.data': 'number[]',
    // API 52 (S3): area desenhada pelo app — id string, assinatura
    // numero/string e o callback recebe o retangulo
    'UI.custom.id': 'string',
    'UI.custom.sig': 'number | string',
    'UI.custom.draw': '(x: number, y: number, w: number, h: number) => void',
};

// Args que o guia documenta como obrigatorios mesmo quando o binding tolera
// a ausencia (UI.custom sem draw devolve false em vez de lancar)
const REQUIRED_PARAMS = new Set(['UI.custom.draw']);

// Nomes de argumento que indicam string (o restante e number: a API e
// majoritariamente numerica — coordenadas, cores, tamanhos, ids). Compostos
// camelCase contam pelo SUFIXO ("zipPath" e um path, "destinoN" nao).
function argType(name) {
    if (/^(s|str|txt|text|texto|name|nome|label|path|arq|arquivo|ssid|pass|senha|key|chave|url|host|body|json|msg|linha|code|cod|prompt|title|descricao|id|destino|alvo)$/i.test(name)) return 'string';
    if (/([Pp]ath|[Aa]rquivo|[Nn]ome|[Nn]ame|[Ss]enha|[Mm]sg|[Uu]rl|[Tt]itulo)$/.test(name) &&
        /^[A-Za-z_$][\w$]*$/.test(name)) return 'string';
    if (/^(on|ok|down|touched|enabled)$/i.test(name)) return 'boolean';
    // objeto de opcoes e callback: `number` mentia e o editor reclamava do
    // literal {..} / da funcao passados como manda o guia
    if (/^(opts|opcoes|options|cfg|config|song|musica)$/i.test(name)) return 'Record<string, any>';
    if (/^(cb|callback|fn|handler|on[A-Z][\w$]*)$/.test(name)) return '(...args: any[]) => any';
    return 'number';
}

// Headings `#### System.foo(a, b, cor)` (API N) -> args, nivel e resumo
// (primeira frase da linha "- **Descricao:** ..." do guia pt-BR).
function parseGuide(filePath) {
    const out = new Map();  // "System.foo" -> { args: [nomes], api, doc }
    if (!fs.existsSync(filePath)) return out;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^#{3,4}\s+`?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(([^)]*)\)`?/.exec(lines[i]);
        if (!m) continue;
        const apiM = /\(API\s+(\d+)\)/.exec(lines[i]);
        // resumo: linha "- **Descricao:**" (+ 1 linha de continuacao indentada)
        let doc = '';
        for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
            const t = lines[j];
            const dm = /^-\s*\*\*Descri(?:c|ç)(?:a|ã)o:\*\*\s*(.+)$/.exec(t);
            if (dm) {
                doc = dm[1].replace(/[`*]/g, '').trim();
                const nxt = lines[j + 1] || '';
                if (/^ {2,}\S/.test(nxt) && !/^ {2,}-/.test(nxt)) doc += ' ' + nxt.trim();
                break;
            }
            if (/^#{3,4}\s/.test(t)) break;  // heading seguinte sem descricao
        }
        doc = doc.replace(/\s+/g, ' ').slice(0, 140);
        const args = m[2] ? m[2].split(',').map((a) => a.trim()).filter(Boolean) : [];
        if (!out.has(m[1])) out.set(m[1], { args, api: apiM ? +apiM[1] : null, doc });
    }
    return out;
}

// Assinaturas exatas das funcoes globais (o guia nao usa prefixo de objeto,
// entao o parser de headings nao as cobre; timers API 12).
const GLOBAL_SIGS = {
    setTimeout: { params: ['callback: () => void', 'ms: number'], ret: 'number' },
    setInterval: { params: ['callback: () => void', 'ms: number'], ret: 'number' },
    clearTimeout: { params: ['id: number'], ret: 'void' },
    clearInterval: { params: ['id: number'], ret: 'void' },
    // modulos (API 23): devolve o module.exports do modulo (objeto qualquer)
    require: { params: ['nome: string'], ret: 'any' },
};

// heading `fn({a, b, c})` chega partido em ['{a', 'b', 'c}']: um objeto de
// opcoes e UM argumento so (opts)
function collapseObjArgs(args) {
    const out = [];
    let depth = 0;
    for (const a of args) {
        const open = (a.match(/\{/g) || []).length, close = (a.match(/\}/g) || []).length;
        if (depth === 0) out.push(open ? 'opts' : a);
        depth += open - close;
        if (depth < 0) depth = 0;
    }
    return out;
}

function fnSignature(objPath, fn, guide) {
    if (objPath === 'global' && GLOBAL_SIGS[fn.name]) return { params: GLOBAL_SIGS[fn.name].params, ret: GLOBAL_SIGS[fn.name].ret, doc: '', api: fn.apiLevel || null };
    const g = guide.get(objPath + '.' + fn.name);
    const args = g ? collapseObjArgs(g.args) : [];
    const names = [];
    const max = Math.max(fn.nargs || 0, args.length, fn.min || 0);
    for (let i = 0; i < max; i++) {
        let nm = args[i] ? args[i].replace(/[\[\]=]/g, '').trim() : ('arg' + i);
        // nome que nao e identificador (heading com desestruturacao ou
        // reticencias) virava d.ts INVALIDO e o editor perdia o arquivo todo
        if (!/^[A-Za-z_$][\w$]*$/.test(nm)) nm = 'arg' + i;
        names.push({ name: nm, optional: i >= (fn.min || 0) && !REQUIRED_PARAMS.has(objPath + '.' + fn.name + '.' + nm) });
    }
    const params = names.map((n) => n.name + (n.optional ? '?' : '') + ': ' +
        (PARAM_TYPES[objPath + '.' + fn.name + '.' + n.name] || argType(n.name)));
    let ret = 'void';
    if (fn.returns) ret = RETURNS[objPath + '.' + fn.name] || 'any';
    return { params, ret, doc: g ? g.doc : '', api: g ? g.api : (fn.apiLevel || null) };
}

function renderObject(objPath, obj, guide, indent) {
    const pad = ' '.repeat(indent);
    const lines = [];
    for (const fn of obj.fns) {
        const sig = fnSignature(objPath, fn, guide);
        if (sig.doc) lines.push(pad + '/** ' + sig.doc + (sig.api ? ' (API ' + sig.api + ')' : '') + ' */');
        if (fn.perm) lines.push(pad + '/** @permission "' + fn.perm + '" */');
        lines.push(pad + fn.name + '(' + sig.params.join(', ') + '): ' + sig.ret + ';');
    }
    for (const c of obj.consts || []) {
        lines.push(pad + '/** constante */');
        lines.push(pad + c.name + ': ' + (c.type === 'boolean' ? 'boolean' : 'number') + ';');
    }
    return lines;
}

function generate() {
    const manifest = buildManifest();
    const guide = parseGuide(GUIDE_PT);

    // arvore de objetos: "System" com filho "System.gpio"
    const roots = {};
    for (const [objPath, obj] of Object.entries(manifest.objects)) {
        const parts = objPath.split('.');
        if (parts.length === 1) roots[objPath] = { path: objPath, obj, children: [] };
    }
    for (const [objPath, obj] of Object.entries(manifest.objects)) {
        const parts = objPath.split('.');
        if (parts.length > 1 && roots[parts[0]]) roots[parts[0]].children.push({ path: objPath, obj });
    }

    const out = [];
    out.push('// celer.d.ts — tipos da API JS do CelerOS para o editor (IntelliSense).');
    out.push('// ARTEFATO GERADO por `node tools/sdk/celer.js types` (manifest do firmware');
    out.push('// + guia pt-BR). Nao editar a mao; o `celer.js check` acusa drift.');
    out.push('// API level ' + manifest.apiLevel + ' — ' + manifest.counts.functions + ' funcoes.');
    out.push('');
    out.push('interface CelerTheme {');
    out.push('    bg: number; card: number; raised: number; stroke: number;');
    out.push('    accent: number; accentD: number; onAccent: number;');
    out.push('    text: number; textDim: number; ok: number; warn: number; err: number;');
    out.push('}');
    out.push('');
    out.push('interface TouchPoint { x: number; y: number; touched: boolean; }');
    out.push('');
    // API 43: multi-dedo (System.getTouches) — primario primeiro
    out.push('interface TouchState { id: number; x: number; y: number; size: number; }');
    out.push('');
    out.push('type UITextRole = "caption" | "body" | "title" | "display";');
    out.push('interface UITextOpts {');
    out.push('    role?: UITextRole; color?: number; align?: "left" | "center" | "right";');
    out.push('    w?: number; lines?: number; bg?: number; id?: number;');
    out.push('}');
    out.push('interface UITouch { down: boolean; x: number; y: number; tap: boolean; released: boolean; moved: boolean; sx: number; sy: number; }');
    out.push('interface UIListItem { label: string; sub?: string; right?: string; rightColor?: number; bars?: number; enabled?: boolean; }');
    out.push('');
    out.push('// CelerNet (API 26): malha BLE — poll/nodes/status');
    out.push('interface MeshMessage { from: string; fromName: string; msg: string; hops: number; rssi: number; }');
    out.push('interface PackResource { node: string; nodeName: string; name: string; type: "mic" | "speaker" | "camera" | "data"; busy: boolean; shared: boolean; ready: boolean; }');
    out.push('interface PackSession { state: "opening" | "open" | "refused" | "revoked" | "lost" | "closed" | "done"; reason: string; node: string; name: string; via: "espnow" | "mesh" | ""; bytes?: number; total?: number; frames?: number; }');
    out.push('interface MeshNode { id: string; name: string; rssi: number; hops: number; lastSeen: number; }');
    out.push('interface MeshStatus { active: boolean; relay: boolean; node: string; name: string; net: string; secure: boolean; provisioned: boolean; txQueued: number; txDropped: number; txStarted: number; txFail: number; txNoToken: number; rxDropped: number; relayed: number; relayDropped: number; heard: number; rxAuthFail: number; rxReplay: number; }');
    out.push('');
    // funcoes globais (ex.: timers API 12): setTimeout e irmãos no escopo global
    if (manifest.objects.global) {
        for (const fn of manifest.objects.global.fns) {
            const sig = fnSignature('global', fn, guide);
            if (sig.doc) out.push('/** ' + sig.doc + (sig.api ? ' (API ' + sig.api + ')' : '') + ' */');
            out.push('declare function ' + fn.name + '(' + sig.params.join(', ') + '): ' + sig.ret + ';');
        }
        out.push('');
    }
    for (const root of Object.values(roots)) {
        if (root.path === 'global') continue;
        const isLink = root.path === 'CelerLink';
        out.push('declare const ' + root.path + (isLink ? ': ' + root.path + 'Api | undefined' : ': {') );
        if (!isLink) out.push(...renderObject(root.path, root.obj, guide, 4));
        for (const child of root.children) {
            out.push('    ' + child.path.split('.').pop() + ': {');
            out.push(...renderObject(child.path, child.obj, guide, 8));
            out.push('    };');
        }
        if (!isLink) out.push('};');
        if (isLink) {
            out.push('');
            out.push('interface ' + root.path + 'Api {');
            out.push(...renderObject(root.path, root.obj, guide, 4));
            out.push('}');
        }
        out.push('');
    }
    for (const c of manifest.globalConsts) {
        out.push('declare const ' + c.name + ': number;');
    }
    out.push('');
    if (manifest.warnings.length) {
        out.push('// avisos do manifest:');
        for (const w of manifest.warnings) out.push('// - ' + w);
        out.push('');
    }
    return out.join('\n');
}

module.exports = { generate, parseGuide };
