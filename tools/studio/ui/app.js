'use strict';
// GUI do Celer Studio: hierarquia, inspetor dirigido por schema, viewport 2D,
// assets, console e play. Fala SO com /api/* (o mesmo barramento do CLI).

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const S = {
  snap: null,
  sceneGuid: null,
  sel: { kind: 'scene', id: null, comp: null },
  view: { zoom: 2, panX: 0, panY: 0, fitted: false },
  images: new Map(),
  lastRunUrl: null,
  tab: 'scene',
  spaceDown: false,
  drag: null,
  pan: null,
  dpr: window.devicePixelRatio || 1,
  tile: { active: false, tmId: null, value: 0, solid: false,
          data: null, solids: null, dirty: false, painting: false,
          strokeValue: 0, hover: null },
  gizmo: 'move',
  mouse: null,
  assetFilter: '',
  hierFilter: '',
  dragAsset: null,
  animPreview: null,
};

// ------------------------------------------------------------- helpers ----

async function api(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { throw new Error('resposta invalida do servidor'); }
  if (!r.ok || j.ok === false) {
    const err = j && j.error ? j.error : { code: 'http', message: 'HTTP ' + r.status };
    const e = new Error(err.message || 'erro');
    e.code = err.code; e.hint = err.hint; e.diagnostics = err.diagnostics;
    throw e;
  }
  return j;
}

function log(text, cls) {
  const box = $('#console');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const t = new Date();
  const stamp = String(t.getHours()).padStart(2, '0') + ':' +
                String(t.getMinutes()).padStart(2, '0') + ':' +
                String(t.getSeconds()).padStart(2, '0');
  line.textContent = stamp + '  ' + text;
  box.appendChild(line);
  while (box.childNodes.length > 900) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  return line;
}

function logError(e) {
  log('erro[' + (e.code || 'erro') + ']: ' + e.message, 'err');
  if (e.hint) log('  dica: ' + e.hint, 'dim');
  for (const d of e.diagnostics || []) {
    log('  ' + (d.code || '') + ' ' + (d.path || '') + ': ' + d.message, 'err');
  }
}

function el(tag, attrs, kids) {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'text') n.textContent = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
  }
  for (const c of kids || []) {
    if (c === null || c === undefined) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function assetByGuid(guid) {
  return (S.snap.describe.assets || []).find((a) => a.guid === guid) || null;
}
function assetByName(name) {
  return (S.snap.describe.assets || []).find((a) => a.name === name) || null;
}
function asset(ref) {
  if (!ref) return null;
  const raw = String(ref).split('#')[0];
  return assetByGuid(raw) || assetByName(raw);
}
// runtime do projeto: 'app' = programa (telas com widgets Kui), resto = jogo
function isAppMode() {
  return !!S.snap && S.snap.describe && S.snap.describe.runtime === 'app';
}
function prefabByGuid(guid) { return (S.snap.prefabs || {})[guid] || null; }
function currentScene() {
  return S.snap && S.sceneGuid ? S.snap.scenes[S.sceneGuid] || null : null;
}
function sceneEntity(scene, fid) {
  return (scene.entities || []).find((e) => e.fid === fid) || null;
}
const KIND_LABEL = {
    sprite: 'Sprite', 'sprite-sheet': 'Atlas', tileset: 'Tileset', audio: 'Audio',
    script: 'Script', scene: 'Cena', prefab: 'Prefab',
};

// --------------------------------------------------------------- boot -----

async function loadSnapshot(opts) {
  opts = opts || {};
  try {
    const s = await api('/api/snapshot');
    setSnapshot(s, opts);
  } catch (e) {
    logError(e);
    $('#projName').textContent = 'sem projeto';
  }
}

function setSnapshot(s, opts) {
  opts = opts || {};
  const oldAssets = S.snap && S.snap.describe ? S.snap.describe.assets : null;
  S.snap = s;
  const d = s.describe;
  if (oldAssets) {
    for (const a of d.assets) {
      const b = oldAssets.find((x) => x.guid === a.guid);
      if (!b || b.path !== a.path || b.size !== a.size) S.images.delete(a.guid);
    }
  }
  if (!S.sceneGuid || !s.scenes[S.sceneGuid]) {
    S.sceneGuid = (d.project.startScene && s.scenes[d.project.startScene])
      ? d.project.startScene : (Object.keys(s.scenes)[0] || null);
  }
  let selLost = false;
  if (S.sel.kind !== 'scene' && !selectionExists()) {
    S.sel = { kind: 'scene', id: null, comp: null };
    selLost = true;
  }
  renderHeader();
  renderSceneSel();
  const gt = $('#tabs [data-tab="game"]');
  if (gt) gt.textContent = d.runtime === 'app' ? 'Telas' : 'Jogo';
  renderHierarchy();
  renderAssets();
  renderBuild();
  renderPlay();
  const runtime = d.project.runtime || 'studio';
  const banner = $('#legacyBanner');
  if (banner) {
    if (runtime === 'legacy') {
      banner.hidden = false;
      banner.textContent = 'MODO LEGADO — Play roda ' +
        ((d.project.legacy && d.project.legacy.entry) || 'main.js') +
        '; a cena e um cartao. Edite os scripts/assets no painel.';
    } else banner.hidden = true;
  }
  // keepInspector evita reconstruir o painel enquanto o usuario digita; mas
  // se a selecao sumiu do disco ela nao pode continuar exibida como se
  // existisse (toda edicao nela viraria erro de ref)
  if (!opts.keepInspector || selLost) renderInspector();
  draw();
}

function selectionExists() {
  if (S.sel.kind === 'entity') {
    const sc = currentScene();
    if (!sc) return false;
    if (!sceneEntity(sc, S.sel.id)) return false;
    if (S.sel.comp) {
      const e = sceneEntity(sc, S.sel.id);
      return (e.components || []).some((c) => c.id === S.sel.comp);
    }
    return true;
  }
  if (S.sel.kind === 'tilemap') {
    const sc = currentScene();
    return !!sc && (sc.tilemaps || []).some((t) => t.id === S.sel.id);
  }
  if (S.sel.kind === 'asset') return !!assetByGuid(S.sel.id);
  if (S.sel.kind === 'project') return true;
  return true;
}

// ------------------------------------------------------------- header -----

function renderHeader() {
  const d = S.snap.describe;
  $('#projName').textContent = d.project.name + '  ' + d.project.version;
  document.title = d.project.name + ' — Celer Studio';
  const b = S.snap.build;
  let st = 'rev ' + S.snap.rev + '  ·  ' + d.scenes.length + ' cenas  ·  ' + d.assets.length + ' assets';
  if ((d.project.runtime || 'studio') === 'legacy') st += '  ·  LEGADO';
  if (b) st += '  ·  build ' + b.extras + ' extras, ' + (b.jsBytes / 1024).toFixed(1) + 'KB JS';
  if (S.snap.play && S.snap.play.running) st += '  ·  PLAY';
  $('#status').textContent = st;
}

function renderSceneSel() {
  const sel = $('#sceneSel');
  const d = S.snap.describe;
  sel.innerHTML = '';
  for (const sc of d.scenes) {
    const opt = el('option', { value: sc.guid, text: sc.name + (sc.start ? '  *' : '') });
    if (sc.guid === S.sceneGuid) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    S.sceneGuid = sel.value;
    S.sel = { kind: 'scene', id: null, comp: null };
    renderHierarchy(); renderInspector(); draw();
  };
}

// ----------------------------------------------------------- hierarchy ----

function entityIcon(e) {
  if (e.prefab) return '⌘';
  const comps = e.components || [];
  if (comps.some((c) => c.type === 'anim')) return '▣';
  if (comps.some((c) => c.type === 'sprite')) return '▣';
  if (comps.some((c) => c.type === 'text')) return 'T';
  if (comps.some((c) => c.type === 'script')) return 'JS';
  if (comps.some((c) => c.type === 'shape')) return '◆';
  return '·';
}

function renderHierarchy() {
  const box = $('#hierarchy');
  box.innerHTML = '';
  const sc = currentScene();
  if (!sc) { box.appendChild(el('div', { class: 'empty', text: 'nenhuma cena' })); return; }
  const q = (S.hierFilter || '').trim().toLowerCase();
  const show = (s) => !q || String(s || '').toLowerCase().indexOf(q) >= 0;

  const sceneRow = el('div', {
    class: 'row scene' + (S.sel.kind === 'scene' ? ' sel' : ''),
    onclick: () => { S.sel = { kind: 'scene', id: null, comp: null }; renderHierarchy(); renderInspector(); draw(); },
  }, [el('span', { class: 'ico', text: '▤' }), el('span', { class: 'nm', text: sc.name })]);
  box.appendChild(sceneRow);

  let shown = 0;
  for (const e of sc.entities || []) {
    if (!show(e.name) && !show(e.fid)) continue;
    shown++;
    const row = el('div', {
      class: 'row' + (S.sel.kind === 'entity' && S.sel.id === e.fid ? ' sel' : ''),
      title: e.fid,
      onclick: () => selectEntity(e.fid),
    }, [
      el('span', { class: 'ico', text: entityIcon(e) }),
      el('span', { class: 'nm', text: e.name + (e.active === false ? '  (off)' : '') }),
      el('span', { class: 'tag', text: 'z' + (e.z || 0) }),
    ]);
    box.appendChild(row);
  }

  for (const tm of sc.tilemaps || []) {
    if (!show(tm.id) && !show(tm.tileset)) continue;
    shown++;
    const a = asset(tm.tileset);
    const row = el('div', {
      class: 'row tm' + (S.sel.kind === 'tilemap' && S.sel.id === tm.id ? ' sel' : ''),
      onclick: () => { S.sel = { kind: 'tilemap', id: tm.id, comp: null }; renderHierarchy(); renderInspector(); draw(); },
    }, [
      el('span', { class: 'ico', text: '▦' }),
      el('span', { class: 'nm', text: 'Tilemap ' + tm.id }),
      el('span', { class: 'tag', text: (a ? a.name : '?') + ' ' + tm.cols + 'x' + tm.rows }),
    ]);
    box.appendChild(row);
  }
  if (!shown && q) box.appendChild(el('div', { class: 'empty', text: 'nada casa com o filtro' }));
}

function selectEntity(fid) {
  S.sel = { kind: 'entity', id: fid, comp: null };
  renderHierarchy(); renderInspector(); draw();
}

function selectProject() {
  S.sel = { kind: 'project', id: null, comp: null };
  renderHierarchy(); renderInspector(); draw();
}

// -------------------------------------------------------------- assets ----

function imageFor(a) {
  if (!a) return null;
  if (S.images.has(a.guid)) return S.images.get(a.guid);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => draw();
  img.src = '/api/assets?path=' + encodeURIComponent(a.path) + '&v=' + (a.size || 0);
  S.images.set(a.guid, img);
  return img;
}

function assetIcon(a) {
  if (a.kind === 'sprite' || a.kind === 'sprite-sheet' || a.kind === 'tileset') {
    const img = imageFor(a);
    return el('img', { class: 'asset-thumb', src: img.src, alt: '' });
  }
  const map = { audio: '♪', script: '</>', scene: '▤', prefab: '⌘' };
  return el('span', { class: 'ico', text: map[a.kind] || '·' });
}

// cena/prefab mostram o TITULO do JSON (scene.rename troca so o titulo; o
// arquivo mantem o nome antigo, entao o asset.name enganava na lista)
function assetLabel(a) {
  if (a.kind === 'scene' && S.snap && S.snap.scenes && S.snap.scenes[a.guid]) {
    return S.snap.scenes[a.guid].name || a.name;
  }
  if (a.kind === 'prefab' && S.snap && S.snap.prefabs && S.snap.prefabs[a.guid]) {
    return S.snap.prefabs[a.guid].name || a.name;
  }
  return a.name;
}

function renderAssets() {
  const box = $('#assets');
  box.innerHTML = '';
  const groups = { Sprite: [], Audio: [], Script: [], Cena: [], Prefab: [] };
  const q = (S.assetFilter || '').trim().toLowerCase();
  for (const a of S.snap.describe.assets || []) {
    if (q && String(a.name + ' ' + a.path + ' ' + a.kind).toLowerCase().indexOf(q) < 0) continue;
    let g = 'Sprite';
    if (a.kind === 'audio') g = 'Audio';
    else if (a.kind === 'script') g = 'Script';
    else if (a.kind === 'scene') g = 'Cena';
    else if (a.kind === 'prefab') g = 'Prefab';
    groups[g].push(a);
  }
  for (const g of Object.keys(groups)) {
    if (!groups[g].length) continue;
    box.appendChild(el('div', { class: 'panel-head', text: g.toUpperCase() }));
    for (const a of groups[g]) {
      const row = el('div', {
        class: 'row' + (S.sel.kind === 'asset' && S.sel.id === a.guid ? ' sel' : ''),
        title: a.path,
        draggable: 'true',
        ondragstart: (ev) => {
          S.dragAsset = a.guid;
          try {
            ev.dataTransfer.setData('text/plain', JSON.stringify({ guid: a.guid, kind: a.kind }));
            ev.dataTransfer.effectAllowed = 'copy';
          } catch (e) {}
        },
        ondragend: () => { S.dragAsset = null; },
        onclick: () => selectAsset(a.guid),
        ondblclick: () => {
          if (a.kind === 'scene') { S.sceneGuid = a.guid; S.sel = { kind: 'scene', id: null, comp: null }; renderSceneSel(); renderHierarchy(); renderInspector(); draw(); }
          else if (a.kind === 'script') openScript(a);
        },
      }, [
        assetIcon(a),
        el('span', { class: 'nm', text: assetLabel(a) }),
        el('span', { class: 'tag', text: KIND_LABEL[a.kind] || a.kind }),
      ]);
      box.appendChild(row);
    }
  }
  const newScript = el('button', {
    class: 'mini', text: '+ script',
    onclick: async () => {
      const name = prompt('nome do script (sem .js):', 'meu_script');
      if (!name) return;
      try {
        const r = await ops([{ op: 'script.set', name: name, content:
          '// ' + name + ' — componente do Celer Studio (ES5)\n' +
          'exports.props = { speed: 60 };\n' +
          'exports.start = function (ctx) { this.t = 0; };\n' +
          'exports.update = function (dt, ctx) { this.t += dt; };\n' }]);
        const a = r.results && r.results[0] && r.results[0].asset;
        if (a) selectAsset(a.guid);
      } catch (e) { logError(e); }
    },
  });
  box.appendChild(el('div', { class: 'row' }, [newScript]));
}

function selectAsset(guid) {
  S.sel = { kind: 'asset', id: guid, comp: null };
  renderHierarchy(); renderAssets(); renderInspector(); draw();
}

// ----------------------------------------------------------- inspector ----

function field(label, input, wide) {
  return el('div', { class: 'field' + (wide ? ' wide' : '') }, [el('label', { text: label }), input]);
}
function num(value, onChange, step) {
  const i = el('input', { type: 'number', step: step || 1 });
  i.value = value === undefined || value === null ? '' : value;
  i.addEventListener('change', () => onChange(Number(i.value)));
  return i;
}
function text(value, onChange) {
  const i = el('input', { type: 'text' });
  i.value = value === undefined || value === null ? '' : value;
  i.addEventListener('change', () => onChange(i.value));
  return i;
}
function color(value, onChange) {
  const i = el('input', { type: 'color' });
  i.value = /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : '#000000';
  let t = null;
  i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onChange(i.value), 180); });
  return i;
}
function check(value, onChange) {
  const i = el('input', { type: 'checkbox' });
  i.checked = !!value;
  i.addEventListener('change', () => onChange(i.checked));
  return i;
}
function select(value, values, onChange) {
  const s = el('select');
  for (const v of values) {
    const o = el('option', { value: v.value, text: v.label });
    if (String(value) === String(v.value)) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function longText(value, onChange) {
  const t = el('textarea');
  t.value = value === undefined || value === null ? '' : value;
  t.addEventListener('change', () => onChange(t.value));
  return t;
}

function jsonArea(value, onCommit) {
  const t = el('textarea');
  t.value = JSON.stringify(value || {}, null, 2);
  t.addEventListener('change', () => {
    try { onCommit(JSON.parse(t.value)); }
    catch (e) { log('JSON invalido: ' + e.message, 'err'); t.value = JSON.stringify(value || {}, null, 2); }
  });
  return t;
}

function renderInspector() {
  stopAnimPreview();
  const box = $('#inspector');
  const kind = $('#inspKind');
  box.innerHTML = '';
  if (!S.snap) return;
  const sc = currentScene();

  if (S.sel.kind === 'project') {
    kind.textContent = 'PROJETO';
    renderProjectInspector(box);
    return;
  }
  if (S.sel.kind === 'asset') {
    kind.textContent = 'ASSET';
    renderAssetInspector(box, assetByGuid(S.sel.id));
    return;
  }
  if (S.sel.kind === 'entity' && sc) {
    kind.textContent = 'ENTIDADE';
    const e = sceneEntity(sc, S.sel.id);
    if (!e) { box.appendChild(el('div', { class: 'empty', text: 'entidade sumiu' })); return; }
    renderEntityInspector(box, sc, e);
    return;
  }
  if (S.sel.kind === 'tilemap' && sc) {
    kind.textContent = 'TILEMAP';
    const tm = (sc.tilemaps || []).find((t) => t.id === S.sel.id);
    if (!tm) { box.appendChild(el('div', { class: 'empty', text: 'tilemap sumiu' })); return; }
    renderTilemapInspector(box, sc, tm);
    return;
  }
  kind.textContent = 'CENA';
  if (sc) renderSceneInspector(box, sc); else box.appendChild(el('div', { class: 'empty', text: 'sem cena' }));
}

function renderProjectInspector(box) {
  const prj = S.snap.describe.project;
  const lim = S.snap.describe.limits || {};
  const set = (patch) => projectSet(patch);
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'IDENTIDADE' }),
    field('nome', text(prj.name, (v) => set({ name: v }))),
    field('pacote', text(prj.packageName, (v) => set({ packageName: v }))),
    field('versao', text(prj.version, (v) => set({ version: v }))),
    field('autor', text(prj.author || '', (v) => set({ author: v }))),
    field('categoria', text(prj.category || '', (v) => set({ category: v }))),
    field('tipo', text(prj.type || 'Game', (v) => set({ type: v }))),
    field('API', num(prj.api, (v) => set({ api: v }), 1)),
    field('runtime', select(prj.runtime || 'studio', [
      { value: 'studio', label: 'jogo (studio)' },
      { value: 'app', label: 'programa (app)' },
      { value: 'legacy', label: 'legado (bridge)' },
    ], (v) => {
      if (v === (prj.runtime || 'studio')) return;
      if (!confirm('Trocar o runtime para "' + v + '"?\\n\\nComponentes do outro modo passam a dar ' +
                   'erro de validacao (ui.* so no app, sprite/anim so no jogo).')) return;
      set({ runtime: v });
    })),
    field('start scene', select(prj.startScene || '', (S.snap.describe.scenes || []).map((sc) => ({
      value: sc.guid, label: sc.name,
    })), (v) => set({ startScene: v }))),
    field('descricao', longText(prj.description || '', (v) => set({ description: v })), true),
    field('changelog', longText(prj.changelog || '', (v) => set({ changelog: v })), true),
  ]));

  const cv = prj.canvas || {};
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'CANVAS / ESP32' }),
    field('largura', num(cv.w || 240, (v) => set({ canvas: { w: v } }), 1)),
    field('altura', num(cv.h || 320, (v) => set({ canvas: { h: v } }), 1)),
    field('nativo', check(cv.native, (v) => set({ canvas: { native: v } }))),
    field('fps', num(cv.fps === undefined ? 30 : cv.fps, (v) => set({ canvas: { fps: v } }), 1)),
    field('inset', num(cv.inset || 0, (v) => set({ canvas: { inset: v } }), 1)),
    field('split KB', num((prj.build || {}).splitKB || 96, (v) => set({ build: { splitKB: v } }), 1)),
    el('div', { class: 'hint', text: 'canvas nativo usa pixels fisicos; apps em 240x320 usam UI::sx/sy' }),
  ]));

  const psram = (prj.requires || []).indexOf('psram') >= 0;
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'PACOTE' }),
    field('topbar', check(prj.topbar, (v) => set({ topbar: v }))),
    field('psram', check(psram, (v) => set({ requires: v ? ['psram'] : [] }))),
    field('permissoes', jsonArea(prj.permissions || [], (v) => set({ permissions: v })), true),
    field('deps', jsonArea(prj.deps || {}, (v) => set({ deps: v })), true),
    el('div', { class: 'hint', text: Object.keys(prj.deps || {}).length + '/' + (lim.deps || 8) +
      ' deps · teto JS ' + (lim.jsKB || 1024) + 'KB · assets ' + (lim.assetsKB || 256) + 'KB' }),
  ]));

  const b = S.snap.build;
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'STATUS DO BUILD' }),
    el('div', { class: 'usage', text: b
      ? (b.extras + '/16 extras · ' + (b.jsBytes / 1024).toFixed(1) + 'KB JS · ' +
         (b.assetBytes / 1024).toFixed(1) + 'KB assets')
      : 'sem build ainda' }),
    el('div', { class: 'rowbtns' }, [
      el('button', { class: 'mini primary', text: 'build', onclick: doBuild }),
      el('button', { class: 'mini', text: 'validar', onclick: doValidate }),
    ]),
  ]));
}

