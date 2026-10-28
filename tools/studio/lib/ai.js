'use strict';
// Copiloto do Celer Studio: prompt -> lote de ops. Nada aqui escreve arquivo:
// quem muta e applyOps (o MESMO barramento do CLI/GUI/HTTP), sempre validado
// em dry-run antes. Requer rede e uma chave do provedor por ambiente.
//
//   CELER_STUDIO_AI_PROVIDER  openrouter (padrao) | deepseek | openai
//   CELER_STUDIO_AI_MODEL     modelo (default por provedor)
//   CELER_STUDIO_AI_KEY       chave (fallback OPENROUTER_API_KEY/DEEPSEEK_API_KEY/OPENAI_API_KEY)
//   CELER_STUDIO_AI_URL       endpoint OpenAI-compativel (opcional)
//
// O contrato com o modelo e um JSON {"say": "...", "ops": [...]}. Se o lote
// nao validar, devolvemos o erro ao modelo e tentamos de novo (maxSteps).

const fs = require('fs');
const path = require('path');
const F = require('./format');
const { Project } = require('./project');
const { applyOps } = require('./ops');
const { componentCatalog } = require('./schema');
const { validateProject } = require('./validate');

const PROVIDERS = {
    openrouter: {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'qwen/qwen3.8-omni-flash',
        keys: ['CELER_STUDIO_AI_KEY', 'OPENROUTER_API_KEY'],
    },
    deepseek: {
        url: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-chat',
        keys: ['CELER_STUDIO_AI_KEY', 'DEEPSEEK_API_KEY'],
    },
    openai: {
        url: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        keys: ['CELER_STUDIO_AI_KEY', 'OPENAI_API_KEY'],
    },
};

// ops que apagam coisa: o copiloto nao faz isso sem pedido explicito
const DESTRUCTIVE = new Set(['asset.delete', 'scene.delete', 'entity.delete', 'tilemap.remove']);

function config(env) {
    env = env || process.env;
    const name = String(env.CELER_STUDIO_AI_PROVIDER || 'openrouter').toLowerCase();
    const p = PROVIDERS[name] || PROVIDERS.openrouter;
    let key = '';
    for (const k of p.keys) {
        if (env[k]) { key = env[k]; break; }
    }
    return {
        provider: PROVIDERS[name] ? name : 'openrouter',
        url: env.CELER_STUDIO_AI_URL || p.url,
        model: env.CELER_STUDIO_AI_MODEL || p.model,
        key: key,
    };
}

function opsHelp() {
    // require tardio: studio.js carrega este modulo na inicializacao
    return require('../studio.js').OPS_HELP;
}

// ------------------------------------------------------------------ HTTP ----

function contentOf(json) {
    const msg = json && json.choices && json.choices[0] && json.choices[0].message;
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
    }
    return '';
}

async function ask(opts) {
    opts = opts || {};
    const cfg = opts.config || config();
    if (!cfg.key) {
        throw new F.StudioError('ai.key',
            'sem chave de IA para o provedor ' + cfg.provider,
            { hint: 'defina CELER_STUDIO_AI_KEY (ou OPENROUTER_API_KEY/DEEPSEEK_API_KEY) no ambiente' });
    }
    const body = {
        model: opts.model || cfg.model,
        messages: opts.messages,
        temperature: opts.temperature === undefined ? 0.2 : opts.temperature,
        max_tokens: opts.maxTokens || 4000,
        stream: false,
    };
    if (opts.responseFormat !== false) body.response_format = { type: 'json_object' };
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key };
    if (cfg.provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://celer.tec.br';
        headers['X-Title'] = 'Celer Studio';
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 90000);
    let res;
    let text;
    try {
        res = await fetch(cfg.url, { method: 'POST', headers: headers,
                                     body: JSON.stringify(body), signal: ctl.signal });
        text = await res.text();
    } catch (e) {
        throw new F.StudioError('ai.net', 'falha de rede chamando ' + cfg.provider + ': ' + e.message,
                                { hint: 'confira a conexao e a URL do provedor' });
    } finally {
        clearTimeout(timer);
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!res.ok) {
        const detail = (json && json.error && (json.error.message || json.error)) || String(text).slice(0, 300);
        throw new F.StudioError('ai.http', cfg.provider + ' respondeu ' + res.status + ': ' + detail);
    }
    return { content: contentOf(json), usage: (json && json.usage) || null, raw: json };
}

