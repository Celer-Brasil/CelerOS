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
  if (S.sel.kind !== 'scene' && !selectionExists()) S.sel = { kind: 'scene', id: null, comp: null };
  renderHeader();
  renderSceneSel();
  renderHierarchy();
  renderAssets();
  renderBuild();
  renderPlay();
  if (!opts.keepInspector) renderInspector();
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
  return true;
}

// ------------------------------------------------------------- header -----

function renderHeader() {
  const d = S.snap.describe;
  $('#projName').textContent = d.project.name + '  ' + d.project.version;
  document.title = d.project.name + ' — Celer Studio';
  const b = S.snap.build;
  let st = 'rev ' + S.snap.rev + '  ·  ' + d.scenes.length + ' cenas  ·  ' + d.assets.length + ' assets';
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

  const sceneRow = el('div', {
    class: 'row scene' + (S.sel.kind === 'scene' ? ' sel' : ''),
    onclick: () => { S.sel = { kind: 'scene', id: null, comp: null }; renderHierarchy(); renderInspector(); draw(); },
  }, [el('span', { class: 'ico', text: '▤' }), el('span', { class: 'nm', text: sc.name })]);
  box.appendChild(sceneRow);

  for (const e of sc.entities || []) {
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
}

function selectEntity(fid) {
  S.sel = { kind: 'entity', id: fid, comp: null };
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

function renderAssets() {
  const box = $('#assets');
  box.innerHTML = '';
  const groups = { Sprite: [], Audio: [], Script: [], Cena: [], Prefab: [] };
  for (const a of S.snap.describe.assets || []) {
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
        onclick: () => selectAsset(a.guid),
        ondblclick: () => {
          if (a.kind === 'scene') { S.sceneGuid = a.guid; S.sel = { kind: 'scene', id: null, comp: null }; renderSceneSel(); renderHierarchy(); renderInspector(); draw(); }
          else if (a.kind === 'script') openScript(a);
        },
      }, [
        assetIcon(a),
        el('span', { class: 'nm', text: a.name }),
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
        const r = await runOps([{ op: 'script.set', name: name, content:
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

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', { text: label }), input]);
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
  const box = $('#inspector');
  const kind = $('#inspKind');
  box.innerHTML = '';
  if (!S.snap) return;
  const sc = currentScene();

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

function renderSceneInspector(box, sc) {
  const st = sc.settings || {};
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: 'CENA' }),
    field('nome', text(sc.name, (v) => ops([{ op: 'scene.rename', scene: sc.guid, name: v }]))),
    field('cor de fundo', color(st.bg || '#000000', (v) => sceneSetting(sc, { bg: v }))),
    field('fps', num(st.fps === undefined ? 30 : st.fps, (v) => sceneSetting(sc, { fps: v }), 1)),
    field('estatica', check(st.static, (v) => sceneSetting(sc, { static: v }))),
    el('div', { class: 'rowbtns' }, [
      el('button', {
        class: 'mini', text: sc.guid === S.snap.describe.project.startScene ? 'cena inicial ✓' : 'definir inicial',
        onclick: () => ops([{ op: 'scene.start', scene: sc.guid }]),
      }),
    ]),
  ]));

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

function sceneSetting(sc, patch) {
  ops([{ op: 'scene.set', scene: sc.guid, settings: patch }], { keepInspector: true });
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
    for (const name in fields) {
      const def = fields[name];
      const val = (c.fields || {})[name];
      let input;
      if (def.type === 'number' || def.type === 'int') {
        input = num(val === undefined ? def.default : val, (v) => compSet(sc, e, c, name, v), def.type === 'int' ? 1 : 0.1);
      } else if (def.type === 'bool') {
        input = check(val === undefined ? def.default : val, (v) => compSet(sc, e, c, name, v));
      } else if (def.type === 'color') {
        input = color(val === undefined ? def.default : val, (v) => compSet(sc, e, c, name, v));
      } else if (def.type === 'enum') {
        input = select(val === undefined ? def.default : val,
          (def.values || []).map((x) => ({ value: x, label: x || '(vazio)' })),
          (v) => compSet(sc, e, c, name, v));
      } else if (def.type === 'sprite') {
        input = el('select');
        input.appendChild(el('option', { value: '', text: '(nenhum)' }));
        for (const g of spriteOptions()) input.appendChild(g);
        input.value = val || '';
        input.addEventListener('change', () => compSet(sc, e, c, name, input.value));
      } else if (def.type === 'script') {
        input = el('select');
        input.appendChild(el('option', { value: '', text: '(nenhum)' }));
        for (const a of S.snap.describe.assets || []) {
          if (a.kind === 'script') input.appendChild(el('option', { value: a.guid, text: a.name }));
        }
        const sa = asset(val);
        input.value = sa ? sa.guid : (val || '');
        input.addEventListener('change', () => compSet(sc, e, c, name, input.value));
      } else if (def.type === 'asset') {
        input = el('select');
        input.appendChild(el('option', { value: '', text: '(nenhum)' }));
        for (const a of S.snap.describe.assets || []) {
          if (['sprite', 'sprite-sheet', 'tileset'].includes(a.kind)) {
            input.appendChild(el('option', { value: a.guid, text: a.name }));
          }
        }
        const sa = asset(val);
        input.value = sa ? sa.guid : (val || '');
        input.addEventListener('change', () => {
          const ma = asset(input.value);
          const anims = (ma && ma.settings && ma.settings.anims) || {};
          const first = Object.keys(anims)[0] || '';
          const cur = (c.fields || {}).current;
          const list = [{ op: 'component.set', scene: sc.guid, entity: e.fid,
                          component: c.id, field: name, value: input.value }];
          if (first && (!cur || !anims[cur])) {
            list.push({ op: 'component.set', scene: sc.guid, entity: e.fid,
                        component: c.id, field: 'current', value: first });
          }
          ops(list);
        });
      } else if (def.type === 'json') {
        input = jsonArea(val === undefined ? def.default : val, (v) => compSet(sc, e, c, name, v));
      } else {
        input = text(val === undefined ? def.default : val, (v) => compSet(sc, e, c, name, v));
      }
      body.appendChild(field(def.label || name, input));
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

function renderAssetInspector(box, a) {
  if (!a) { box.appendChild(el('div', { class: 'empty', text: 'asset sumiu' })); return; }
  box.appendChild(el('div', { class: 'insp-section' }, [
    el('h4', { text: (KIND_LABEL[a.kind] || a.kind).toUpperCase() }),
    field('nome', text(a.name, (v) => ops([{ op: 'asset.rename', asset: a.guid, name: v }]))),
    field('guid', el('input', { type: 'text', value: a.guid, disabled: 'disabled' })),
    field('arquivo', el('input', { type: 'text', value: a.path, disabled: 'disabled' })),
    field('importer', el('input', { type: 'text', value: a.importer, disabled: 'disabled' })),
    field('bytes', el('input', { type: 'text', value: a.size, disabled: 'disabled' })),
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
  const x = dragPreview ? dragPreview.x : (t.x || 0);
  const y = dragPreview ? dragPreview.y : (t.y || 0);
  const rot = (t.rot || 0) * Math.PI / 180;
  const sx = t.sx === undefined ? 1 : t.sx;
  const sy = t.sy === undefined ? 1 : t.sy;
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
  const b = S.snap ? S.snap.build : null;
  if (!b) { box.textContent = 'sem build. Clique em Build.'; return; }
  const lines = [];
  lines.push('pacote: ' + b.app + ' ' + b.version);
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
}

function renderPlay() {
  const p = S.snap && S.snap.play;
  const running = p && p.running && p.url;
  $('#btnPlay').hidden = !!running;
  $('#btnStop').hidden = !running;
  if (running) {
    const frame = $('#gameFrame');
    if (frame.src !== p.url) frame.src = p.url;
  }
}

// --------------------------------------------------------------- tabs ------

function setTab(name) {
  S.tab = name;
  for (const b of $$('#tabs [data-tab]')) b.classList.toggle('active', b.dataset.tab === name);
  $('#sceneWrap').hidden = name !== 'scene';
  $('#gameWrap').hidden = name !== 'game';
  $('#buildWrap').hidden = name !== 'build';
  if (name === 'scene') draw();
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
    $('#modalHint').textContent = 'ES5 apenas; o build linta com app_lint.';
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

// --------------------------------------------------------------- events ----

function wireEvents() {
  $('#sceneSel').addEventListener('change', () => {});
  $('#btnValidate').onclick = doValidate;
  $('#btnBuild').onclick = doBuild;
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
    const r = await ops([{ op: 'entity.create', scene: sc.guid, name: 'Entidade', x: Math.round(m.w / 2), y: Math.round(m.h / 2) }]);
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

  new ResizeObserver(() => draw()).observe($('#sceneWrap'));

  const es = new EventSource('/api/events');
  let t = null;
  es.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'fs') {
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
  $('#zoomLabel').textContent = S.view.zoom.toFixed(2) + 'x';
  await loadSnapshot({});
  log('Celer Studio pronto. Comandos JSON no prompt, ou: build, validate, run, play, undo, redo.', 'dim');
  if (window.innerWidth < 980) log('janela estreita: use >= 1000px para as tres colunas', 'warn');
})();