function renderSceneInspector(box, sc) {
  const st = sc.settings || {};
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'CENA' }),
    field('nome', text(sc.name, (v) => ops([{ op: 'scene.rename', scene: sc.guid, name: v }]))),
    field('cor de fundo', color(st.bg || '#000000', (v) => sceneSetting(sc, { bg: v }))),
    field('fps', num(st.fps === undefined ? 30 : st.fps, (v) => sceneSetting(sc, { fps: v }), 1)),
    isAppMode() ? null : field('estatica', check(st.static, (v) => sceneSetting(sc, { static: v }))),
    el('div', { class: 'rowbtns' }, [
      el('button', {
        class: 'mini', text: sc.guid === S.snap.describe.project.startScene ? 'cena inicial ✓' : 'definir inicial',
        onclick: () => ops([{ op: 'scene.start', scene: sc.guid }]),
      }),
      el('button', {
        class: 'mini', text: 'excluir cena',
        onclick: () => {
          if ((S.snap.describe.scenes || []).length <= 1) { log('o projeto precisa de ao menos uma cena', 'err'); return; }
          if (!confirm('Excluir a cena "' + sc.name + '"?')) return;
          ops([{ op: 'scene.delete', scene: sc.guid }]).then((r) => {
            S.sceneGuid = null; S.sel = { kind: 'scene', id: null, comp: null };
            if (r.snapshot) setSnapshot(r.snapshot, {}); else loadSnapshot({});
          });
        },
      }),
    ]),
  ]));

  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'DADOS DA CENA' }),
    field('data (JSON)', jsonArea(st.data || {}, (v) => sceneSetting(sc, { data: v }, ['data'])), true),
    field('assets (JSON)', jsonArea(st.assets || [], (v) => sceneSetting(sc, { assets: v }, ['assets'])), true),
    field('musica', select(st.music || '', [{ value: '', label: '(nenhuma)' }].concat(
      (S.snap.describe.assets || []).filter((a) => a.kind === 'audio')
        .map((a) => ({ value: a.guid, label: a.name }))), (v) => sceneSetting(sc, { music: v }, ['music']))),
    el('div', { class: 'hint', text: isAppMode()
      ? 'data = estado inicial da TELA (os widgets leem/escrevem por chave)'
      : 'data/assets sao lidos pelo controlador da cena; assets aceita GUID ou nome' }),
  ]));

  if (isAppMode()) {
    const sids = st.scripts || [];
    const secApp = el('div', { class: 'insp-section' }, [
      el('h4', { text: 'TELA (PROGRAMA)' }),
      field('cabecalho', check(st.header !== false, (v) => sceneSetting(sc, { header: v }))),
      field('subtitulo', text(st.sub || '', (v) => sceneSetting(sc, { sub: v }))),
      field('persistir', text(st.persist || '', (v) => sceneSetting(sc, { persist: v }))),
      el('div', { class: 'hint', text: 'persistir = chave de Storage do estado; o cabecalho desenha UI.header com voltar' }),
    ]);
    secApp.appendChild(el('h4', { text: 'SCRIPTS DA TELA (' + sids.length + ')' }));
    if (!sids.length) secApp.appendChild(el('div', { class: 'hint', text: 'nenhum script de tela' }));
    sids.forEach((ref, i) => {
      const a = asset(ref);
      secApp.appendChild(el('div', { class: 'row' }, [
        el('span', { class: 'nm', text: a ? a.name : ref }),
        el('button', {
          class: 'mini', text: 'x',
          onclick: () => {
            const next = sids.slice();
            next.splice(i, 1);
            sceneSetting(sc, { scripts: next });
          },
        }),
      ]));
    });
    const scriptAssets = (S.snap.describe.assets || []).filter((a) => a.kind === 'script');
    secApp.appendChild(select('', [{ value: '', label: '+ script da tela...' }].concat(
      scriptAssets.map((a) => ({ value: a.guid, label: a.name }))),
      (v) => { if (v) sceneSetting(sc, { scripts: sids.concat([v]) }); }));
    box.appendChild(secApp);
  }

  const cam = st.camera || {};
  const b = cam.bounds || [0, 0, S.snap.describe.project.canvas.w, S.snap.describe.project.canvas.h];
  const dz = cam.deadzone || [0, 0];
  const fids = [{ value: '', label: '(nenhuma)' }].concat(
    (sc.entities || []).map((e) => ({ value: e.fid, label: e.name })));
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'CAMERA' }),
    field('bounds x', num(b[0], (v) => cameraSetting(sc, { bounds: [v, b[1], b[2], b[3]] }))),
    field('bounds y', num(b[1], (v) => cameraSetting(sc, { bounds: [b[0], v, b[2], b[3]] }))),
    field('bounds w', num(b[2], (v) => cameraSetting(sc, { bounds: [b[0], b[1], v, b[3]] }))),
    field('bounds h', num(b[3], (v) => cameraSetting(sc, { bounds: [b[0], b[1], b[2], v] }))),
    field('segue', select(cam.follow || '', fids, (v) => cameraSetting(sc, { follow: v }))),
    field('deadzone w', num(dz[0], (v) => cameraSetting(sc, { deadzone: [v, dz[1]] }))),
    field('deadzone h', num(dz[1], (v) => cameraSetting(sc, { deadzone: [dz[0], v] }))),
  ]));

  const tms = sc.tilemaps || [];
  const sec = el('div', { class: 'insp-section' }, [el('h4', { text: 'TILEMAPS (' + tms.length + ')' })]);
  for (const tm of tms) {
    const a = asset(tm.tileset);
    sec.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'nm', text: tm.id + '  ' + tm.cols + 'x' + tm.rows + '  ' + (a ? a.name : '?') }),
      el('button', { class: 'mini', text: 'sel', onclick: () => { S.sel = { kind: 'tilemap', id: tm.id, comp: null }; renderHierarchy(); renderInspector(); draw(); } }),
    ]));
  }
  const tilesets = (S.snap.describe.assets || []).filter((a) => a.kind === 'tileset' || a.kind === 'sprite-sheet');
  if (tilesets.length) {
    const tsSel = select(tilesets[0].guid, tilesets.map((a) => ({ value: a.guid, label: a.name })), () => {});
    const cols = num(15, () => {}, 1); cols.value = 15;
    const rows = num(10, () => {}, 1); rows.value = 10;
    const cell = num(16, () => {}, 1); cell.value = 16;
    sec.appendChild(el('h4', { text: 'NOVO TILEMAP' }));
    sec.appendChild(field('tileset', tsSel));
    sec.appendChild(field('cols', cols));
    sec.appendChild(field('rows', rows));
    sec.appendChild(field('cell', cell));
    sec.appendChild(el('button', {
      class: 'mini', text: 'criar tilemap',
      onclick: () => {
        const c = Number(cols.value) | 0, r = Number(rows.value) | 0;
        if (c < 1 || r < 1) { log('cols/rows invalidos', 'err'); return; }
        const data = new Array(c * r).fill(0);
        const solids = new Array(c * r).fill(false);
        ops([{ op: 'tilemap.add', scene: sc.guid, tileset: tsSel.value, cols: c, rows: r, cell: Number(cell.value) || 16, data, solids }]);
      },
    }));
  } else {
    sec.appendChild(el('div', { class: 'empty', text: 'importe um PNG e mude o importer para tileset' }));
  }
  box.appendChild(sec);

  const ed = S.snap.describe.project.editor || {};
  const cv = S.snap.describe.project.canvas || {};
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'DIAGNOSTICO (REBUILD/PLAY)' }),
    field('debug (E.debug)', check(ed.debug, (v) => projectSet({ editor: { debug: v } }))),
    field('profiler (E.prof)', check(ed.prof, (v) => projectSet({ editor: { prof: v } }))),
    field('inset preview', num(cv.inset || 0, (v) => projectSet({ canvas: { inset: v } }), 1)),
    el('div', { class: 'hint', text: 'o device usa E.inset do firmware; aqui e so o preview' }),
  ]));
}

function projectSet(patch) {
  ops([{ op: 'project.set', ...patch }], { keepInspector: true });
}

function sceneSetting(sc, patch, replace) {
  const op = { op: 'scene.set', scene: sc.guid, settings: patch };
  if (replace) op.replace = replace;
  ops([op], { keepInspector: true });
}
function cameraSetting(sc, patch) {
  ops([{ op: 'scene.set', scene: sc.guid, settings: { camera: patch } }], { keepInspector: true });
}

function spriteOptions() {
  const out = [];
  for (const a of S.snap.describe.assets || []) {
    if (!['sprite', 'sprite-sheet', 'tileset'].includes(a.kind)) continue;
    const g = el('optgroup', { label: a.name });
    for (const r of a.regionsList || []) {
      g.appendChild(el('option', { value: a.guid + '#' + r.name, text: r.name }));
    }
    out.push(g);
  }
  return out;
}