// -------------------------------------------------------------- contexto ----

function sceneBrief(sc) {
    const seen = {};
    const ents = (sc.entities || []).map((e) => {
        const types = (e.components || []).map((c) => (c && c.type) || '?');
        for (const t of types) seen[t] = (seen[t] || 0) + 1;
        return { fid: e.fid, name: e.name, z: e.z || 0,
                 at: [(e.transform || {}).x || 0, (e.transform || {}).y || 0],
                 comps: types };
    });
    return {
        guid: sc.guid, name: sc.name,
        settings: {
            bg: (sc.settings || {}).bg, fps: (sc.settings || {}).fps,
            header: (sc.settings || {}).header, sub: (sc.settings || {}).sub,
            persist: (sc.settings || {}).persist,
            scripts: ((sc.settings || {}).scripts || []).length,
            dataKeys: Object.keys((sc.settings || {}).data || {}),
        },
        entities: ents,
        tilemaps: (sc.tilemaps || []).length,
        componentCounts: seen,
    };
}

function buildContext(project, opts) {
    opts = opts || {};
    const level = opts.level || 'summary';
    const p = project.data;
    const runtime = p.runtime || 'studio';
    const cat = componentCatalog();
    const components = {};
    for (const k of Object.keys(cat)) {
        const c = cat[k];
        const mode = c.runtime || 'any';
        if (mode !== 'any' && mode !== (runtime === 'app' ? 'app' : 'game')) continue;
        const fields = {};
        for (const f of Object.keys(c.fields || {})) {
            const d = c.fields[f];
            fields[f] = { type: d.type };
            if (d.default !== undefined) fields[f].default = d.default;
            if (d.values) fields[f].values = d.values;
            if (d.min !== undefined) fields[f].min = d.min;
            if (d.max !== undefined) fields[f].max = d.max;
            if (d.required) fields[f].required = true;
        }
        components[k] = { label: c.label || k, fields: fields };
    }
    const ctx = {
        runtime: runtime,
        project: {
            name: p.name, packageName: p.packageName, version: p.version, api: p.api,
            type: p.type, category: p.category, permissions: p.permissions || [],
            requires: p.requires || [], deps: p.deps || {},
            canvas: p.canvas, startScene: p.startScene,
        },
        components: components,
        scenes: (project.data && project.sceneList ? project.sceneList() : []).map((sc) => {
            if (level === 'full') return sc;
            return sceneBrief(sc);
        }),
        prefabs: project.prefabList().map((pf) => ({ guid: pf.guid, name: pf.name,
                                                     entities: (pf.entities || []).length })),
        assets: project.assets.map((a) => ({
            guid: a.guid, name: a.name, kind: a.kind, path: a.relPath,
            props: (a.meta.settings || {}).props || undefined,
            regions: (a.kind === 'sprite' || a.kind === 'sprite-sheet' || a.kind === 'tileset')
                ? project.regions(a).map((r) => r.name) : undefined,
        })),
        ops: opsHelp(),
        limits: { deps: 8, extras: 16, jsKB: (p.requires || []).indexOf('psram') >= 0 ? 1024 : 48 },
    };
    return ctx;
}