// input de um campo de componente a partir da definicao do catalogo (ou de
// exports.props do script, que usa o mesmo formato)
function compInput(def, val, onChange) {
  const d = def || { type: 'string' };
  if (d.type === 'number' || d.type === 'int') {
    return num(val === undefined ? d.default : val, onChange, d.type === 'int' ? 1 : 0.1);
  }
  if (d.type === 'bool') return check(val === undefined ? d.default : val, onChange);
  if (d.type === 'color') return color(val === undefined ? d.default : val, onChange);
  if (d.type === 'enum') {
    return select(val === undefined ? d.default : val,
      (d.values || []).map((x) => ({ value: x, label: x || '(vazio)' })), onChange);
  }
  if (d.type === 'sprite') {
    const s = el('select');
    s.appendChild(el('option', { value: '', text: '(nenhum)' }));
    for (const g of spriteOptions()) s.appendChild(g);
    s.value = val || '';
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  if (d.type === 'script') {
    const s = el('select');
    s.appendChild(el('option', { value: '', text: '(nenhum)' }));
    for (const a of S.snap.describe.assets || []) {
      if (a.kind === 'script') s.appendChild(el('option', { value: a.guid, text: a.name }));
    }
    const sa = asset(val);
    s.value = sa ? sa.guid : (val || '');
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  if (d.type === 'asset') {
    const s = el('select');
    s.appendChild(el('option', { value: '', text: '(nenhum)' }));
    for (const a of S.snap.describe.assets || []) {
      if (['sprite', 'sprite-sheet', 'tileset'].includes(a.kind)) {
        s.appendChild(el('option', { value: a.guid, text: a.name }));
      }
    }
    const sa = asset(val);
    s.value = sa ? sa.guid : (val || '');
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  if (d.type === 'json') return jsonArea(val === undefined ? d.default : val, onChange);
  return text(val === undefined ? d.default : val, onChange);
}

function renderEntityInspector(box, sc, e) {
  const t = e.transform || { x: 0, y: 0, rot: 0, sx: 1, sy: 1, ax: 0.5, ay: 0.5 };
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: e.prefab ? 'INSTANCIA DE PREFAB' : 'ENTIDADE' }),
    field('nome', text(e.name, (v) => entitySet(sc, e, { name: v }))),
    field('fid', el('input', { type: 'text', value: e.fid, disabled: 'disabled' })),
    field('ativo', check(e.active !== false, (v) => entitySet(sc, e, { active: v }))),
    field('z', num(e.z || 0, (v) => entitySet(sc, e, { z: v }))),
  ]));
  if (e.prefab) {
    const pf = prefabByGuid(e.prefab);
    box.appendChild(el('div', { class: 'insp-section' }, [
      el('h4', { text: 'PREFAB' }),
      el('div', { class: 'hint', text: (pf ? pf.name : e.prefab) + ' — o build achata; edite os overrides abaixo.' }),
      field('overrides', jsonArea(e.overrides || {}, (v) => entitySet(sc, e, { overrides: v }))),
    ]));
  }
  const piv = spritePivot(e);
  const axShown = t.ax === undefined ? piv.ax : t.ax;
  const ayShown = t.ay === undefined ? piv.ay : t.ay;
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'TRANSFORM' }),
    field('x', num(t.x, (v) => entitySet(sc, e, { transform: { x: v } }))),
    field('y', num(t.y, (v) => entitySet(sc, e, { transform: { y: v } }))),
    field('rot', num(t.rot || 0, (v) => entitySet(sc, e, { transform: { rot: v } }))),
    field('escala x', num(t.sx === undefined ? 1 : t.sx, (v) => entitySet(sc, e, { transform: { sx: v } }), 0.1)),
    field('escala y', num(t.sy === undefined ? 1 : t.sy, (v) => entitySet(sc, e, { transform: { sy: v } }), 0.1)),
    field('ancora x', num(axShown, (v) => entitySet(sc, e, { transform: { ax: v } }), 0.1)),
    field('ancora y', num(ayShown, (v) => entitySet(sc, e, { transform: { ay: v } }), 0.1)),
    el('div', { class: 'hint', text: 'ancora ausente herda o pivot do sprite (E.spr.meta)' }),
  ]));

  const cat = (S.snap.describe.components || {});
  for (const c of e.components || []) {
    if (!cat[c.type]) continue;
    const comp = el('div', { class: 'comp' });
    const head = el('div', { class: 'comp-head' }, [
      el('b', { text: (cat[c.type].label || c.type).toUpperCase() }),
      el('span', { class: 'badge', text: c.id || '' }),
      el('button', {
        class: 'mini', text: 'x', title: 'remover componente',
        onclick: () => {
          if (!confirm('Remover componente ' + c.type + '?')) return;
          ops([{ op: 'component.remove', scene: sc.guid, entity: e.fid, component: c.id }]);
        },
      }),
    ]);
    const body = el('div', { class: 'comp-body' });
    const fields = cat[c.type].fields || {};
    if (c.type === 'script') {
      // script: o asset manda; os campos vem de exports.props (tipados).
      // Sem props declarados, cai no JSON livre do catalogo.
      body.appendChild(field('script', compInput(fields.script, (c.fields || {}).script,
        (v) => compSet(sc, e, c, 'script', v))));
      const sa = asset((c.fields || {}).script);
      const props = (sa && sa.settings && sa.settings.props) || {};
      const names = Object.keys(props);
      const vals = (c.fields || {}).fields || {};
      if (!names.length) {
        body.appendChild(field('fields (JSON)', compInput(fields.fields, vals,
          (v) => compSet(sc, e, c, 'fields', v)), true));
        body.appendChild(el('div', { class: 'hint',
          text: 'declare exports.props no script para editar os campos com tipo/default' }));
      } else {
        for (const name of names) {
          const def = props[name] || { type: 'string' };
          const val = vals[name] !== undefined ? vals[name] : def.default;
          body.appendChild(field(def.label || name,
            compInput(def, val, (v) => compSet(sc, e, c, 'fields.' + name, v))));
        }
        body.appendChild(el('div', { class: 'hint',
          text: names.length + ' campo(s) declarados em exports.props' }));
      }
      comp.appendChild(head); comp.appendChild(body);
      box.appendChild(comp);
      continue;
    }
    for (const name in fields) {
      const def = fields[name];
      const val = (c.fields || {})[name];
      const onChange = (v) => {
        if (def.type === 'asset') {
          // escolher o atlas tambem acerta o clipe atual (um lote so)
          const ma = asset(v);
          const anims = (ma && ma.settings && ma.settings.anims) || {};
          const first = Object.keys(anims)[0] || '';
          const cur = (c.fields || {}).current;
          const patch = {};
          patch[name] = v;
          if (first && (!cur || !anims[cur])) patch.current = first;
          ops([{ op: 'component.set', scene: sc.guid, entity: e.fid, component: c.id,
                 fields: patch }], { keepInspector: true });
          return;
        }
        compSet(sc, e, c, name, v);
      };
      body.appendChild(field(def.label || name, compInput(def, val, onChange)));
    }
    comp.appendChild(head); comp.appendChild(body);
    box.appendChild(comp);
  }

  const addable = Object.keys(cat).filter((k) => !cat[k].implicit);
  const addSel = select('', [{ value: '', label: '+ componente' }].concat(
    addable.map((k) => ({ value: k, label: cat[k].label || k }))), () => {});
  addSel.addEventListener('change', () => {
    const type = addSel.value;
    if (!type) return;
    const fields = {};
    if (type === 'sprite') {
      const a = (S.snap.describe.assets || []).find((x) => ['sprite', 'sprite-sheet', 'tileset'].includes(x.kind));
      if (!a) { log('importe um PNG antes de adicionar sprite', 'err'); addSel.value = ''; return; }
      const r = (a.regionsList || [])[0];
      fields.sprite = a.guid + (r ? '#' + r.name : '');
    } else if (type === 'script') {
      const a = (S.snap.describe.assets || []).find((x) => x.kind === 'script');
      if (!a) { log('crie ou importe um script antes', 'err'); addSel.value = ''; return; }
      fields.script = a.guid;
    }
    ops([{ op: 'component.add', scene: sc.guid, entity: e.fid, type: type, fields: fields }]);
  });
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'COMPONENTES' }),
    addSel,
    el('div', { class: 'rowbtns' }, [
      el('button', {
        class: 'mini', text: 'duplicar',
        onclick: () => ops([{ op: 'entity.duplicate', scene: sc.guid, entity: e.fid }]),
      }),
      el('button', {
        class: 'mini', text: 'criar prefab',
        onclick: () => {
          const name = prompt('nome do prefab (sem extensao):', e.name);
          if (!name) return;
          ops([{ op: 'prefab.create', name, scene: sc.guid, entity: e.fid }]).then((r) => {
            const pf = r.results && r.results[0] && r.results[0].prefab;
            if (pf) selectAsset(pf.guid);
          }).catch(() => {});
        },
      }),
      el('button', {
        class: 'mini', text: 'excluir entidade',
        onclick: () => {
          if (!confirm('Excluir "' + e.name + '"?')) return;
          ops([{ op: 'entity.delete', scene: sc.guid, entity: e.fid }]).then(() => {
            S.sel = { kind: 'scene', id: null, comp: null }; renderHierarchy(); renderInspector(); draw();
          });
        },
      }),
    ]),
  ]));
}

function tileByCurrent() {
  const sc = currentScene();
  if (!sc) return null;
  return (sc.tilemaps || []).find((t) => t.id === S.tile.tmId) || null;
}

function beginStroke(tm, value) {
  if (!S.tile.data || S.tile.tmId !== tm.id) {
    S.tile.data = tm.data.slice();
    S.tile.solids = tm.solids ? tm.solids.slice() : new Array(tm.data.length).fill(false);
  }
  S.tile.tmId = tm.id;
  S.tile.strokeValue = value;
  S.tile.painting = true;
}

function paintAt(ev) {
  const sc = currentScene();
  const tm = (sc && (sc.tilemaps || []).find((t) => t.id === S.tile.tmId)) || null;
  if (!tm) return false;
  const w = screenToWorld(ev);
  const c = Math.floor((w.x - (tm.ox || 0)) / tm.cell);
  const r = Math.floor((w.y - (tm.oy || 0)) / tm.cell);
  if (c < 0 || r < 0 || c >= tm.cols || r >= tm.rows) return false;
  const i = r * tm.cols + c;
  const v = S.tile.strokeValue;
  S.tile.data[i] = v;
  S.tile.solids[i] = v >= 0 ? !!S.tile.solid : false;
  // espelho na cena viva para o viewport mostrar na hora
  tm.data[i] = v;
  if (!tm.solids) tm.solids = new Array(tm.data.length).fill(false);
  tm.solids[i] = S.tile.solids[i];
  S.tile.dirty = true;
  S.tile.hover = { c, r };
  draw();
  return true;
}

function commitPaint() {
  if (!S.tile.painting) return;
  S.tile.painting = false;
  if (!S.tile.dirty) return;
  const sc = currentScene();
  const tm = tileByCurrent();
  if (!sc || !tm) return;
  const data = S.tile.data.slice();
  const solids = S.tile.solids.slice();
  S.tile.data = null;
  S.tile.solids = null;
  S.tile.dirty = false;
  log('tilemap: gravando ' + tm.id, 'dim');
  ops([{ op: 'tilemap.set', scene: sc.guid, tilemap: tm.id, data: data, solids: solids }],
      { keepInspector: true }).catch(() => loadSnapshot({ keepInspector: true }));
}

function updateTileHover(ev) {
  const tm = tileByCurrent();
  if (!tm) return;
  const w = screenToWorld(ev);
  const c = Math.floor((w.x - (tm.ox || 0)) / tm.cell);
  const r = Math.floor((w.y - (tm.oy || 0)) / tm.cell);
  const inside = c >= 0 && r >= 0 && c < tm.cols && r < tm.rows;
  const next = inside ? { c, r } : null;
  const cur = S.tile.hover;
  if ((next && cur && next.c === cur.c && next.r === cur.r) || (!next && !cur)) return;
  S.tile.hover = next;
  draw();
}

function togglePaint(tm) {
  if (S.tile.active && S.tile.tmId === tm.id) {
    S.tile.active = false;
    S.tile.painting = false;
  } else {
    S.tile.active = true;
    S.tile.tmId = tm.id;
    S.tile.data = null;
    S.tile.solids = null;
    S.tile.dirty = false;
    S.tile.painting = false;
  }
  S.tile.hover = null;
  const cv = $('#view');
  if (cv) cv.style.cursor = S.tile.active ? 'crosshair' : '';
  renderInspector();
  draw();
}

function tilePalette(a, tm) {
  const pal = el('div', { class: 'tilepal' });
  const regs = (a && a.regionsList) || [];
  const addTile = (idx, label) => {
    const r = idx >= 0 ? regs[idx] : null;
    const sel = S.tile.tmId === tm.id && S.tile.value === idx;
    const d = el('div', { class: 'tile' + (sel ? ' sel' : ''), title: label || String(idx) });
    if (r && a.settings) {
      const k = Math.min(28 / r.w, 28 / r.h);
      d.style.backgroundImage = 'url(' + JSON.stringify('/api/assets?path=' + encodeURIComponent(a.path)) + ')';
      d.style.backgroundSize = (a.settings.w * k) + 'px ' + (a.settings.h * k) + 'px';
      d.style.backgroundPosition = '-' + (r.x * k) + 'px -' + (r.y * k) + 'px';
      d.style.imageRendering = 'pixelated';
    } else {
      d.textContent = 'x';
      d.style.color = '#ff8b8b';
    }
    d.onclick = () => {
      S.tile.tmId = tm.id;
      S.tile.value = idx;
      S.tile.active = true;
      S.tile.data = null;
      S.tile.solids = null;
      S.tile.dirty = false;
      S.tile.painting = false;
      const cv = $('#view');
      if (cv) cv.style.cursor = 'crosshair';
      renderInspector();
      draw();
    };
    pal.appendChild(d);
  };
  addTile(-1, 'apagar');
  regs.forEach((r, i) => addTile(i, r.name));
  return pal;
}

function renderTilemapInspector(box, sc, tm) {
  const tilesets = (S.snap.describe.assets || []).filter((a) => a.kind === 'tileset' || a.kind === 'sprite-sheet');
  const set = (patch) => ops([{ op: 'tilemap.set', scene: sc.guid, tilemap: tm.id, ...patch }], { keepInspector: true });
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'TILEMAP ' + tm.id }),
    field('tileset', select(tm.tileset, tilesets.map((a) => ({ value: a.guid, label: a.name })), (v) => set({ tileset: v }))),
    field('cols', num(tm.cols, (v) => set({ cols: v }), 1)),
    field('rows', num(tm.rows, (v) => set({ rows: v }), 1)),
    field('cell', num(tm.cell, (v) => set({ cell: v }), 1)),
    field('ox', num(tm.ox || 0, (v) => set({ ox: v }))),
    field('oy', num(tm.oy || 0, (v) => set({ oy: v }))),
    field('layer', num(tm.layer || 0, (v) => set({ layer: v }), 1)),
    el('h4', { text: 'PINCEL' }),
    tilePalette(asset(tm.tileset), tm),
    field('solido', check(S.tile.solid, (v) => { S.tile.solid = v; })),
    el('div', { class: 'rowbtns' }, [
      el('button', {
        class: 'mini' + (S.tile.active && S.tile.tmId === tm.id ? ' primary' : ''),
        text: S.tile.active && S.tile.tmId === tm.id ? 'parar pincel' : 'pintar no viewport',
        onclick: () => togglePaint(tm),
      }),
    ]),
    el('div', { class: 'hint', text: 'clique/arraste no viewport; botao direito apaga; ' +
      (tm.data || []).length + ' celulas, ' + ((tm.solids || []).filter(Boolean).length) + ' solidas' }),
    el('div', { class: 'rowbtns' }, [
      el('button', {
        class: 'mini', text: 'excluir tilemap',
        onclick: () => {
          if (!confirm('Excluir ' + tm.id + '?')) return;
          S.tile.active = false;
          ops([{ op: 'tilemap.remove', scene: sc.guid, tilemap: tm.id }]).then(() => {
            S.sel = { kind: 'scene', id: null, comp: null }; renderHierarchy(); renderInspector(); draw();
          });
        },
      }),
    ]),
  ]));
}

function stopAnimPreview() {
  if (S.animPreview && S.animPreview.timer) clearInterval(S.animPreview.timer);
  S.animPreview = null;
}

function refGuid(ref) { return ref ? String(ref).split('#')[0] : ''; }

function assetUsage(guid) {
  const scenes = [], prefabs = [];
  const useEntity = (e) => {
    let hit = e.prefab === guid;
    for (const c of e.components || []) {
      const f = c.fields || {};
      if (c.type === 'sprite' && refGuid(f.sprite) === guid) hit = true;
      if (c.type === 'script' && refGuid(f.script) === guid) hit = true;
      if (c.type === 'anim') {
        if (f.meta && refGuid(f.meta) === guid) hit = true;
        const clips = f.clips || {};
        for (const k in clips) {
          for (const fr of (clips[k].frames || [])) if (refGuid(fr) === guid) hit = true;
        }
      }
    }
    return hit;
  };
  for (const sc of Object.values(S.snap.scenes || {})) {
    let hit = false;
    for (const tm of sc.tilemaps || []) if (tm.tileset === guid) hit = true;
    for (const ref of (sc.settings && sc.settings.assets) || []) if (refGuid(ref) === guid) hit = true;
    for (const e of sc.entities || []) if (useEntity(e)) hit = true;
    if (hit) scenes.push(sc.name);
  }
  for (const pf of Object.values(S.snap.prefabs || {})) {
    let hit = false;
    for (const e of pf.entities || []) if (useEntity(e)) hit = true;
    if (hit) prefabs.push(pf.name);
  }
  return { scenes, prefabs };
}

function tilesetSolidsSection(a, set) {
  const st = a.settings || {};
  const regs = a.regionsList || [];
  const tiles = (st.tiles || []).slice();
  while (tiles.length < regs.length) tiles.push({ name: String(tiles.length), solid: false });
  const sec = el('div', { class: 'insp-section' }, [
    el('h4', { text: 'SOLIDOS DO TILESET' }),
    el('div', { class: 'hint', text: 'marcado = colide no runtime; map.set usa o valor atual da celula' }),
  ]);
  const grid = el('div', { class: 'tilesolids' });
  regs.forEach((r, i) => {
    const cell = el('label', { class: 'tilesolid', title: 'tile ' + i + ' (' + r.name + ')' });
    if (st.w && st.h) {
      const k = Math.min(36 / r.w, 36 / r.h);
      cell.style.backgroundImage = 'url(' + JSON.stringify('/api/assets?path=' + encodeURIComponent(a.path)) + ')';
      cell.style.backgroundSize = (st.w * k) + 'px ' + (st.h * k) + 'px';
      cell.style.backgroundPosition = '-' + (r.x * k) + 'px -' + (r.y * k) + 'px';
    }
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!tiles[i].solid;
    cb.addEventListener('change', () => {
      const copy = tiles.map((t) => ({ name: t.name, solid: !!t.solid }));
      copy[i].solid = cb.checked;
      set({ tiles: copy });
    });
    cell.appendChild(cb);
    cell.appendChild(el('span', { text: String(i) }));
    grid.appendChild(cell);
  });
  sec.appendChild(grid);
  return sec;
}

function animPreviewSection(a) {
  const st = a.settings || {};
  const anims = st.anims || {};
  const names = Object.keys(anims);
  if (!names.length) return null;
  const regs = a.regionsList || [];
  let clip = names[0], idx = 0, timer = null;
  const frame = el('div', { class: 'anim-frame' });
  const clipSel = select(clip, names.map((n) => ({ value: n, label: n })), (v) => {
    clip = v; idx = 0; show();
  });
  const fps = el('input', { type: 'number', min: '1', max: '30' });
  fps.value = (st.fps && st.fps[clip]) || 6;
  const btn = el('button', { class: 'mini', text: 'play' });
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    btn.textContent = 'play';
    if (S.animPreview) S.animPreview.timer = null;
  };
  const frameRegion = () => {
    const list = anims[clip] || [];
    if (!list.length) return null;
    const it = list[idx % list.length];
    const name = typeof it === 'number' ? (regs[it] || {}).name : it;
    return regs.find((r) => String(r.name) === String(name)) || null;
  };
  const show = () => {
    const r = frameRegion();
    if (!r || !st.w || !st.h) return;
    const k = Math.min(96 / r.w, 96 / r.h);
    frame.style.backgroundImage = 'url(' + JSON.stringify('/api/assets?path=' + encodeURIComponent(a.path)) + ')';
    frame.style.backgroundSize = (st.w * k) + 'px ' + (st.h * k) + 'px';
    frame.style.backgroundPosition = '-' + (r.x * k) + 'px -' + (r.y * k) + 'px';
  };
  btn.onclick = () => {
    if (timer) { stop(); return; }
    const rate = Math.max(1, Math.min(30, +fps.value || 6));
    timer = setInterval(() => { idx++; show(); }, 1000 / rate);
    btn.textContent = 'stop';
    if (!S.animPreview) S.animPreview = {};
    S.animPreview.timer = timer;
    show();
  };
  clipSel.addEventListener('change', stop);
  show();
  return el('div', { class: 'insp-section' }, [
    el('h4', { text: 'PREVIEW DE ANIMACAO' }),
    field('clipe', clipSel),
    field('fps', fps),
    el('div', { class: 'preview-wrap' }, [frame, el('div', {}, [
      btn, el('div', { class: 'hint', text: (anims[clip] || []).length + ' quadros' }),
      el('div', { class: 'hint', text: 'frames do .meta (E.spr.animOf)' }),
    ])]),
  ]);
}

function renderAssetInspector(box, a) {
  if (!a) { box.appendChild(el('div', { class: 'empty', text: 'asset sumiu' })); return; }
  const usage = assetUsage(a.guid);
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: (KIND_LABEL[a.kind] || a.kind).toUpperCase() }),
    field('nome', text(a.name, (v) => ops([{ op: 'asset.rename', asset: a.guid, name: v }]))),
    field('guid', el('input', { type: 'text', value: a.guid, disabled: 'disabled' })),
    field('arquivo', el('input', { type: 'text', value: a.path, disabled: 'disabled' })),
    field('importer', el('input', { type: 'text', value: a.importer, disabled: 'disabled' })),
    field('bytes', el('input', { type: 'text', value: a.size, disabled: 'disabled' })),
    el('div', { class: 'usage', text: usage.scenes.length || usage.prefabs.length
      ? 'usado em ' + usage.scenes.length + ' cena(s)' + (usage.prefabs.length ? ' e ' + usage.prefabs.length + ' prefab(s)' : '') +
        ': ' + usage.scenes.concat(usage.prefabs).slice(0, 3).join(', ')
      : 'nao usado no build' }),
  ]));

  if (['sprite', 'sprite-sheet', 'tileset'].includes(a.kind)) {
    const st = a.settings || {};
    const set = (patch) => ops([{ op: 'asset.set', asset: a.guid, settings: patch }], { keepInspector: true });
    box.appendChild(el('div', { class: 'insp-section' }, [
      el('h4', { text: 'FATIAMENTO' }),
      field('modo', select(st.mode || 'single', [
        { value: 'single', label: 'imagem unica' },
        { value: 'grid', label: 'grade' },
        { value: 'regions', label: 'regioes' },
      ], (v) => set({ mode: v }))),
      field('colunas', num(st.cols || 1, (v) => set({ cols: v }), 1)),
      field('linhas', num(st.rows || 1, (v) => set({ rows: v }), 1)),
      field('tile w', num(st.tw || 16, (v) => set({ tw: v }), 1)),
      field('tile h', num(st.th || 16, (v) => set({ th: v }), 1)),
      field('pivot x', num((st.pivot || [0.5, 0.5])[0], (v) => set({ pivot: [v, (st.pivot || [0.5, 0.5])[1]] }), 0.1)),
      field('pivot y', num((st.pivot || [0.5, 0.5])[1], (v) => set({ pivot: [(st.pivot || [0.5, 0.5])[0], v] }), 0.1)),
      field('cor-chave', color(st.key || '#000000', (v) => set({ key: v }))),
      field('hitbox x', num((st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[0],
        (v) => set({ hitbox: [v, (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[1],
                             (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[2],
                             (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[3]] }))),
      field('hitbox y', num((st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[1],
        (v) => set({ hitbox: [(st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[0], v,
                             (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[2],
                             (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[3]] }))),
      field('hitbox w', num((st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[2],
        (v) => set({ hitbox: [(st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[0],
                             (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[1], v,
                             (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[3]] }))),
      field('hitbox h', num((st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[3],
        (v) => set({ hitbox: [(st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[0],
                             (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[1],
                             (st.hitbox || [0, 0, st.tw || st.w || 16, st.th || st.h || 16])[2], v] }))),
      field('anims', jsonArea(st.anims || {}, (v) => set({ anims: v }))),
      field('fps', jsonArea(st.fps || {}, (v) => set({ fps: v }))),
      field('loop', jsonArea(st.loop || {}, (v) => set({ loop: v }))),
      el('div', { class: 'hint', text: (a.regionsList || []).length + ' regioes: ' +
        (a.regionsList || []).slice(0, 10).map((r) => r.name).join(', ') +
        ' — anims/fps/loop/hitbox vao para E.spr.meta' }),
      el('div', { class: 'rowbtns' }, [
        el('img', { class: 'asset-thumb', src: '/api/assets?path=' + encodeURIComponent(a.path), style: 'width:96px;height:96px' }),
      ]),
    ]));
    const ap = animPreviewSection(a);
    if (ap) box.appendChild(ap);
    if (a.kind === 'tileset') box.appendChild(tilesetSolidsSection(a, set));
  } else if (a.kind === 'audio') {
    const st = a.settings || {};
    const set = (patch) => ops([{ op: 'asset.set', asset: a.guid, settings: patch }], { keepInspector: true });
    box.appendChild(el('div', { class: 'insp-section' }, [
      el('h4', { text: 'AUDIO' }),
      field('loop', check(st.loop, (v) => set({ loop: v }))),
      field('gain', num(st.gain === undefined ? 1 : st.gain, (v) => set({ gain: v }), 0.1)),
    ]));
  } else if (a.kind === 'script') {
    box.appendChild(el('div', { class: 'insp-section' }, [
      el('h4', { text: 'SCRIPT' }),
      el('div', { class: 'rowbtns' }, [
        el('button', { class: 'mini', text: 'abrir editor', onclick: () => openScript(a) }),
      ]),
    ]));
  }
  if (a.kind === 'prefab') {
    const pf = prefabByGuid(a.guid);
    box.appendChild(el('div', { class: 'insp-section' }, [
      el('h4', { text: 'PREFAB' }),
      el('div', { class: 'hint', text: pf ? (pf.entities || []).length + ' entidade(s) locais; o build achata' : 'prefab ilegivel' }),
      el('div', { class: 'rowbtns' }, [
        el('button', {
          class: 'mini primary', text: 'instanciar na cena',
          onclick: () => {
            const sc = currentScene();
            if (!sc) { log('abra uma cena antes', 'err'); return; }
            const m = sceneMetrics();
            ops([{ op: 'prefab.instance', scene: sc.guid, prefab: a.guid,
                   x: Math.round(m.w / 2), y: Math.round(m.h / 2), z: 0 }]).then((r) => {
              const e = r.results && r.results[0] && r.results[0].entity;
              if (e) selectEntity(e.fid);
            });
          },
        }),
      ]),
    ]));
  }
  if (a.kind === 'scene') {
    box.appendChild(el('button', {
      class: 'mini', text: 'abrir cena',
      onclick: () => { S.sceneGuid = a.guid; S.sel = { kind: 'scene', id: null, comp: null }; renderSceneSel(); renderHierarchy(); renderInspector(); draw(); },
    }));
  }
  box.appendChild(el('div', { class: 'rowbtns' }, [
    el('button', {
      class: 'mini', text: 'excluir asset',
      onclick: () => {
        if (!confirm('Excluir ' + a.name + '? (recusa se estiver em uso)')) return;
        ops([{ op: 'asset.delete', asset: a.guid }]).then(() => {
          S.sel = { kind: 'scene', id: null, comp: null }; renderHierarchy(); renderAssets(); renderInspector(); draw();
        }).catch((e) => logError(e));
      },
    }),
  ]));
}

// ------------------------------------------------------------- viewport ----

function sceneMetrics() {
  const d = S.snap.describe;
  return { w: d.project.canvas.w || 240, h: d.project.canvas.h || 320 };
}

function expandEntities(scene) {
  const out = [];
  const walk = (e, owner, dx, dy, dz, sx, sy, rot, depth) => {
    if (depth > 4) return;
    if (e.prefab) {
      const pf = prefabByGuid(e.prefab);
      if (!pf) return;
      const t = e.transform || {};
      const bx = (t.x || 0) + dx, by = (t.y || 0) + dy;
      const bsx = (t.sx === undefined ? 1 : t.sx) * sx;
      const bsy = (t.sy === undefined ? 1 : t.sy) * sy;
      const brot = (t.rot || 0) + rot;
      const bz = (e.z || 0) + dz;
      const ovs = e.overrides || {};
      for (const child of pf.entities || []) {
        const cl = JSON.parse(JSON.stringify(child));
        const ov = ovs[child.fid] || {};
        cl.fid = e.fid + '/' + child.fid;
        cl.name = ov.name || child.name;
        cl.active = (e.active !== false) &&
          (ov.active !== undefined ? !!ov.active : child.active !== false);
        const ct = cl.transform || { x: 0, y: 0 };
        if (ov.transform) for (const k of ['x', 'y', 'rot', 'sx', 'sy', 'ax', 'ay']) {
          if (ov.transform[k] !== undefined) ct[k] = ov.transform[k];
        }
        if (ov.components) for (const c of cl.components || []) {
          const patch = ov.components[c.id];
          if (patch) { c.fields = c.fields || {}; Object.assign(c.fields, patch); }
        }
        cl.transform = {
          x: bx + (ct.x || 0) * bsx, y: by + (ct.y || 0) * bsy,
          rot: (ct.rot || 0) + brot,
          sx: (ct.sx === undefined ? 1 : ct.sx) * bsx,
          sy: (ct.sy === undefined ? 1 : ct.sy) * bsy,
        };
        if (ct.ax !== undefined) cl.transform.ax = ct.ax;
        if (ct.ay !== undefined) cl.transform.ay = ct.ay;
        cl.z = bz + (child.z || 0);
        if (cl.prefab) walk(cl, owner || e.fid, 0, 0, 0, 1, 1, 0, depth + 1);
        else { cl._owner = owner || e.fid; out.push(cl); }
      }
      return;
    }
    const c = JSON.parse(JSON.stringify(e));
    const t = e.transform || {};
    c.transform = {
      x: (t.x || 0) + dx, y: (t.y || 0) + dy,
      rot: (t.rot || 0) + rot,
      sx: (t.sx === undefined ? 1 : t.sx) * sx,
      sy: (t.sy === undefined ? 1 : t.sy) * sy,
    };
    if (t.ax !== undefined) c.transform.ax = t.ax;
    if (t.ay !== undefined) c.transform.ay = t.ay;
    c.z = (e.z || 0) + dz;
    c._owner = owner || e.fid;
    out.push(c);
  };
  for (const e of scene.entities || []) walk(e, null, 0, 0, 0, 1, 1, 0, 0);
  out.sort((a, b) => (a.z || 0) - (b.z || 0));
  return out;
}

function resolveRef(ref) {
  if (!ref) return null;
  const parts = String(ref).split('#');
  const a = asset(parts[0]);
  if (!a) return null;
  let r = null;
  if (parts.length > 1 && parts[1] !== '') {
    r = (a.regionsList || []).find((x) => String(x.name) === parts[1]);
  } else {
    r = (a.regionsList || [])[0] || null;
  }
  return r ? { asset: a, region: r } : null;
}

function compOf(e, type) {
  return (e.components || []).find((c) => c.type === type) || null;
}

function tsPx(ts, px) {
  if (px !== undefined) return px;
  return { tiny: 9, small: 11, body: 13, label: 15, big: 20, title: 28, huge: 40 }[ts] || 13;
}

function graphicAssetOf(e) {
  const an = compOf(e, 'anim');
  if (an) {
    const f = an.fields || {};
    if (f.meta) {
      const a = asset(f.meta);
      if (a) return a;
    }
    const clips = f.clips || {};
    const clip = clips[f.current] || clips[Object.keys(clips)[0]];
    const fr = clip && clip.frames && clip.frames[0];
    const r = resolveRef(fr);
    if (r) return r.asset;
  }
  const sc = compOf(e, 'sprite');
  if (sc) {
    const r = resolveRef((sc.fields || {}).sprite);
    if (r) return r.asset;
  }
  return null;
}

function spritePivot(e) {
  const a = graphicAssetOf(e);
  const p = (a && a.settings && a.settings.pivot) || [0.5, 0.5];
  return { ax: p[0] === undefined ? 0.5 : p[0], ay: p[1] === undefined ? 0.5 : p[1] };
}

// primeiro quadro de um clipe declarado no .meta (E.spr.animOf)
function metaFrame(a, clipName) {
  const st = a.settings || {};
  const anims = st.anims || {};
  const list = anims[clipName] || anims[Object.keys(anims)[0]];
  if (!list || !list.length) return null;
  const it = list[0];
  const name = typeof it === 'number' ? (a.regionsList[it] || {}).name : it;
  if (name === undefined) return null;
  const r = (a.regionsList || []).find((x) => String(x.name) === String(name));
  return r ? { asset: a, region: r } : null;
}

function entityParts(e) {
  const out = { sprite: null, text: null, shape: null, col: null };
  const an = compOf(e, 'anim');
  if (an) {
    const f = an.fields || {};
    if (f.meta) {
      const a = asset(f.meta);
      if (a) out.sprite = metaFrame(a, f.current);
    }
    if (!out.sprite) {
      const clips = f.clips || {};
      const clip = clips[f.current] || clips[Object.keys(clips)[0]];
      const fr = clip && clip.frames && clip.frames[0];
      if (fr) out.sprite = resolveRef(fr);
    }
  }
  if (!out.sprite) {
    const sc = compOf(e, 'sprite');
    if (sc) out.sprite = resolveRef((sc.fields || {}).sprite);
  }
  const tx = compOf(e, 'text');
  if (tx) out.text = tx.fields || {};
  const sh = compOf(e, 'shape');
  if (sh) out.shape = sh.fields || {};
  const co = compOf(e, 'collider');
  if (co) out.col = co.fields || {};
  return out;
}

function entitySize(e) {
  const p = entityParts(e);
  const t = e.transform || {};
  const sx = t.sx === undefined ? 1 : t.sx;
  const sy = t.sy === undefined ? 1 : t.sy;
  if (p.sprite) {
    const r = p.sprite.region;
    return { w: r.w * sx, h: r.h * sy };
  }
  if (p.text) {
    const px = tsPx(p.text.ts, p.text.px);
    const cv = $('#view').getContext('2d');
    cv.save();
    cv.font = px + 'px ui-monospace, monospace';
    const w = cv.measureText(String(p.text.text || '')).width;
    cv.restore();
    return { w, h: px + 2 };
  }
  if (p.shape) {
    if (p.shape.shape === 'circle') {
      const r = p.shape.r || (p.shape.w || 0) / 2;
      return { w: r * 2, h: r * 2 };
    }
    if (p.shape.shape === 'line') return { w: Math.abs(p.shape.x2 || 0), h: Math.abs(p.shape.y2 || 0) };
    return { w: p.shape.w || 0, h: p.shape.h || 0 };
  }
  return { w: 20, h: 20 };
}

function anchorBox(pt, x, y, w, h) {
  const cv = S.snap.describe.project.canvas || {};
  const W = cv.w || 240, H = cv.h || 320;
  const inset = cv.inset || 0;
  const col = pt % 3, row = Math.floor(pt / 3);
  const bx = col === 0 ? inset + x : (col === 1 ? (W - w) / 2 + x : W - inset - w - x);
  const by = row === 0 ? y : (row === 1 ? (H - h) / 2 + y : H - h - y);
  return { x: bx, y: by, w, h };
}

function hudBox(e) {
  const h = compOf(e, 'hud');
  if (!h) return null;
  const f = h.fields || {};
  const s = entitySize(e);
  return anchorBox(f.anchor | 0, f.mx || 0, f.my || 0, s.w, s.h);
}

function drawHudEntity(ctx, e, b) {
  const p = entityParts(e);
  const t = e.transform || {};
  const sx = t.sx === undefined ? 1 : t.sx;
  const sy = t.sy === undefined ? 1 : t.sy;
  if (p.sprite) {
    const img = imageFor(p.sprite.asset);
    const r = p.sprite.region;
    const piv = spritePivot(e);
    const ax = t.ax === undefined ? piv.ax : t.ax;
    const ay = t.ay === undefined ? piv.ay : t.ay;
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, r.x, r.y, r.w, r.h,
        b.x + b.w * ax - r.w * sx * ax, b.y + b.h * ay - r.h * sy * ay,
        r.w * sx, r.h * sy);
    }
  }
  if (p.text) {
    const px = tsPx(p.text.ts, p.text.px);
    ctx.save();
    ctx.font = px + 'px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (p.text.shadow) { ctx.fillStyle = p.text.shadow; ctx.fillText(String(p.text.text || ''), b.x + 1, b.y + 1); }
    ctx.fillStyle = p.text.color || '#ffffff';
    ctx.fillText(String(p.text.text || ''), b.x, b.y);
    ctx.restore();
  }
  if (p.shape) {
    ctx.save();
    ctx.fillStyle = p.shape.color || '#38bcf8';
    ctx.strokeStyle = p.shape.color || '#38bcf8';
    if (p.shape.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(b.x + b.w / 2, b.y + b.h / 2, p.shape.r || (p.shape.w || 0) / 2, 0, Math.PI * 2);
      if (p.shape.fill === false) ctx.stroke(); else ctx.fill();
    } else if (p.shape.shape === 'line') {
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + (p.shape.x2 || 0), b.y + (p.shape.y2 || 0));
      ctx.lineWidth = p.shape.w || 1; ctx.stroke();
    } else if (p.shape.fill === false) {
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    } else ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
}

function drawHitbox(ctx, e) {
  const a = graphicAssetOf(e);
  if (!a || !a.settings || !a.settings.hitbox) return;
  const p = entityParts(e);
  if (!p.sprite) return;
  const t = e.transform || {};
  const sx = t.sx === undefined ? 1 : t.sx;
  const sy = t.sy === undefined ? 1 : t.sy;
  const piv = spritePivot(e);
  const ax = t.ax === undefined ? piv.ax : t.ax;
  const ay = t.ay === undefined ? piv.ay : t.ay;
  const r = p.sprite.region;
  const hb = a.settings.hitbox;
  const x0 = (t.x || 0) - r.w * sx * ax;
  const y0 = (t.y || 0) - r.h * sy * ay;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,90,200,.95)';
  ctx.lineWidth = 1 / S.view.zoom;
  ctx.setLineDash([3 / S.view.zoom, 2 / S.view.zoom]);
  ctx.strokeRect(x0 + hb[0] * sx, y0 + hb[1] * sy, hb[2] * sx, hb[3] * sy);
  ctx.restore();
}

function entityBounds(e) {
  const hud = hudBox(e);
  if (hud) return hud;
  const t = e.transform || {};
  const p = entityParts(e);
  if (p.sprite) {
    const s = entitySize(e);
    const piv = spritePivot(e);
    const ax = t.ax === undefined ? piv.ax : t.ax;
    const ay = t.ay === undefined ? piv.ay : t.ay;
    return { x: (t.x || 0) - s.w * ax, y: (t.y || 0) - s.h * ay, w: s.w, h: s.h };
  }
  if (p.text) {
    const s = entitySize(e);
    const px = tsPx(p.text.ts, p.text.px);
    const x = p.text.align === 'center' ? (t.x || 0) - s.w / 2 : (p.text.align === 'right' ? (t.x || 0) - s.w : (t.x || 0));
    const y = p.text.valign === 'middle' ? (t.y || 0) - s.h / 2 : (p.text.valign === 'bottom' ? (t.y || 0) - s.h : (t.y || 0));
    return { x, y, w: s.w, h: s.h };
  }
  if (p.shape) {
    if (p.shape.shape === 'circle') {
      const r = p.shape.r || (p.shape.w || 0) / 2;
      return { x: (t.x || 0) - r, y: (t.y || 0) - r, w: r * 2, h: r * 2 };
    }
    if (p.shape.shape === 'line') {
      return { x: (t.x || 0), y: (t.y || 0), w: p.shape.x2 || 0, h: p.shape.y2 || 0 };
    }
    return { x: (t.x || 0) - (p.shape.w || 0) / 2, y: (t.y || 0) - (p.shape.h || 0) / 2,
             w: p.shape.w || 0, h: p.shape.h || 0 };
  }
  return { x: (t.x || 0) - 10, y: (t.y || 0) - 10, w: 20, h: 20 };
}

function entityBounds(e) {
  const t = e.transform || {};
  const wdg = widgetOf(e);
  if (wdg) {
    const s = widgetSize(e, wdg);
    return { x: t.x || 0, y: t.y || 0, w: s.w, h: s.h };
  }
  const p = entityParts(e);
  if (p.sprite) {
    const r = p.sprite.region;
    return { x: (t.x || 0) - r.w * (t.sx === undefined ? 1 : t.sx) * (t.ax === undefined ? 0.5 : t.ax),
             y: (t.y || 0) - r.h * (t.sy === undefined ? 1 : t.sy) * (t.ay === undefined ? 0.5 : t.ay),
             w: r.w * (t.sx === undefined ? 1 : t.sx), h: r.h * (t.sy === undefined ? 1 : t.sy) };
  }
  if (p.text) {
    const px = tsPx(p.text.ts, p.text.px);
    const cv = $('#view');
    const ctx = cv.getContext('2d');
    ctx.save();
    ctx.font = px + 'px ui-monospace, monospace';
    const w = ctx.measureText(String(p.text.text || '')).width;
    ctx.restore();
    const x = p.text.align === 'center' ? (t.x || 0) - w / 2 : (p.text.align === 'right' ? (t.x || 0) - w : (t.x || 0));
    const y = p.text.valign === 'middle' ? (t.y || 0) - px / 2 : (p.text.valign === 'bottom' ? (t.y || 0) - px : (t.y || 0));
    return { x, y, w, h: px + 2 };
  }
  if (p.shape) {
    if (p.shape.shape === 'circle') {
      const r = p.shape.r || (p.shape.w || 0) / 2;
      return { x: (t.x || 0) - r, y: (t.y || 0) - r, w: r * 2, h: r * 2 };
    }
    if (p.shape.shape === 'line') {
      return { x: (t.x || 0), y: (t.y || 0), w: p.shape.x2 || 0, h: p.shape.y2 || 0 };
    }
    return { x: (t.x || 0) - (p.shape.w || 0) / 2, y: (t.y || 0) - (p.shape.h || 0) / 2,
             w: p.shape.w || 0, h: p.shape.h || 0 };
  }
  return { x: (t.x || 0) - 10, y: (t.y || 0) - 10, w: 20, h: 20 };
}

// ---- modo programa: preview dos widgets do Kui no viewport ----
// O editor nao roda o Kui; desenha uma aproximacao fiel o bastante para
// posicionar/medir. A verdade e o build + run/Play.
const UI_ROLE_PX = { caption: 10, body: 13, title: 17, display: 24 };
const UI_TH = { bg: '#080c18', card: '#121a2c', stroke: '#2c3850', text: '#f0f4f8',
                dim: '#8894a8', accent: '#38bcf8', onAccent: '#081020', err: '#f04848' };

function widgetOf(e) {
  for (const c of e.components || []) {
    if (String(c.type).indexOf('ui.') === 0 || c.type === 'mic.record') {
      return { kind: c.type === 'mic.record' ? 'mic.record' : c.type.slice(3), f: c.fields || {}, comp: c };
    }
  }
  for (const c of e.components || []) {
    if (String(c.type).indexOf('ai.') === 0) return { kind: c.type, f: c.fields || {}, comp: c, ai: true };
  }
  return null;
}

function widgetSize(e, w) {
  const f = w.f || {};
  const n = (v, d) => (typeof v === 'number' ? v : d);
  const measure = (s, px) => {
    const cv = $('#view').getContext('2d');
    cv.save(); cv.font = px + 'px ui-monospace, monospace';
    const tw = cv.measureText(String(s)).width; cv.restore();
    return Math.ceil(tw);
  };
  switch (w.kind) {
    case 'text': {
      const px = UI_ROLE_PX[f.role] || 13;
      const s = f.bind ? '[' + f.bind + ']' : (f.text || '');
      const tw = n(f.w, 0) || measure(s, px) + 2;
      const lines = n(f.lines, 0);
      return { w: tw, h: lines > 1 ? Math.round(px * 1.4 * lines) : px + 4, px };
    }
    case 'button': return { w: n(f.w, 200), h: n(f.h, 32) };
    case 'toggle': return { w: 44, h: 24 };
    case 'slider': return { w: n(f.w, 200), h: 28 };
    case 'progress': return { w: n(f.w, 200), h: n(f.h, 8) };
    case 'list': return { w: n(f.w, 224), h: n(f.h, 160) };
    case 'tabs': return { w: n(f.w, 224), h: n(f.h, 30) };
    case 'card': return { w: n(f.w, 224), h: n(f.h, 80) };
    case 'image': return { w: n(f.w, 32), h: n(f.h, 32) };
    case 'badge': return { w: measure(f.badgeText || f.text || '', 10) + 10, h: 16 };
    case 'spinner': return { w: n(f.r, 8) * 2, h: n(f.r, 8) * 2 };
    case 'field': return { w: 220, h: 44 };
    case 'mic.record': return { w: n(f.w, 120), h: n(f.h, 44) };
    default: return { w: 14, h: 14 };   // ai.*: alvo pequeno e visivel
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawWidgetBox(ctx, e, w, x, y, selected) {
  const f = w.f || {};
  const s = widgetSize(e, w);
  const k = w.kind;
  ctx.save();
  ctx.font = (s.px || 13) + 'px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  if (k === 'card') {
    roundRect(ctx, x, y, s.w, s.h, f.radius === undefined ? 10 : f.radius);
    ctx.fillStyle = f.color || UI_TH.card;
    ctx.fill();
    ctx.strokeStyle = f.stroke || UI_TH.stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (k === 'text') {
    ctx.fillStyle = f.color || UI_TH.text;
    const txt = f.bind ? '[' + f.bind + ']' : (f.text || '');
    const px = s.px || 13;
    const align = f.align || 'left';
    if (align === 'center') ctx.textAlign = 'center';
    else if (align === 'right') ctx.textAlign = 'right';
    const tx = align === 'center' ? x + s.w / 2 : (align === 'right' ? x + s.w : x);
    const maxW = f.w || 0;
    if (maxW && f.lines) {
      // quebra grosseira: uma linha por \n ou por corte de largura
      const words = String(txt).split(/\s+/);
      let line = '', ly = y, count = 0;
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > maxW && line) {
          ctx.fillText(line, tx, ly); line = word; ly += px * 1.4; count++;
          if (count >= f.lines) break;
        } else line = test;
      }
      if (count < f.lines && line) ctx.fillText(line, tx, ly);
    } else {
      ctx.fillText(String(txt).split('\n')[0], tx, y + 2);
    }
  } else if (k === 'button') {
    roundRect(ctx, x, y, s.w, s.h, 8);
    if (f.style === 'ghost') {
      ctx.strokeStyle = UI_TH.stroke; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = UI_TH.text;
    } else {
      ctx.fillStyle = f.style === 'danger' ? UI_TH.err : UI_TH.accent; ctx.fill();
      ctx.fillStyle = UI_TH.onAccent;
    }
    ctx.textAlign = 'center';
    ctx.fillText(String(f.label || 'OK'), x + s.w / 2, y + (s.h - 13) / 2);
  } else if (k === 'toggle') {
    roundRect(ctx, x, y, 44, 24, 12);
    ctx.fillStyle = UI_TH.stroke; ctx.fill();
    ctx.beginPath(); ctx.arc(x + 12, y + 12, 9, 0, Math.PI * 2);
    ctx.fillStyle = UI_TH.text; ctx.fill();
  } else if (k === 'slider') {
    ctx.fillStyle = UI_TH.card;
    ctx.fillRect(x, y + 11, s.w, 6);
    const min = f.min === undefined ? 0 : f.min, max = f.max === undefined ? 100 : f.max;
    const pct = max > min ? 0.5 : 0;
    ctx.fillStyle = UI_TH.accent;
    ctx.fillRect(x, y + 11, s.w * pct, 6);
    ctx.beginPath(); ctx.arc(x + s.w * pct, y + 14, 8, 0, Math.PI * 2);
    ctx.fillStyle = UI_TH.text; ctx.fill();
  } else if (k === 'progress') {
    ctx.fillStyle = UI_TH.card; ctx.fillRect(x, y, s.w, s.h);
    const v = f.key ? 0.5 : Math.max(0, Math.min(100, f.value || 0)) / 100;
    ctx.fillStyle = UI_TH.accent; ctx.fillRect(x, y, s.w * v, s.h);
  } else if (k === 'list') {
    roundRect(ctx, x, y, s.w, s.h, 6);
    ctx.fillStyle = UI_TH.card; ctx.fill();
    ctx.strokeStyle = UI_TH.stroke; ctx.lineWidth = 1; ctx.stroke();
    const rowH = f.rowH || 40;
    const items = f.itemsBind ? ['[' + f.itemsBind + ']'] : (Array.isArray(f.items) ? f.items : []);
    let ry = y + 4;
    for (const it of items) {
      if (ry + rowH > y + s.h) break;
      const label = typeof it === 'string' ? it : (it && (it.label || '')) || '';
      const sub = it && typeof it === 'object' && it.sub ? it.sub : '';
      ctx.fillStyle = UI_TH.text;
      ctx.fillText(String(label).slice(0, 26), x + 8, ry + 6);
      if (sub) { ctx.fillStyle = UI_TH.dim; ctx.fillText(String(sub).slice(0, 26), x + 8, ry + 20); }
      ry += rowH;
      ctx.strokeStyle = 'rgba(120,150,200,.12)';
      ctx.beginPath(); ctx.moveTo(x + 6, ry - 2); ctx.lineTo(x + s.w - 6, ry - 2); ctx.stroke();
    }
  } else if (k === 'tabs') {
    const labels = Array.isArray(f.labels) ? f.labels : [];
    const cw = s.w / Math.max(1, labels.length);
    labels.forEach((l, i) => {
      roundRect(ctx, x + i * cw + 1, y, cw - 2, s.h, 6);
      ctx.fillStyle = i === 0 ? UI_TH.accent : UI_TH.card; ctx.fill();
      ctx.fillStyle = i === 0 ? UI_TH.onAccent : UI_TH.dim;
      ctx.textAlign = 'center';
      ctx.fillText(String(l), x + i * cw + cw / 2, y + (s.h - 13) / 2);
      ctx.textAlign = 'left';
    });
  } else if (k === 'image') {
    ctx.fillStyle = 'rgba(122,92,255,.25)';
    ctx.fillRect(x, y, s.w, s.h);
    ctx.strokeStyle = 'rgba(122,92,255,.8)';
    ctx.strokeRect(x, y, s.w, s.h);
    ctx.fillStyle = UI_TH.dim;
    ctx.font = '9px ui-monospace, monospace';
    const a = asset(f.asset);
    ctx.fillText(a ? a.name.slice(0, 10) : 'imagem', x + 2, y + 2);
  } else if (k === 'badge') {
    roundRect(ctx, x, y, s.w, s.h, 8);
    ctx.fillStyle = f.color || UI_TH.accent; ctx.fill();
    ctx.fillStyle = f.textColor || UI_TH.onAccent;
    ctx.fillText(String(f.bind ? '[' + f.bind + ']' : (f.text || '')), x + 5, y + 2);
  } else if (k === 'spinner') {
    ctx.beginPath(); ctx.arc(x + s.w / 2, y + s.h / 2, s.w / 2 - 1, 0, Math.PI * 1.5);
    ctx.strokeStyle = f.color || UI_TH.accent; ctx.lineWidth = 2; ctx.stroke();
  } else if (k === 'field') {
    ctx.fillStyle = UI_TH.dim;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(String(f.label || f.key || 'campo'), x, y);
    ctx.fillStyle = UI_TH.text;
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText('[' + (f.key || 'texto') + ']', x, y + 16);
    ctx.strokeStyle = UI_TH.stroke;
    ctx.beginPath(); ctx.moveTo(x, y + 38); ctx.lineTo(x + 220, y + 38); ctx.stroke();
  } else if (k === 'mic.record') {
    roundRect(ctx, x, y, s.w, s.h, s.h / 2);
    ctx.fillStyle = UI_TH.accent; ctx.fill();
    ctx.fillStyle = UI_TH.onAccent;
    ctx.textAlign = 'center';
    ctx.fillText(String(f.label || 'falar').slice(0, 16), x + s.w / 2, y + (s.h - 13) / 2);
    ctx.textAlign = 'left';
  } else {
    // ai.*: marcador com a chave de disparo
    roundRect(ctx, x, y, 14, 14, 3);
    ctx.fillStyle = '#c07aff'; ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.font = '8px ui-monospace, monospace';
    ctx.fillText('IA', x + 2, y + 3);
  }
  if (selected) {
    ctx.strokeStyle = '#38bcf8';
    ctx.lineWidth = 1.5 / S.view.zoom;
    ctx.setLineDash([4 / S.view.zoom, 3 / S.view.zoom]);
    ctx.strokeRect(x - 1, y - 1, s.w + 2, s.h + 2);
  }
  ctx.restore();
}

function drawEntity(ctx, e, selected, dragPreview) {
  const t = e.transform || {};
  const hud = hudBox(e);
  if (hud) {
    drawHudEntity(ctx, e, hud);
    if (selected) {
      ctx.save();
      ctx.strokeStyle = '#38bcf8';
      ctx.lineWidth = 1.5 / S.view.zoom;
      ctx.setLineDash([4 / S.view.zoom, 3 / S.view.zoom]);
      ctx.strokeRect(hud.x, hud.y, hud.w, hud.h);
      ctx.restore();
    }
    return;
  }
  const pv = dragPreview || {};
  const wdg = widgetOf(e);
  if (wdg) {
    drawWidgetBox(ctx, e, wdg, pv.x !== undefined ? pv.x : (t.x || 0),
                  pv.y !== undefined ? pv.y : (t.y || 0), selected);
    return;
  }
  const x = pv.x !== undefined ? pv.x : (t.x || 0);
  const y = pv.y !== undefined ? pv.y : (t.y || 0);
  const rot = (pv.rot !== undefined ? pv.rot : (t.rot || 0)) * Math.PI / 180;
  const sx = pv.sx !== undefined ? pv.sx : (t.sx === undefined ? 1 : t.sx);
  const sy = pv.sy !== undefined ? pv.sy : (t.sy === undefined ? 1 : t.sy);
  const piv = spritePivot(e);
  const ax = t.ax === undefined ? piv.ax : t.ax;
  const ay = t.ay === undefined ? piv.ay : t.ay;
  const p = entityParts(e);

  if (p.sprite) {
    const img = imageFor(p.sprite.asset);
    const r = p.sprite.region;
    if (img && img.complete && img.naturalWidth) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.scale(sx, sy);
      ctx.drawImage(img, r.x, r.y, r.w, r.h, -r.w * ax, -r.h * ay, r.w, r.h);
      ctx.restore();
    } else {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      ctx.fillStyle = '#7a5cff'; ctx.globalAlpha = .35;
      ctx.fillRect(-r.w * ax, -r.h * ay, r.w, r.h); ctx.restore();
      ctx.globalAlpha = 1;
    }
  }
  if (p.text) {
    const px = tsPx(p.text.ts, p.text.px);
    ctx.save();
    ctx.font = px + 'px ui-monospace, monospace';
    ctx.fillStyle = p.text.color || '#ffffff';
    ctx.textAlign = p.text.align === 'center' ? 'center' : (p.text.align === 'right' ? 'right' : 'left');
    ctx.textBaseline = p.text.valign === 'middle' ? 'middle' : (p.text.valign === 'bottom' ? 'bottom' : 'top');
    if (p.text.shadow) { ctx.fillStyle = p.text.shadow; ctx.fillText(String(p.text.text || ''), x + 1, y + 1); ctx.fillStyle = p.text.color || '#ffffff'; }
    ctx.fillText(String(p.text.text || ''), x, y);
    ctx.restore();
  }
  if (p.shape) {
    ctx.save();
    ctx.fillStyle = p.shape.color || '#38bcf8';
    ctx.strokeStyle = p.shape.color || '#38bcf8';
    if (p.shape.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(x, y, p.shape.r || (p.shape.w || 0) / 2, 0, Math.PI * 2);
      if (p.shape.fill === false) ctx.stroke(); else ctx.fill();
    } else if (p.shape.shape === 'line') {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (p.shape.x2 || 0), y + (p.shape.y2 || 0));
      ctx.lineWidth = p.shape.w || 1; ctx.stroke();
    } else {
      const w = p.shape.w || 0, h = p.shape.h || 0;
      if (p.shape.fill === false) ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      else ctx.fillRect(x - w / 2, y - h / 2, w, h);
    }
    ctx.restore();
  }
  if (p.col) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,120,120,.85)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    if (p.col.shape === 'circle') {
      ctx.beginPath(); ctx.arc(x, y, p.col.r || (p.col.w || 0) / 2, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.strokeRect(x - (p.col.w || 0) / 2, y - (p.col.h || 0) / 2, p.col.w || 0, p.col.h || 0);
    }
    ctx.restore();
  }
  if (selected) {
    drawHitbox(ctx, e);
    const b = entityBounds(e);
    if (dragPreview) { b.x += dragPreview.x - (t.x || 0); b.y += dragPreview.y - (t.y || 0); }
    ctx.save();
    ctx.strokeStyle = '#38bcf8';
    ctx.lineWidth = 1.5 / S.view.zoom;
    ctx.setLineDash([4 / S.view.zoom, 3 / S.view.zoom]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
}

function selectedLiveEntity() {
  const sc = currentScene();
  if (!sc || S.sel.kind !== 'entity') return null;
  return sceneEntity(sc, S.sel.id);
}

function gizmoPivot(e) {
  const t = e.transform || {};
  return { x: t.x || 0, y: t.y || 0 };
}

function gizmoLen() { return 46 / Math.max(0.2, S.view.zoom); }
function gizmoR() { return 7 / Math.max(0.2, S.view.zoom); }

function setGizmo(mode) {
  if (['move', 'rotate', 'scale'].indexOf(mode) < 0) return;
  S.gizmo = mode;
  for (const b of $$('#gizmoBar [data-gizmo]')) b.classList.toggle('active', b.dataset.gizmo === mode);
  draw();
}

function drawGizmo(ctx, e) {
  const t = e.transform || {};
  const p = gizmoPivot(e);
  const L = gizmoLen(), r = gizmoR();
  ctx.save();
  ctx.lineWidth = 2 / Math.max(0.2, S.view.zoom);
  ctx.font = (10 / Math.max(0.2, S.view.zoom)) + 'px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  if (S.gizmo === 'move') {
    ctx.strokeStyle = '#ff6b6b';
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + L, p.y); ctx.stroke();
    ctx.fillStyle = '#ff6b6b'; ctx.fillRect(p.x + L - r, p.y - r, r * 2, r * 2);
    ctx.fillStyle = '#ff6b6b'; ctx.fillText('X', p.x + L + r * 1.5, p.y);
    ctx.strokeStyle = '#6ee7a8';
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y + L); ctx.stroke();
    ctx.fillStyle = '#6ee7a8'; ctx.fillRect(p.x - r, p.y + L - r, r * 2, r * 2);
    ctx.fillText('Y', p.x, p.y + L + r * 1.6);
  } else if (S.gizmo === 'rotate') {
    const R = 38 / Math.max(0.2, S.view.zoom);
    const a = (t.rot || 0) * Math.PI / 180;
    ctx.strokeStyle = '#ffd479';
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(a) * R, p.y + Math.sin(a) * R); ctx.stroke();
    ctx.fillStyle = '#ffd479';
    ctx.beginPath(); ctx.arc(p.x + Math.cos(a) * R, p.y + Math.sin(a) * R, r, 0, Math.PI * 2); ctx.fill();
  } else {
    const b = entityBounds(e);
    const R = r;
    ctx.strokeStyle = 'rgba(255,212,121,.65)';
    ctx.setLineDash([4 / Math.max(0.2, S.view.zoom), 3 / Math.max(0.2, S.view.zoom)]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd479';
    for (const q of [[b.x + b.w, b.y + b.h], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h]]) {
      ctx.fillRect(q[0] - R, q[1] - R, R * 2, R * 2);
    }
  }
  ctx.fillStyle = '#38bcf8';
  ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function gizmoAt(w, e) {
  const p = gizmoPivot(e);
  const L = gizmoLen(), r = gizmoR() * 1.5;
  if (S.gizmo === 'move') {
    if (Math.abs(w.y - p.y) <= r && w.x >= p.x && w.x <= p.x + L + r) return 'x';
    if (Math.abs(w.x - p.x) <= r && w.y >= p.y && w.y <= p.y + L + r) return 'y';
  } else if (S.gizmo === 'rotate') {
    const R = 38 / Math.max(0.2, S.view.zoom);
    const d = Math.sqrt((w.x - p.x) * (w.x - p.x) + (w.y - p.y) * (w.y - p.y));
    if (Math.abs(d - R) <= r) return 'rot';
  } else {
    const b = entityBounds(e);
    const pts = {
      sxy: [b.x + b.w, b.y + b.h],
      sx: [b.x + b.w, b.y + b.h / 2],
      sy: [b.x + b.w / 2, b.y + b.h],
    };
    for (const k in pts) {
      if (Math.abs(w.x - pts[k][0]) <= r && Math.abs(w.y - pts[k][1]) <= r) return k;
    }
  }
  return null;
}

function beginGizmo(ev, e, axis) {
  const t = e.transform || {};
  const p = gizmoPivot(e);
  S.drag = {
    kind: 'gizmo', axis, fid: e.fid, startW: screenToWorld(ev),
    startX: t.x || 0, startY: t.y || 0, startRot: t.rot || 0,
    startSX: t.sx === undefined ? 1 : t.sx, startSY: t.sy === undefined ? 1 : t.sy,
    pivot: p, preview: null,
  };
  $('#view').setPointerCapture(ev.pointerId);
}

function snapVal(v) {
  if (!$('#chkSnap').checked) return Math.round(v * 100) / 100;
  const step = (S.snap.describe.project.editor && S.snap.describe.project.editor.grid) || 8;
  return Math.round(v / step) * step;
}

function updateGizmoDrag(ev) {
  const d = S.drag; if (!d || d.kind !== 'gizmo') return;
  const w = screenToWorld(ev);
  const dx = w.x - d.startW.x, dy = w.y - d.startW.y;
  if (S.gizmo === 'move') {
    const pv = { x: d.startX, y: d.startY };
    if (d.axis === 'x') pv.x = snapVal(d.startX + dx);
    else if (d.axis === 'y') pv.y = snapVal(d.startY + dy);
    else { pv.x = snapVal(d.startX + dx); pv.y = snapVal(d.startY + dy); }
    d.preview = pv;
  } else if (S.gizmo === 'rotate') {
    const a0 = Math.atan2(d.startW.y - d.pivot.y, d.startW.x - d.pivot.x);
    const a1 = Math.atan2(w.y - d.pivot.y, w.x - d.pivot.x);
    let deg = d.startRot + (a1 - a0) * 180 / Math.PI;
    if ($('#chkSnap').checked) deg = Math.round(deg / 15) * 15;
    d.preview = { rot: Math.round(deg * 10) / 10 };
  } else {
    const f = (a, b) => Math.abs(b) < 0.0001 ? 1 : a / b;
    if (d.axis === 'sxy') {
      const d0 = Math.sqrt((d.startW.x - d.pivot.x) ** 2 + (d.startW.y - d.pivot.y) ** 2) || 1;
      const d1 = Math.sqrt((w.x - d.pivot.x) ** 2 + (w.y - d.pivot.y) ** 2);
      const k = Math.max(0.05, d1 / d0);
      d.preview = { sx: Math.round(d.startSX * k * 100) / 100,
                    sy: Math.round(d.startSY * k * 100) / 100 };
    } else if (d.axis === 'sx') {
      const k = Math.max(0.05, f(w.x - d.pivot.x, d.startW.x - d.pivot.x));
      d.preview = { sx: Math.round(d.startSX * k * 100) / 100 };
    } else {
      const k = Math.max(0.05, f(w.y - d.pivot.y, d.startW.y - d.pivot.y));
      d.preview = { sy: Math.round(d.startSY * k * 100) / 100 };
    }
  }
  draw();
}

function commitGizmo() {
  const d = S.drag;
  S.drag = null;
  if (!d || d.kind !== 'gizmo' || !d.preview) return;
  const sc = currentScene();
  const e = sc && sceneEntity(sc, d.fid);
  if (!e) return;
  const tr = {};
  for (const k of ['x', 'y', 'rot', 'sx', 'sy']) if (d.preview[k] !== undefined) tr[k] = d.preview[k];
  entitySet(sc, e, { transform: tr });
}

function draw() {
  const cv = $('#view');
  const wrap = $('#sceneWrap');
  if (!cv || !S.snap) return;
  const dpr = window.devicePixelRatio || 1;
  S.dpr = dpr;
  const cw = Math.max(1, wrap.clientWidth), ch = Math.max(1, wrap.clientHeight);
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    if (!S.view.fitted) fitView(false);
  }
  const ctx = cv.getContext('2d');
  const sc = currentScene();
  const m = sceneMetrics();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#080b11';
  ctx.fillRect(0, 0, cw, ch);
  if (!sc) return;

  ctx.save();
  ctx.translate(S.view.panX, S.view.panY);
  ctx.scale(S.view.zoom, S.view.zoom);

  const st = sc.settings || {};
  ctx.fillStyle = st.bg || '#000000';
  ctx.fillRect(0, 0, m.w, m.h);

  const inset = (S.snap.describe.project.canvas || {}).inset || 0;
  if (inset > 0) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,212,121,.55)';
    ctx.setLineDash([5 / S.view.zoom, 4 / S.view.zoom]);
    ctx.lineWidth = 1 / S.view.zoom;
    ctx.strokeRect(inset, inset, m.w - inset * 2, m.h - inset * 2);
    ctx.restore();
  }

  if ($('#chkGrid').checked) {
    const step = (S.snap.describe.project.editor && S.snap.describe.project.editor.grid) || 8;
    ctx.strokeStyle = 'rgba(120,150,200,.14)';
    ctx.lineWidth = 1 / S.view.zoom;
    ctx.beginPath();
    for (let x = 0; x <= m.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, m.h); }
    for (let y = 0; y <= m.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(m.w, y); }
    ctx.stroke();
  }

  // faixa do cabecalho (UI.header) no modo programa: mostra a area segura
  if (isAppMode() && st.header !== false) {
    ctx.save();
    ctx.fillStyle = 'rgba(18,26,44,.92)';
    ctx.fillRect(0, 0, m.w, 40);
    ctx.strokeStyle = 'rgba(44,56,80,.95)';
    ctx.lineWidth = 1 / S.view.zoom;
    ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(m.w, 40); ctx.stroke();
    ctx.fillStyle = '#38bcf8';
    ctx.fillRect(8, 14, 3, 12);
    ctx.fillStyle = '#f0f4f8';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(String(sc.name || ''), 18, 16);
    if (st.sub) {
      ctx.fillStyle = '#8894a8';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(st.sub), m.w - 8, 19);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  for (const tm of (sc.tilemaps || []).slice().sort((a, b) => (a.layer || 0) - (b.layer || 0))) {
    const a = asset(tm.tileset);
    if (!a) continue;
    const img = imageFor(a);
    if (!img.complete || !img.naturalWidth) continue;
    const regs = a.regionsList || [];
    for (let r = 0; r < tm.rows; r++) {
      for (let c = 0; c < tm.cols; c++) {
        const v = tm.data[r * tm.cols + c];
        if (v === undefined || v === null || v < 0) continue;
        const reg = regs[v] || regs[0];
        if (!reg) continue;
        ctx.drawImage(img, reg.x, reg.y, reg.w, reg.h,
          (tm.ox || 0) + c * tm.cell, (tm.oy || 0) + r * tm.cell, tm.cell, tm.cell);
      }
    }
  }

  const ents = expandEntities(sc);
  for (const e of ents) {
    if (e.active === false) continue;
    const selected = S.sel.kind === 'entity' && S.sel.id === e._owner;
    const preview = (S.drag && S.drag.preview && S.sel.kind === 'entity' && S.sel.id === e._owner)
      ? S.drag.preview : null;
    drawEntity(ctx, e, selected, preview);
  }

  const selE = selectedLiveEntity();
  if (selE && !hudBox(selE)) drawGizmo(ctx, selE);

  const cam = st.camera || {};
  if (cam.bounds) {
    ctx.save();
    ctx.strokeStyle = 'rgba(56,188,248,.75)';
    ctx.setLineDash([5 / S.view.zoom, 4 / S.view.zoom]);
    ctx.lineWidth = 1 / S.view.zoom;
    ctx.strokeRect(cam.bounds[0], cam.bounds[1], cam.bounds[2], cam.bounds[3]);
    ctx.restore();
  }

  if (S.tile.active && S.tile.hover) {
    const tm = tileByCurrent();
    if (tm) {
      ctx.save();
      ctx.strokeStyle = 'rgba(56,188,248,.95)';
      ctx.lineWidth = 1.5 / S.view.zoom;
      ctx.strokeRect((tm.ox || 0) + S.tile.hover.c * tm.cell,
                     (tm.oy || 0) + S.tile.hover.r * tm.cell, tm.cell, tm.cell);
      ctx.restore();
    }
  }

  ctx.strokeStyle = 'rgba(120,150,200,.35)';
  ctx.lineWidth = 1 / S.view.zoom;
  ctx.strokeRect(0, 0, m.w, m.h);
  ctx.restore();

  cv.style.cursor = S.tile.active ? 'crosshair' : '';
  $('#viewHint').textContent = S.view.zoom.toFixed(2) + 'x  ·  ' +
    (S.sel.kind === 'entity' ? 'entidade ' + S.sel.id : (S.sel.kind === 'asset' ? 'asset ' + (assetByGuid(S.sel.id) || {}).name : 'cena')) +
    (S.tile.active ? '  ·  PINTANDO ' + (S.tile.value < 0 ? '(borracha)' : S.tile.value) : '');
}

function fitView(redraw) {
  const wrap = $('#sceneWrap');
  if (!wrap || !wrap.clientWidth) return;
  const m = sceneMetrics();
  const z = Math.min((wrap.clientWidth - 40) / m.w, (wrap.clientHeight - 40) / m.h);
  S.view.zoom = Math.max(0.4, Math.min(6, z));
  S.view.panX = (wrap.clientWidth - m.w * S.view.zoom) / 2;
  S.view.panY = (wrap.clientHeight - m.h * S.view.zoom) / 2;
  S.view.fitted = true;
  $('#zoomLabel').textContent = S.view.zoom.toFixed(2) + 'x';
  if (redraw !== false) draw();
}

function screenToWorld(ev) {
  const cv = $('#view');
  const r = cv.getBoundingClientRect();
  return { x: (ev.clientX - r.left - S.view.panX) / S.view.zoom,
           y: (ev.clientY - r.top - S.view.panY) / S.view.zoom };
}

function hitTest(w) {
  const sc = currentScene();
  if (!sc) return null;
  const ents = expandEntities(sc);
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    if (e.active === false) continue;
    const b = entityBounds(e);
    if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return e._owner;
  }
  return null;
}

// ---------------------------------------------------------------- ops ------

async function ops(list, opts) {
  opts = opts || {};
  try {
    const r = await api('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: list }),
    });
    const n = (r.changed || []).length;
    log('ops: ' + list.length + ' comando(s), ' + n + ' arquivo(s)' + (r.dryRun ? ' [dry-run]' : ''), 'ok');
    for (const w of r.warnings || []) log('aviso[' + w.code + '] ' + w.message, 'warn');
    if (r.snapshot) setSnapshot(r.snapshot, { keepInspector: !!opts.keepInspector });
    return r;
  } catch (e) {
    logError(e);
    throw e;
  }
}

function entitySet(sc, e, patch) {
  ops([{ op: 'entity.set', scene: sc.guid, entity: e.fid, ...patch }], { keepInspector: true });
}
function compSet(sc, e, c, name, value) {
  ops([{ op: 'component.set', scene: sc.guid, entity: e.fid, component: c.id, field: name, value }],
      { keepInspector: true });
}

// --------------------------------------------------------------- build -----

function renderBuild() {
  const box = $('#buildInfo');
  const budget = $('#buildBudget');
  const b = S.snap ? S.snap.build : null;
  if (budget) budget.innerHTML = '';
  if (!b) { box.textContent = 'sem build. Clique em Build.'; return; }
  const lines = [];
  lines.push('pacote: ' + b.app + ' ' + b.version + (b.runtime === 'legacy' ? '  (runtime legado: ' + b.entry + ')' : ''));
  lines.push('pasta:  ' + b.dir);
  lines.push('extras: ' + b.extras + '/16   JS: ' + (b.jsBytes / 1024).toFixed(1) + 'KB   assets: ' +
             (b.assetBytes / 1024).toFixed(1) + 'KB');
  lines.push('');
  lines.push('arquivos:');
  for (const f of b.files || []) lines.push('  ' + f);
  if ((b.warnings || []).length) {
    lines.push('');
    lines.push('avisos:');
    for (const w of b.warnings) lines.push('  [' + w.code + '] ' + w.message);
  }
  box.textContent = lines.join('\n');

  const dz = S.snap.deploy;
  const di = $('#deployInfo');
  const dl = $('#deployLink');
  if (di) di.textContent = dz
    ? ('app.zip ' + (dz.bytes / 1024).toFixed(1) + 'KB · JS ' +
       (dz.js.before / 1024).toFixed(1) + ' -> ' + (dz.js.after / 1024).toFixed(1) + 'KB · sha ' +
       dz.sha256.slice(0, 12))
    : 'ainda sem deploy; clique em Compilar app.zip';
  if (dl) {
    dl.hidden = !dz;
    if (dz) dl.href = '/api/deploy.zip?t=' + Date.now();
  }

  if (budget) {
    const lim = S.snap.describe.limits || {};
    const row = (label, used, max, unit) => {
      const pct = max ? Math.max(0, Math.min(100, used / max * 100)) : 0;
      const cls = pct > 100 ? 'err' : (pct > 80 ? 'warn' : '');
      const r = el('div', { class: 'budget-row' }, [
        el('span', { text: label }),
        el('div', { class: 'budget-bar' }, [
          el('div', { class: 'budget-fill ' + cls, style: 'width:' + pct + '%' }),
        ]),
        el('span', { text: used.toFixed(used < 10 ? 2 : 1) + '/' + max + ' ' + unit }),
      ]);
      budget.appendChild(r);
    };
    row('extras', b.extras, lim.extras || 16, 'itens');
    row('JS total', b.jsBytes / 1024, lim.jsKB || 1024, 'KB');
    row('assets', b.assetBytes / 1024, lim.assetsKB || 256, 'KB');
    const deps = Object.keys(S.snap.describe.project.deps || {}).length;
    row('deps', deps, lim.deps || 8, 'mods');
  }
}

function renderPlay() {
  const p = S.snap && S.snap.play;
  const running = p && p.running && p.url;
  $('#btnPlay').hidden = !!running;
  $('#btnStop').hidden = !running;
  if (running) {
    const frame = $('#gameFrame');
    // src (propriedade) normaliza a URL com '/' final e nunca bate com
    // p.url: todo snapshot reatribuia e RECARREGAVA o Play em cada op
    if (frame.getAttribute('src') !== p.url) frame.src = p.url;
  }
}

// --------------------------------------------------------------- tabs ------

function setTab(name) {
  S.tab = name;
  for (const b of $$('#tabs [data-tab]')) b.classList.toggle('active', b.dataset.tab === name);
  $('#sceneWrap').hidden = name !== 'scene';
  $('#gameWrap').hidden = name !== 'game';
  $('#buildWrap').hidden = name !== 'build';
  $('#aiWrap').hidden = name !== 'ai';
  if (name === 'ai') aiRender();
  if (name === 'scene') draw();
  // "Jogo" vira "Telas" no runtime app (o Play mostra as telas do programa)
  const gt = $('#tabs [data-tab="game"]');
  if (gt) gt.textContent = isAppMode() ? 'Telas' : 'Jogo';
}

// -------------------------------------------------------------- actions ----

async function doValidate() {
  try {
    const r = await api('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'validate' }),
    });
    log('validacao: ' + r.errors.length + ' erro(s), ' + r.warnings.length + ' aviso(s)',
        r.errors.length ? 'err' : 'ok');
    for (const d of r.errors) log('  [' + d.code + '] ' + (d.path || '') + ': ' + d.message, 'err');
    for (const d of r.warnings) log('  [' + d.code + '] ' + (d.path || '') + ': ' + d.message, 'warn');
    if (r.snapshot) setSnapshot(r.snapshot, { keepInspector: true });
  } catch (e) { logError(e); }
}

async function doBuild() {
  try {
    const r = await api('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'build' }),
    });
    log('build ok: ' + r.build.dir + ' (' + r.build.extras + ' extras, ' +
        (r.build.jsBytes / 1024).toFixed(1) + 'KB JS)', 'ok');
    for (const w of r.build.warnings || []) log('aviso[' + w.code + '] ' + w.message, 'warn');
    if (r.snapshot) setSnapshot(r.snapshot, { keepInspector: true });
    setTab('build');
  } catch (e) { logError(e); }
}