function buildSystemPrompt(ctx, opts) {
    const app = ctx.runtime === 'app';
    const rules = [
        'Voce edita projetos do Celer Studio (CelerOS/ESP32) por um barramento de ops JSON.',
        'Responda SOMENTE com um objeto JSON: {"say": "<explicacao curta em portugues>", "ops": [ ... ]}',
        'Cada op e {"op":"<nome>", ...argumentos}. Nada de codigo fora do JSON.',
        'Use GUIDs existentes (cena, asset, script) do CONTEXTO; refs por nome so onde o texto diz que aceita.',
        'Componentes de programa (runtime app) comecam com "ui.", "ai." ou sao "mic.record".',
        app
            ? 'RUNTIME APP: cena = TELA. transform.x/y e o canto superior esquerdo do widget; z e a ordem de desenho ' +
              '(card antes do conteudo). O estado da tela e settings.data; widgets leem/escrevem por "key"/"bind". ' +
              'O cabecalho (UI.header) ocupa y=0..40: comece o conteudo em y>=44. A tela tem no maximo ~40 widgets.'
            : 'RUNTIME DE JOGO: entidades com transform (x/y = centro pelo pivot), tilemaps e camera.',
        app ? 'Eventos de widget viram event(nome, valor, ctx) no script de TELA (settings.scripts).'
            : 'Controladores sao entidades com componente script.',
        'Scripts sao ES5 (Duktape): sem let/const/setas/template literals/classes.',
        'Nunca invente API do CelerOS dentro de scripts: System.*, UI.*, FS.*, Net.*, AI.*, Storage, Mic (ES5).',
        'Se precisar de um script novo, use {"op":"script.set","name":"...","content":"..."} com o codigo completo.',
        'Prefira lotes pequenos e coerentes; nao repita ops que ja estao no CONTEXTO.',
    ];
    if (opts && opts.contextHint) rules.push(opts.contextHint);
    return [
        'Voce e o copiloto do Celer Studio.',
        rules.join('\n'),
        '',
        'OPS DISPONIVEIS:',
        ctx.ops.map((o) => '- ' + o.op + ': ' + (o.args || '')).join('\n'),
        '',
        'CONTEXTO DO PROJETO (JSON):',
        JSON.stringify(ctx),
    ].join('\n');
}

function mimeOf(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.mp3') return 'audio/mpeg';
    return 'application/octet-stream';
}

function userContent(prompt, opts) {
    const images = (opts.images || []).filter(Boolean);
    const audio = (opts.audio || []).filter(Boolean);
    if (!images.length && !audio.length) return String(prompt || '');
    const parts = [{ type: 'text', text: String(prompt || '') }];
    for (const f of images) {
        // caminho no disco OU {data, mime} (a GUI manda base64 do anexo)
        if (typeof f === 'string') {
            const abs = path.resolve(f);
            if (!fs.existsSync(abs)) F.fail('ai.file', 'imagem nao existe: ' + abs);
            const b64 = fs.readFileSync(abs).toString('base64');
            parts.push({ type: 'image_url', image_url: { url: 'data:' + mimeOf(abs) + ';base64,' + b64 } });
        } else if (f && f.data) {
            parts.push({ type: 'image_url', image_url:
                { url: 'data:' + (f.mime || 'image/png') + ';base64,' + String(f.data) } });
        }
    }
    for (const f of audio) {
        if (typeof f === 'string') {
            const abs = path.resolve(f);
            if (!fs.existsSync(abs)) F.fail('ai.file', 'audio nao existe: ' + abs);
            const b64 = fs.readFileSync(abs).toString('base64');
            const format = /\.wav$/i.test(abs) ? 'wav' : 'mp3';
            parts.push({ type: 'input_audio', input_audio: { data: b64, format: format } });
        } else if (f && f.data) {
            parts.push({ type: 'input_audio', input_audio:
                { data: String(f.data), format: f.format || 'wav' } });
        }
    }
    return parts;
}

// ---------------------------------------------------------------- parser ----

function parsePlan(text) {
    let s = String(text === undefined || text === null ? '' : text).trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(s);
    if (fence) s = fence[1].trim();
    let obj = null;
    try { obj = JSON.parse(s); } catch (e) {
        const i = s.indexOf('{');
        const j = s.lastIndexOf('}');
        if (i >= 0 && j > i) {
            try { obj = JSON.parse(s.slice(i, j + 1)); } catch (e2) { obj = null; }
        }
    }
    if (obj && Array.isArray(obj)) obj = { say: '', ops: obj };
    if (!obj || typeof obj !== 'object') {
        throw new F.StudioError('ai.json', 'a resposta nao e um JSON de plano: ' + s.slice(0, 200));
    }
    if (!Array.isArray(obj.ops)) {
        throw new F.StudioError('ai.json', 'resposta sem "ops": ' + s.slice(0, 200));
    }
    return { say: typeof obj.say === 'string' ? obj.say : '', ops: obj.ops };
}