async function doDeploy() {
  try {
    setTab('build');
    const r = await api('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'deploy' }),
    });
    log('deploy: ' + r.zip + ' (' + (r.bytes / 1024).toFixed(1) + 'KB, sha ' +
        r.sha256.slice(0, 12) + ')', 'ok');
    log('  JS ' + (r.js.before / 1024).toFixed(1) + ' -> ' + (r.js.after / 1024).toFixed(1) +
        'KB · assets ' + (r.assets.bytes / 1024).toFixed(1) + 'KB', 'dim');
    for (const w of (r.build && r.build.warnings) || []) log('aviso[' + w.code + '] ' + w.message, 'warn');
    if (r.snapshot) setSnapshot(r.snapshot, { keepInspector: true });
    setTab('build');
  } catch (e) { logError(e); }
}

async function doRun() {
  try {
    setTab('build');
    const r = await api('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'run', ms: 1200 }),
    });
    if (!r.ok) { log('rodada falhou: ' + r.error, 'err'); return; }
    for (const line of r.log || []) log('[app] ' + line);
    S.lastRunUrl = r.url;
    const img = $('#runShot');
    img.src = r.url; img.hidden = false;
    log('tela: ' + r.out + ' (' + r.w + 'x' + r.h + ')', 'ok');
  } catch (e) { logError(e); }
}

async function doPlay() {
  try {
    const r = await api('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'play' }),
    });
    log('play: ' + (r.url || ('porta ' + r.port + ' (subindo)')), 'ok');
    if (r.snapshot) setSnapshot(r.snapshot, { keepInspector: true });
    setTab('game');
    if (r.url) $('#gameFrame').src = r.url;
  } catch (e) { logError(e); }
}

async function doStop() {
  try {
    const r = await api('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'stop' }),
    });
    log('play parado', 'dim');
    if (r.snapshot) setSnapshot(r.snapshot, { keepInspector: true });
  } catch (e) { logError(e); }
}

async function undoRedo(what) {
  try {
    const r = await api('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: what }),
    });
    log(what + ': ' + (r.changed || []).length + ' arquivo(s)', 'ok');
    if (r.snapshot) setSnapshot(r.snapshot, {});
  } catch (e) { logError(e); }
}

async function importFiles(files) {
  for (const f of files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    let importer = '';
    if (ext === 'png') importer = 'sprite';
    else if (ext === 'qoa' || ext === 'wav') importer = 'audio';
    else if (ext === 'js') importer = 'script';
    if (!importer) { log('extensao nao suportada: ' + f.name, 'err'); continue; }
    try {
      const u = '/api/upload?name=' + encodeURIComponent(f.name) + '&importer=' + importer;
      const r = await fetch(u, { method: 'POST', body: f }).then((x) => x.json());
      if (r.ok === false) throw Object.assign(new Error(r.error.message), r.error);
      const a = r.results && r.results[0] && r.results[0].asset;
      log('importado: ' + (a ? a.name : f.name), 'ok');
      if (r.snapshot) setSnapshot(r.snapshot, { keepInspector: true });
      if (a) selectAsset(a.guid);
    } catch (e) { logError(e); }
  }
}