function guard(ops, opts) {
    opts = opts || {};
    const max = opts.maxOps || 40;
    if (!Array.isArray(ops)) F.fail('ai.guard', 'ops deve ser array');
    if (ops.length === 0) F.fail('ai.guard', 'o modelo nao propos nenhuma op');
    if (ops.length > max) F.fail('ai.guard', 'lote com ' + ops.length + ' ops (maximo ' + max + ')');
    for (const op of ops) {
        if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
            F.fail('ai.guard', 'op invalida no lote: ' + JSON.stringify(op).slice(0, 120));
        }
        if (!opts.allowDelete && DESTRUCTIVE.has(op.op)) {
            F.fail('ai.guard', 'op destrutiva bloqueada: ' + op.op,
                   { hint: 'rode com --allow-delete (CLI) se for mesmo isso' });
        }
        if (!opts.allowImport && op.op === 'asset.import') {
            F.fail('ai.guard', 'asset.import bloqueado no copiloto',
                   { hint: 'importe o arquivo com `studio import` e peca a op depois' });
        }
    }
    return ops;
}

// ----------------------------------------------------------------- plano ----

async function plan(dir, prompt, opts) {
    opts = opts || {};
    const askFn = opts.ask || ask;
    const project = Project.open(dir);
    const cfg = opts.config || config();
    const ctx = buildContext(project, { level: opts.context || 'summary' });
    const messages = [
        { role: 'system', content: buildSystemPrompt(ctx, opts) },
        { role: 'user', content: userContent(prompt, opts) },
    ];
    const maxSteps = opts.maxSteps === undefined ? 2 : Math.max(1, Math.min(6, opts.maxSteps));
    let say = '';
    let lastError = null;
    for (let step = 0; step < maxSteps; step++) {
        if (lastError) {
            messages.push({ role: 'user', content:
                'O lote anterior foi recusado pela validacao. Corrija e responda o JSON de novo.\n' +
                JSON.stringify(lastError, null, 1) });
        }
        const r = await askFn({ messages: messages, config: cfg, model: opts.model,
                                maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs });
        const parsed = parsePlan(r.content);
        say = parsed.say || say;
        messages.push({ role: 'assistant', content: r.content });
        guard(parsed.ops, opts);
        try {
            const res = applyOps(dir, parsed.ops, { dryRun: !!opts.dryRun, ifRev: opts.ifRev });
            return { ok: true, say: say, ops: parsed.ops, result: res,
                     steps: step + 1, usage: r.usage || null, dryRun: !!opts.dryRun };
        } catch (e) {
            lastError = { code: e.code || 'error', message: e.message,
                          diagnostics: (e.diagnostics || []).slice(0, 10) };
        }
    }
    throw new F.StudioError('ai.failed', 'nao consegui um lote valido: ' + (lastError ? lastError.message : 'sem resposta'),
                            { diagnostics: lastError ? lastError.diagnostics : null, say: say });
}

// corrige o que a validacao aponta (o "consertar build" da GUI)
async function fix(dir, opts) {
    const project = Project.open(dir);
    const v = validateProject(project, {});
    const errs = (v.errors || []).slice(0, 15).map((d) => ({ code: d.code, path: d.path, message: d.message }));
    let warn = [];
    try {
        const rep = F.readJson(path.join(project.studioDir, 'report.json'));
        warn = (rep.warnings || []).slice(0, 10);
    } catch (e) { warn = []; }
    const prompt = [
        'Corrija os problemas do projeto abaixo com o minimo de ops.',
        'ERROS DE VALIDACAO:',
        JSON.stringify(errs),
        warn.length ? 'AVISOS DO ULTIMO BUILD:' : '',
        warn.length ? JSON.stringify(warn) : '',
    ].filter(Boolean).join('\n');
    return plan(dir, prompt, Object.assign({}, opts, { contextHint:
        'Voce esta MODO CORRECAO: mude o minimo necessario e explique em "say".' }));
}

// pergunta livre (sem ops): explica um script/projeto
async function explain(dir, what, opts) {
    opts = opts || {};
    const askFn = opts.ask || ask;
    const project = Project.open(dir);
    const ctx = buildContext(project, { level: 'summary' });
    const messages = [
        { role: 'system', content: buildSystemPrompt(ctx, {}) },
        { role: 'user', content: String(what || 'Explique a estrutura deste projeto.') },
    ];
    const r = await askFn({ messages: messages, config: opts.config || config(),
                            model: opts.model, maxTokens: opts.maxTokens || 1200,
                            responseFormat: false, timeoutMs: opts.timeoutMs });
    return { ok: true, say: r.content, ops: [], usage: r.usage || null };
}

module.exports = {
    PROVIDERS, config, ask, buildContext, buildSystemPrompt, parsePlan, guard,
    plan, fix, explain, userContent, DESTRUCTIVE,
};