// --------------------------------------------------------------- modal -----

let modalAsset = null;
async function openScript(a) {
  try {
    const r = await fetch('/api/assets?path=' + encodeURIComponent(a.path));
    const txt = await r.text();
    modalAsset = a;
    $('#modalTitle').textContent = 'Script — ' + a.name;
    $('#modalText').value = txt;
    const props = (a.settings && a.settings.props) || {};
    const names = Object.keys(props);
    $('#modalHint').textContent = 'ES5 apenas; o build linta com app_lint. ' +
      (names.length ? 'props: ' + names.join(', ')
                    : 'declare exports.props para campos tipados no inspetor.');
    $('#modal').hidden = false;
  } catch (e) { logError(e); }
}
async function saveScript() {
  if (!modalAsset) return;
  try {
    await ops([{ op: 'script.set', script: modalAsset.guid, content: $('#modalText').value }]);
    $('#modal').hidden = true;
    log('script salvo: ' + modalAsset.name, 'ok');
  } catch (e) { logError(e); }
}

// manda o script aberto para o copiloto (aba IA) — fecha o laco da edicao
function aiFromScript() {
  if (!modalAsset) return;
  $('#modal').hidden = true;
  setTab('ai');
  const prompt = $('#aiPrompt');
  prompt.value = 'Melhore o script "' + modalAsset.name + '" (ES5) mantendo o contrato ' +
    'exports.props/start/update/draw/destroy e sem inventar API. ' +
    'Responda com {"op":"script.set","script":"' + modalAsset.guid + '","content":"..."} ' +
    'contendo o codigo completo.';
  prompt.focus();
  aiRender();
}

// ------------------------------------------------------------ commands -----

async function runCommand(raw) {
  const t = raw.trim();
  if (!t) return;
  if (t[0] === '{' || t[0] === '[') {
    try {
      const v = JSON.parse(t);
      const list = Array.isArray(v) ? v : (Array.isArray(v.ops) ? v.ops : [v]);
      const r = await ops(list);
      // seleciona a primeira entidade criada
      for (const res of r.results || []) {
        if (res && res.entity) { selectEntity(res.entity.fid); break; }
        if (res && res.asset) { selectAsset(res.asset.guid); break; }
      }
      return;
    } catch (e) { logError(e); return; }
  }
  const [cmd, ...rest] = t.split(/\s+/);
  if (cmd === 'build') return doBuild();
  if (cmd === 'validate' || cmd === 'validar') return doValidate();
  if (cmd === 'run' || cmd === 'rodar') return doRun();
  if (cmd === 'play') return doPlay();
  if (cmd === 'stop') return doStop();
  if (cmd === 'undo') return undoRedo('undo');
  if (cmd === 'redo') return undoRedo('redo');
  if (cmd === 'fmt') {
    try {
      const r = await api('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"cmd":"fmt"}' });
      log('canonico: ' + r.changed.length + ' arquivo(s)', 'ok');
      if (r.snapshot) setSnapshot(r.snapshot, { keepInspector: true });
    } catch (e) { logError(e); }
    return;
  }
  if (cmd === 'help' || cmd === 'ajuda') {
    log('JSON de op(s): {"op":"entity.create",...} | build | validate | run | play | stop | undo | redo | fmt', 'dim');
    log('ex.: {"op":"scene.create","name":"Fase 2"}', 'dim');
    return;
  }
  if (cmd === 'open' && rest[0]) {
    const a = (S.snap.describe.assets || []).find((x) => x.name === rest.join(' ') && x.kind === 'scene');
    if (a) { S.sceneGuid = a.guid; S.sel = { kind: 'scene', id: null, comp: null }; renderSceneSel(); renderHierarchy(); renderInspector(); draw(); }
    else log('cena nao encontrada', 'err');
    return;
  }
  log('comando desconhecido: ' + cmd + ' (help)', 'err');
}

function cid() { return 'c_' + Math.random().toString(36).slice(2, 10); }

async function dropAssetAt(ev) {
  ev.preventDefault();
  const sc = currentScene();
  if (!sc || !S.snap) return;
  let data = null;
  try { data = JSON.parse(ev.dataTransfer.getData('text/plain') || 'null'); } catch (e) {}
  const a = data && data.guid ? assetByGuid(data.guid) : assetByGuid(S.dragAsset);
  S.dragAsset = null;
  if (!a) { log('asset solto nao reconhecido', 'err'); return; }
  const w = screenToWorld(ev);
  const x = Math.round(w.x), y = Math.round(w.y);
  try {
    if (a.kind === 'scene') {
      S.sceneGuid = a.guid;
      S.sel = { kind: 'scene', id: null, comp: null };
      renderSceneSel(); renderHierarchy(); renderInspector(); draw();
      return;
    }
    if (a.kind === 'prefab') {
      const r = await ops([{ op: 'prefab.instance', scene: sc.guid, prefab: a.guid, x, y, z: 0 }]);
      const e = r.results && r.results[0] && r.results[0].entity;
      if (e) selectEntity(e.fid);
      return;
    }
    if (['sprite', 'sprite-sheet', 'tileset'].includes(a.kind)) {
      const reg = (a.regionsList || [])[0];
      if (!reg) { log('asset sem regiao', 'err'); return; }
      const ref = a.guid + '#' + reg.name;
      const key = (a.settings && a.settings.key) || '#000000';
      const r = await ops([{ op: 'entity.create', scene: sc.guid, name: a.name, x, y, z: 1,
        components: [{ id: cid(), type: 'sprite', fields: { sprite: ref, key } }] }]);
      const e = r.results && r.results[0] && r.results[0].entity;
      if (e) selectEntity(e.fid);
      return;
    }
    if (a.kind === 'script') {
      if (S.sel.kind === 'entity') {
        const e = sceneEntity(sc, S.sel.id);
        if (e) {
          await ops([{ op: 'component.add', scene: sc.guid, entity: e.fid, id: cid(),
                       type: 'script', fields: { script: a.guid } }]);
          return;
        }
      }
      const r = await ops([{ op: 'entity.create', scene: sc.guid, name: a.name, x, y, z: 0,
        components: [{ id: cid(), type: 'script', fields: { script: a.guid } }] }]);
      const e = r.results && r.results[0] && r.results[0].entity;
      if (e) selectEntity(e.fid);
      return;
    }
    log('arraste sprite/atlas/tileset/prefab/script para a cena', 'dim');
  } catch (e) { logError(e); }
}

// ------------------------------------------------------------ copiloto ----

// Estado da sessao do assistente. A previa vem SEMPRE em dry-run do servidor
// (mesmas ops que serao aplicadas); "Aplicar" manda o MESMO lote pelo
// /api/command — um caminho so, com undo.
const AI = { log: [], pending: null, busy: false, image: null };

function aiRender() {
  const chat = $('#aiChat');
  if (!chat) return;
  chat.innerHTML = '';
  for (const m of AI.log) {
    chat.appendChild(el('div', { class: 'ai-msg ' + (m.role === 'user' ? 'me' : 'bot') }, [
      el('div', { class: 'ai-role', text: m.role === 'user' ? 'voce' : 'assistente' }),
      el('div', { class: 'ai-text', text: m.text }),
    ]));
  }
  if (!AI.log.length) {
    chat.appendChild(el('div', { class: 'hint', text:
      'Descreva o que quer criar/alterar. O assistente propoe um lote de ops, ' +
      'validado em dry-run; nada e escrito ate voce clicar em Aplicar. ' +
      'Precisa de CELER_STUDIO_AI_KEY (ou OPENROUTER_API_KEY) no ambiente do servidor.' }));
  }
  chat.scrollTop = chat.scrollHeight;

  const pend = $('#aiPend');
  pend.innerHTML = '';
  const p = AI.pending;
  if (p) {
    pend.appendChild(el('div', { class: 'ai-pend' }, [
      el('div', { class: 'hint', text: p.ops.length + ' ops propostas (previa validada; ' +
        (p.result && p.result.changed ? p.result.changed.length : 0) + ' arquivo(s))' }),
      el('pre', { class: 'ai-ops', text: p.ops.map((o) => JSON.stringify(o).slice(0, 220)).join('\n') }),
      el('div', { class: 'rowbtns' }, [
        el('button', { class: 'mini primary', text: 'Aplicar', onclick: aiApply }),
        el('button', { class: 'mini', text: 'Descartar', onclick: () => { AI.pending = null; aiRender(); } }),
      ]),
    ]));
  }
  const send = $('#btnAiSend');
  if (send) send.disabled = AI.busy;
  const hint = $('#aiHint');
  if (hint) {
    hint.textContent = AI.busy ? 'pensando...' : (AI.image ? 'imagem anexada' : '');
  }
}

async function aiSend(fixMode) {
  if (AI.busy) return;
  const prompt = fixMode ? '' : String($('#aiPrompt').value || '').trim();
  if (!fixMode && !prompt && !AI.image) return;
  AI.busy = true;
  AI.pending = null;
  AI.log.push({ role: 'user', text: (fixMode ? '(corrigir build)' : prompt) +
    (AI.image ? '  [imagem]' : '') });
  aiRender();
  const body = { cmd: 'ai', mode: fixMode ? 'fix' : 'edit', prompt: prompt };
  if (AI.image) body.images = [AI.image];
  try {
    const r = await api('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify(body) });
    AI.log.push({ role: 'assistant', text: (r.say || '(sem explicacao)') +
      (r.steps > 1 ? '   [' + r.steps + ' tentativas]' : '') });
    AI.pending = r.ops && r.ops.length ? { ops: r.ops, result: r.result } : null;
    if (r.snapshot) setSnapshot(r.snapshot, {});
    if (r.usage) log('ia: ' + (r.usage.total_tokens || '?') + ' tokens', 'dim');
  } catch (e) {
    AI.log.push({ role: 'assistant', text: 'erro: ' + (e.message || e) +
      (e.hint ? '  (' + e.hint + ')' : '') });
    if (e.diagnostics) {
      for (const d of e.diagnostics) log('ia[' + (d.code || '?') + '] ' + (d.message || ''), 'err');
    }
  }
  AI.busy = false;
  aiRender();
}

async function aiApply() {
  if (!AI.pending) return;
  const list = AI.pending.ops;     // NAO chamar de `ops`: sombreia o helper ops()
  AI.pending = null;
  try {
    const r = await ops(list);
    AI.log.push({ role: 'assistant', text: 'aplicado: ' + ((r.changed || []).length) +
      ' arquivo(s)' + (r.rev ? ', rev ' + r.rev : '') });
  } catch (e) {
    AI.log.push({ role: 'assistant', text: 'falhou ao aplicar: ' + (e.message || e) });
  }
  aiRender();
}

// grava ~ms de microfone como WAV PCM16 mono 16k em base64 (o provedor
// aceita input_audio wav; MediaRecorder do browser so da webm/ogg)
function recordWav(ms) {
  return new Promise((resolve, reject) => {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      let total = 0;
      node.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(d.length);
        copy.set(d);
        chunks.push(copy);
        total += d.length;
      };
      src.connect(node);
      node.connect(ctx.destination);
      setTimeout(() => {
        node.disconnect(); src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const rate = ctx.sampleRate;
        ctx.close();
        const all = new Float32Array(total);
        let o = 0;
        for (const c of chunks) { all.set(c, o); o += c.length; }
        const ratio = rate / 16000;
        const n = Math.max(1, Math.floor(all.length / ratio));
        const pcm = new Int16Array(n);
        for (let i = 0; i < n; i++) {
          const v = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)]));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        const buf = new ArrayBuffer(44 + pcm.length * 2);
        const dv = new DataView(buf);
        const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
        wr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wr(8, 'WAVE');
        wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
        dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
        dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        wr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
        for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        resolve(btoa(bin));
      }, ms);
    }).catch(reject);
  });
}

function aiWire() {
  if (!$('#btnAiSend')) return;
  $('#btnAiSend').onclick = () => aiSend(false);
  $('#btnAiFix').onclick = () => aiSend(true);
  $('#btnAiClear').onclick = () => { AI.log = []; AI.pending = null; aiRender(); };
  $('#aiPrompt').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); aiSend(false); }
  });
  $('#btnAiImg').onclick = () => $('#aiFile').click();
  $('#aiFile').addEventListener('change', () => {
    const f = $('#aiFile').files && $('#aiFile').files[0];
    $('#aiFile').value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const s = String(rd.result || '');
      const comma = s.indexOf(',');
      AI.image = { data: s.slice(comma + 1), mime: f.type || 'image/png' };
      aiRender();
    };
    rd.readAsDataURL(f);
  });
  $('#btnAiMic').onclick = () => {
    if (AI.busy) return;
    const btn = $('#btnAiMic');
    btn.textContent = 'gravando...';
    recordWav(4000).then((b64) => {
      btn.textContent = 'voz';
      AI.busy = true;
      AI.log.push({ role: 'user', text: '(audio 4s)' });
      aiRender();
      return api('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'ai', mode: 'edit', audio: [{ data: b64, format: 'wav' }],
          prompt: 'Transcreva o audio e execute o pedido.' }) });
    }).then((r) => {
      if (!r) return;
      AI.log.push({ role: 'assistant', text: (r.say || '(sem explicacao)') });
      AI.pending = r.ops && r.ops.length ? { ops: r.ops, result: r.result } : null;
      if (r.snapshot) setSnapshot(r.snapshot, {});
    }).catch((e) => {
      $('#btnAiMic').textContent = 'voz';
      AI.log.push({ role: 'assistant', text: 'voz falhou: ' + (e.message || e) });
    }).then(() => { AI.busy = false; aiRender(); });
  };
}

// --------------------------------------------------------------- events ----

function wireEvents() {
  $('#sceneSel').addEventListener('change', () => {});
  $('#btnProject').onclick = selectProject;
  $('#btnNewScene').onclick = async () => {
    const name = prompt('nome da nova cena:', 'Nova cena');
    if (!name) return;
    const r = await ops([{ op: 'scene.create', name }]);
    const sc = ((r.snapshot && r.snapshot.describe.scenes) || []).find((x) => x.name === name);
    if (sc) { S.sceneGuid = sc.guid; S.sel = { kind: 'scene', id: null, comp: null }; setSnapshot(r.snapshot, {}); }
  };
  $('#projName').onclick = selectProject;
  $('#hierSearch').addEventListener('input', (ev) => { S.hierFilter = ev.target.value; renderHierarchy(); });
  $('#assetSearch').addEventListener('input', (ev) => { S.assetFilter = ev.target.value; renderAssets(); });
  for (const b of $$('#gizmoBar [data-gizmo]')) b.onclick = () => setGizmo(b.dataset.gizmo);
  $('#btnValidate').onclick = doValidate;
  $('#btnBuild').onclick = doBuild;
  $('#btnDeploy').onclick = doDeploy;
  $('#btnRun').onclick = doRun;
  $('#btnPlay').onclick = doPlay;
  $('#btnStop').onclick = doStop;
  $('#btnUndo').onclick = () => undoRedo('undo');
  $('#btnRedo').onclick = () => undoRedo('redo');
  $('#btnClear').onclick = () => { $('#console').innerHTML = ''; };
  $('#btnFit').onclick = () => fitView(true);
  $('#btnAddEntity').onclick = async () => {
    const sc = currentScene();
    if (!sc) return;
    const m = sceneMetrics();
    // no modo programa o z e a ordem de desenho: a entidade nova entra por
    // cima (no jogo o default 0 continua valendo)
    let z = 0;
    if (isAppMode()) {
      for (const e of sc.entities || []) z = Math.max(z, (e.z || 0) + 1);
    }
    const r = await ops([{ op: 'entity.create', scene: sc.guid, name: 'Entidade',
                           x: Math.round(m.w / 2), y: Math.round(m.h / 2), z: z }]);
    const e = r.results && r.results[0] && r.results[0].entity;
    if (e) selectEntity(e.fid);
  };
  $('#fileInput').addEventListener('change', (ev) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (files.length) importFiles(files);
  });
  const drop = $('#assetPanel');
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('drop'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    drop.classList.remove('drop');
    const files = Array.from((ev.dataTransfer && ev.dataTransfer.files) || []);
    if (files.length) importFiles(files);
  });
  $('#cmd').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const v = ev.target.value;
      ev.target.value = '';
      runCommand(v);
    }
  });
  $('#modalClose').onclick = () => { $('#modal').hidden = true; };
  $('#modalSave').onclick = saveScript;
  if ($('#modalAi')) $('#modalAi').onclick = aiFromScript;
  $('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') $('#modal').hidden = true; });
  $('#chkGrid').addEventListener('change', draw);
  $('#chkSnap').addEventListener('change', () => {});
  for (const b of $$('#tabs [data-tab]')) b.onclick = () => setTab(b.dataset.tab);

  document.addEventListener('keydown', (ev) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (ev.key === ' ' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      S.spaceDown = true;
      ev.preventDefault();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      ev.preventDefault();
      undoRedo(ev.shiftKey ? 'redo' : 'undo');
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || S.sel.kind !== 'entity') return;
      ev.preventDefault();
      const sc = currentScene();
      const e = sc && sceneEntity(sc, S.sel.id);
      if (e) ops([{ op: 'entity.duplicate', scene: sc.guid, entity: e.fid }]).then((r) => {
        const dup = r.results && r.results[0] && r.results[0].entity;
        if (dup) selectEntity(dup.fid);
      });
    }
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      const key = ev.key.toLowerCase();
      if (key === 'w' || key === 'e' || key === 'r') {
        setGizmo(key === 'w' ? 'move' : (key === 'e' ? 'rotate' : 'scale'));
        ev.preventDefault();
      }
      if (key === 'f') { fitView(true); ev.preventDefault(); }
      if (S.sel.kind === 'entity' && /^Arrow(Left|Right|Up|Down)$/.test(ev.key)) {
        const sc = currentScene();
        const ent = sc && sceneEntity(sc, S.sel.id);
        if (ent) {
          const step = ($('#chkSnap').checked
            ? ((S.snap.describe.project.editor && S.snap.describe.project.editor.grid) || 8) : 1) *
            (ev.shiftKey ? 5 : 1);
          const t = ent.transform || {};
          const patch = { x: t.x || 0, y: t.y || 0 };
          if (ev.key === 'ArrowLeft') patch.x -= step;
          if (ev.key === 'ArrowRight') patch.x += step;
          if (ev.key === 'ArrowUp') patch.y -= step;
          if (ev.key === 'ArrowDown') patch.y += step;
          entitySet(sc, ent, { transform: patch });
          ev.preventDefault();
        }
      }
    }
    if (ev.key === 'F5') { ev.preventDefault(); if (S.snap.play && S.snap.play.running) doStop(); else doPlay(); }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') &&
        tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' &&
        S.sel.kind === 'entity') {
      ev.preventDefault();
      const sc = currentScene();
      const e = sc && sceneEntity(sc, S.sel.id);
      if (e && confirm('Excluir "' + e.name + '"?')) {
        ops([{ op: 'entity.delete', scene: sc.guid, entity: e.fid }]).then(() => {
          S.sel = { kind: 'scene', id: null, comp: null };
          renderHierarchy(); renderInspector(); draw();
        });
      }
    }
    if (ev.key === 'Escape') {
      $('#modal').hidden = true;
      S.sel = { kind: 'scene', id: null, comp: null };
      renderHierarchy(); renderInspector(); draw();
    }
  });
  document.addEventListener('keyup', (ev) => {
    if (ev.key === ' ') S.spaceDown = false;
  });

  const cv = $('#view');
  cv.addEventListener('contextmenu', (ev) => ev.preventDefault());
  cv.addEventListener('pointerdown', (ev) => {
    if (!S.snap) return;
    const w = screenToWorld(ev);
    if (ev.button === 1 || S.spaceDown) {
      S.pan = { sx: ev.clientX, sy: ev.clientY, px: S.view.panX, py: S.view.panY };
      cv.setPointerCapture(ev.pointerId);
      return;
    }
    if (S.tile.active && S.tile.tmId && ev.button !== 1) {
      const tm = tileByCurrent();
      if (tm) {
        beginStroke(tm, ev.button === 2 ? -1 : S.tile.value);
        if (paintAt(ev)) { cv.setPointerCapture(ev.pointerId); return; }
        S.tile.painting = false;
      }
    }
    if (ev.button !== 0) return;
    const selE = selectedLiveEntity();
    if (selE && !hudBox(selE)) {
      const g = gizmoAt(w, selE);
      if (g) { beginGizmo(ev, selE, g); return; }
    }
    const fid = hitTest(w);
    if (!fid) {
      S.sel = { kind: 'scene', id: null, comp: null };
      renderHierarchy(); renderInspector(); draw();
      return;
    }
    selectEntity(fid);
    const sc = currentScene();
    const e = sceneEntity(sc, fid);
    if (!e) return;
    if (compOf(e, 'hud')) return;   // HUD e ancorado pelos campos mx/my
    S.drag = {
      fid: fid, startW: w, startX: (e.transform || {}).x || 0, startY: (e.transform || {}).y || 0,
      moved: false, preview: null,
    };
    cv.setPointerCapture(ev.pointerId);
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!S.snap) return;
    if (S.tab === 'scene') {
      const mw = screenToWorld(ev);
      S.mouse = mw;
      const cl = $('#coordLabel');
      if (cl) cl.textContent = Math.round(mw.x) + ', ' + Math.round(mw.y);
    }
    if (S.drag && S.drag.kind === 'gizmo') { updateGizmoDrag(ev); return; }
    if (S.pan) {
      S.view.panX = S.pan.px + (ev.clientX - S.pan.sx);
      S.view.panY = S.pan.py + (ev.clientY - S.pan.sy);
      draw();
      return;
    }
    if (S.tile.active) {
      if (S.tile.painting) { paintAt(ev); return; }
      updateTileHover(ev);
    }
    if (!S.drag) return;
    const w = screenToWorld(ev);
    let x = S.drag.startX + (w.x - S.drag.startW.x);
    let y = S.drag.startY + (w.y - S.drag.startW.y);
    if ($('#chkSnap').checked) {
      const step = (S.snap.describe.project.editor && S.snap.describe.project.editor.grid) || 8;
      x = Math.round(x / step) * step;
      y = Math.round(y / step) * step;
    }
    S.drag.moved = Math.abs(x - S.drag.startX) > 0.01 || Math.abs(y - S.drag.startY) > 0.01;
    S.drag.preview = { x: x, y: y };
    draw();
  });
  cv.addEventListener('pointerup', (ev) => {
    if (S.drag && S.drag.kind === 'gizmo') { commitGizmo(); draw(); return; }
    if (S.tile.painting) { commitPaint(); return; }
    if (S.pan) { S.pan = null; return; }
    if (!S.drag) return;
    const d = S.drag;
    S.drag = null;
    if (d.moved && d.preview) {
      const sc = currentScene();
      const e = sc && sceneEntity(sc, d.fid);
      if (e) entitySet(sc, e, { transform: { x: d.preview.x, y: d.preview.y } });
    }
    draw();
  });
  cv.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const before = screenToWorld(ev);
    const k = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    S.view.zoom = Math.max(0.4, Math.min(8, S.view.zoom * k));
    const cvr = cv.getBoundingClientRect();
    S.view.panX = ev.clientX - cvr.left - before.x * S.view.zoom;
    S.view.panY = ev.clientY - cvr.top - before.y * S.view.zoom;
    $('#zoomLabel').textContent = S.view.zoom.toFixed(2) + 'x';
    draw();
  }, { passive: false });

  cv.addEventListener('dragover', (ev) => {
    if (S.dragAsset || (ev.dataTransfer && ev.dataTransfer.types.indexOf('text/plain') >= 0)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    }
  });
  cv.addEventListener('drop', (ev) => { if (S.tab === 'scene') dropAssetAt(ev); });

  new ResizeObserver(() => draw()).observe($('#sceneWrap'));

  const es = new EventSource('/api/events');
  let t = null;
  es.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'hello') {
      // (re)conexao do EventSource: ressincroniza o snapshot e restaura o
      // status; sem isso o painel fica "reconectando..." e congelado no
      // estado de antes da queda ate o proximo evento do servidor
      loadSnapshot({ keepInspector: true });
    } else if (m.type === 'fs') {
      clearTimeout(t);
      t = setTimeout(() => { log('arquivo mudou: ' + m.path, 'dim'); loadSnapshot({ keepInspector: true }); }, 250);
    } else if (m.type === 'play') {
      if (!m.running) {
        log('play encerrado', 'dim');
        $('#btnPlay').hidden = false; $('#btnStop').hidden = true;
        $('#gameFrame').src = 'about:blank';
      } else {
        log('play: ' + m.url, 'ok');
        $('#btnPlay').hidden = true; $('#btnStop').hidden = false;
        $('#gameFrame').src = m.url;
        setTab('game');
      }
    } else if (m.type === 'playlog') {
      for (const line of m.lines) log('[play] ' + line, 'dim');
    }
  };
  es.onerror = () => { $('#status').textContent = 'reconectando...'; };
}

// ---------------------------------------------------------------- boot -----

(async function boot() {
  wireEvents();
  aiWire();
  $('#zoomLabel').textContent = S.view.zoom.toFixed(2) + 'x';
  await loadSnapshot({});
  log('Celer Studio pronto. Comandos JSON no prompt, ou: build, validate, run, play, undo, redo.', 'dim');
  if (window.innerWidth < 980) log('janela estreita: use >= 1000px para as tres colunas', 'warn');
})();
