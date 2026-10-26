'use strict';
// Validacao do projeto: schema + referencias (sempre) e, no modo completo,
// limites de pacote, tamanho de assets e lint ES5 dos scripts. O build chama
// o modo completo; o barramento de ops chama o estrutural a cada lote.

const fs = require('fs');
const path = require('path');
const F = require('./format');
const SC = require('./schema');

let _manifest = null;
function manifest() {
    if (!_manifest) _manifest = require('../../app_lint/lint.js').buildManifest();
    return _manifest;
}

function isGraphic(kind) {
    return kind === 'sprite' || kind === 'sprite-sheet' || kind === 'tileset';
}
function isShipped(kind) {
    return kind !== 'scene' && kind !== 'prefab';
}

function regionNames(project, asset) {
    return new Set(project.regions(asset).map((r) => r.name));
}

function checkSpriteRef(project, ref, at, errors) {
    if (typeof ref !== 'string' || !ref) {
        errors.push({ code: 'ref.sprite', path: at, message: 'referencia de sprite vazia' });
        return;
    }
    const parts = ref.split('#');
    const a = project.asset(parts[0]);
    if (!a) {
        errors.push({ code: 'ref.missing', path: at, message: 'sprite inexistente: ' + ref });
        return;
    }
    if (!isGraphic(a.kind)) {
        errors.push({ code: 'ref.sprite', path: at, message: a.name + ' nao e um asset grafico' });
        return;
    }
    const mode = (a.meta.settings && a.meta.settings.mode) || 'single';
    if (parts.length > 1 && parts[1] !== '') {
        if (!regionNames(project, a).has(parts[1])) {
            errors.push({
                code: 'ref.region', path: at,
                message: 'regiao "' + parts[1] + '" nao existe em ' + a.name,
                hint: 'regioes: ' + Array.from(regionNames(project, a)).slice(0, 12).join(', '),
            });
        }
    } else if (mode !== 'single') {
        errors.push({ code: 'ref.region', path: at, message: 'asset ' + a.name + ' exige #regiao' });
    }
}

function checkEntity(project, e, at, errors) {
    if (!e || typeof e !== 'object') return;
    const comps = e.components || [];
    const ids = new Set();
    comps.forEach((c, i) => {
        const cat = SC.componentCatalog()[c.type];
        const cat2 = at + '.components[' + i + ']';
        if (c.id) {
            if (ids.has(c.id)) errors.push({ code: 'schema.duplicate', path: cat2 + '.id', message: 'id de componente repetido: ' + c.id });
            ids.add(c.id);
        }
        if (!cat) return;   // schema ja acusou
        const f = c.fields || {};
        if (c.type === 'sprite') checkSpriteRef(project, f.sprite, cat2 + '.fields.sprite', errors);
        if (c.type === 'script') {
            const a = project.asset(f.script);
            if (!a) errors.push({ code: 'ref.missing', path: cat2 + '.fields.script', message: 'script inexistente: ' + f.script });
            else if (a.kind !== 'script') errors.push({ code: 'ref.script', path: cat2 + '.fields.script', message: a.name + ' nao e script' });
        }
        if (c.type === 'anim') {
            if (f.meta) {
                const ma = project.asset(f.meta);
                if (!ma) {
                    errors.push({ code: 'ref.missing', path: cat2 + '.fields.meta', message: 'asset de metadados inexistente: ' + f.meta });
                } else if (!['sprite', 'sprite-sheet', 'tileset'].includes(ma.kind)) {
                    errors.push({ code: 'ref.sprite', path: cat2 + '.fields.meta', message: ma.name + ' nao e asset grafico' });
                } else if ((ma.meta.settings || {}).mode === 'single') {
                    errors.push({ code: 'asset.anims', path: cat2 + '.fields.meta',
                                  message: ma.name + ' e imagem unica; anims exigem grade/regioes' });
                } else {
                    const anims = (ma.meta.settings || {}).anims || {};
                    if (!Object.keys(anims).length) {
                        errors.push({ code: 'asset.anims', path: cat2 + '.fields.meta', message: ma.name + ' nao tem anims no .meta' });
                    } else if (f.current && !anims[f.current]) {
                        errors.push({ code: 'ref.clip', path: cat2 + '.fields.current', message: 'clipe "' + f.current + '" nao existe em ' + ma.name + '.anims' });
                    }
                }
            }
            const clips = f.clips || {};
            if (!clips || typeof clips !== 'object') {
                errors.push({ code: 'schema.type', path: cat2 + '.fields.clips', message: 'clips deve ser objeto' });
            } else {
                for (const clipName of Object.keys(clips)) {
                    const clip = clips[clipName] || {};
                    if (!Array.isArray(clip.frames)) {
                        errors.push({ code: 'schema.type', path: cat2 + '.fields.clips.' + clipName + '.frames', message: 'frames deve ser array' });
                        continue;
                    }
                    clip.frames.forEach((fr, fi) => checkSpriteRef(
                        project, fr, cat2 + '.fields.clips.' + clipName + '.frames[' + fi + ']', errors));
                    if (clip.fps !== undefined && (!(clip.fps > 0))) {
                        errors.push({ code: 'schema.range', path: cat2 + '.fields.clips.' + clipName + '.fps', message: 'fps > 0' });
                    }
                }
                if (!f.meta && f.current && !clips[f.current]) {
                    errors.push({ code: 'ref.clip', path: cat2 + '.fields.current', message: 'clipe atual nao existe: ' + f.current });
                }
            }
        }
    });
    if (e.prefab) {
        const pf = project.prefab(e.prefab);
        if (!pf) {
            errors.push({ code: 'ref.prefab', path: at + '.prefab', message: 'prefab inexistente: ' + e.prefab });
        } else if (e.overrides) {
            const byFid = new Map((pf.entities || []).map((x) => [x.fid, x]));
            for (const target of Object.keys(e.overrides)) {
                const te = byFid.get(target);
                if (!te) {
                    errors.push({ code: 'ref.override', path: at + '.overrides.' + target, message: 'entidade nao existe no prefab' });
                    continue;
                }
                const ov = e.overrides[target] || {};
                if (ov.components) {
                    const byId = new Map((te.components || []).map((c) => [c.id, c]));
                    for (const cid of Object.keys(ov.components)) {
                        if (!byId.has(cid)) {
                            errors.push({ code: 'ref.override', path: at + '.overrides.' + target + '.components.' + cid, message: 'componente nao existe no prefab' });
                        }
                    }
                }
            }
        }
    }
}

function checkScene(project, sc, asset, errors) {
    const diags = [];
    SC.validateSceneData(sc, diags);
    for (const d of diags) errors.push(d);
    const at = asset ? asset.relPath : ('cena ' + (sc && sc.name));
    if (!sc || typeof sc !== 'object') return;
    if (sc.settings) {
        if (sc.settings.music) {
            const a = project.asset(sc.settings.music);
            if (!a) errors.push({ code: 'ref.missing', path: at + '.settings.music', message: 'audio inexistente' });
            else if (a.kind !== 'audio') errors.push({ code: 'ref.audio', path: at + '.settings.music', message: a.name + ' nao e audio' });
        }
        if (sc.settings.camera && sc.settings.camera.follow) {
            const fid = sc.settings.camera.follow;
            if (!(sc.entities || []).some((e) => e.fid === fid)) {
                errors.push({ code: 'ref.entity', path: at + '.settings.camera.follow', message: 'entidade seguida nao existe: ' + fid });
            }
        }
    }
    (sc.entities || []).forEach((e, i) => checkEntity(project, e, at + '.entities[' + i + ']', errors));
    (sc.tilemaps || []).forEach((tm, i) => {
        const a = project.asset(tm.tileset);
        const tat = at + '.tilemaps[' + i + ']';
        if (!a) {
            errors.push({ code: 'ref.missing', path: tat + '.tileset', message: 'tileset inexistente: ' + tm.tileset });
            return;
        }
        if (a.kind !== 'tileset' && a.kind !== 'sprite-sheet') {
            errors.push({ code: 'ref.tileset', path: tat + '.tileset', message: a.name + ' nao e tileset' });
            return;
        }
        const n = project.regions(a).length;
        if (Array.isArray(tm.data)) {
            for (let k = 0; k < tm.data.length; k++) {
                const v = tm.data[k];
                // -1 = celula vazia (o runtime pula); 0..n-1 = regiao do tileset
                if (!SC.isInt(v) || v < -1 || v >= Math.max(1, n)) {
                    errors.push({
                        code: 'tilemap.value', path: tat + '.data[' + k + ']',
                        message: 'tile ' + v + ' fora de -1..' + (n - 1) + ' do tileset ' + a.name,
                    });
                    break;
                }
            }
        }
    });
}

function checkPrefab(project, pf, asset, errors) {
    const diags = [];
    SC.validatePrefabData(pf, diags);
    for (const d of diags) errors.push(d);
    const at = asset ? asset.relPath : ('prefab ' + (pf && pf.name));
    if (!pf || typeof pf !== 'object') return;
    (pf.entities || []).forEach((e, i) => checkEntity(project, e, at + '.entities[' + i + ']', errors));
}

function localVersion(name) {
    try {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'sdk', 'engine', name + '.js'), 'utf8');
        const m = src.match(/version\s*[:=]\s*['"]([^'"]+)['"]/);
        return m ? m[1] : null;
    } catch (e) { return null; }
}

function cmp(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
}

function rangeOk(range, version) {
    if (!range || !version) return true;
    if (range[0] !== '^') return range === version;
    const base = range.slice(1);
    return version.split('.')[0] === base.split('.')[0] && cmp(version, base) >= 0;
}

function checkAssetFiles(project, errors, warnings) {
    let total = 0;
    const used = new Map();
    for (const a of project.assets) {
        if (!isShipped(a.kind)) continue;
        const at = a.relPath;
        if (!fs.existsSync(a.absPath)) {
            errors.push({ code: 'asset.missing', path: at, message: 'arquivo nao existe' });
            continue;
        }
        // o teto de 256KB e dos assets nao-JS; scripts tem teto proprio (256KB)
        if (a.kind !== 'script') total += a.size;
        if (a.kind !== 'script' && a.size > 128 * 1024) {
            errors.push({ code: 'asset.toobig', path: at, message: (a.size / 1024).toFixed(1) + 'KB (maximo 128KB)' });
        }
        if (isGraphic(a.kind)) {
            const st = a.meta.settings || {};
            if (a.ext !== '.png') errors.push({ code: 'asset.type', path: at, message: 'asset grafico deve ser PNG' });
            if (!project.regions(a).length) {
                errors.push({ code: 'asset.regions', path: at, message: 'asset sem regioes (settings do importer)' });
            }
            if (st.mode === 'grid') {
                const cols = st.cols || 0, rows = st.rows || 0, tw = st.tw || 0, th = st.th || 0;
                if (st.w && cols * tw > st.w) {
                    errors.push({ code: 'asset.grid', path: at, message: 'grade ' + cols + 'x' + tw + ' excede a largura ' + st.w });
                }
                if (st.h && rows * th > st.h) {
                    errors.push({ code: 'asset.grid', path: at, message: 'grade ' + rows + 'x' + th + ' excede a altura ' + st.h });
                }
                if (a.kind === 'tileset' && Array.isArray(st.tiles) && st.tiles.length < cols * rows) {
                    warnings.push({ code: 'asset.tiles', path: at, message: 'tiles tem ' + st.tiles.length + ', grade tem ' + cols * rows });
                }
            }
            if (st.anims && (st.mode || 'single') === 'single') {
                errors.push({ code: 'asset.anims', path: at,
                              message: 'anims exige modo grid/regions (imagem unica nao tem quadros)' });
            } else if (st.anims) {
                const nregs = project.regions(a).length;
                for (const clip of Object.keys(st.anims)) {
                    const list = st.anims[clip] || [];
                    for (let i = 0; i < list.length; i++) {
                        const it = list[i];
                        if (typeof it === 'number' && (!SC.isInt(it) || it < 0 || it >= nregs)) {
                            errors.push({
                                code: 'asset.anims', path: at,
                                message: 'anims.' + clip + '[' + i + '] = ' + it + ' fora de 0..' + (nregs - 1),
                            });
                        }
                    }
                }
            }
        }
        if (a.kind === 'audio' && a.ext !== '.qoa' && a.ext !== '.wav') {
            errors.push({ code: 'asset.type', path: at, message: 'audio deve ser .qoa ou .wav' });
        }
        if (a.kind === 'script') {
            if (a.ext !== '.js') errors.push({ code: 'asset.type', path: at, message: 'script deve ser .js' });
            if (a.size > 256 * 1024) errors.push({ code: 'asset.toobig', path: at, message: 'script > 256KB (limite do require)' });
        }
    }
    if (total > 256 * 1024) {
        errors.push({ code: 'package.assets', path: 'Assets',
                      message: 'assets somam ' + (total / 1024).toFixed(1) + 'KB (maximo 256KB)' });
    }
    for (const a of project.assets) {
        if (!isShipped(a.kind)) continue;
        const name = F.sanitizeFileName(a.fileName).toLowerCase();
        if (used.has(name)) {
            warnings.push({ code: 'asset.name', path: a.relPath,
                            message: 'nome flat colide com ' + used.get(name) + ' (o build renomeia)' });
        } else used.set(name, a.relPath);
    }
}

function checkScripts(project, errors, warnings) {
    let m;
    try { m = manifest(); } catch (e) {
        warnings.push({ code: 'lint.unavailable', path: 'tools/app_lint', message: 'manifest indisponivel: ' + e.message });
        return;
    }
    const appInfo = {
        permissions: Array.isArray(project.data.permissions) ? project.data.permissions : [],
        api: project.data.api || m.apiLevel,
    };
    for (const a of project.assets) {
        if (a.kind !== 'script') continue;
        let src;
        try { src = fs.readFileSync(a.absPath, 'utf8'); }
        catch (e) { errors.push({ code: 'asset.read', path: a.relPath, message: e.message }); continue; }
        const diags = require('../../app_lint/lint.js').lintSource(m, src, appInfo, ['module', 'exports']);
        for (const d of diags) {
            const item = {
                code: 'lint.' + d.rule,
                path: a.relPath + ':' + d.line + ':' + d.col,
                message: d.message,
            };
            if (d.severity === 'erro') errors.push(item); else warnings.push(item);
        }
    }
}

function checkLimits(project, errors, warnings) {
    const legacy = project.data.runtime === 'legacy';
    const shipped = project.assets.filter((a) => isShipped(a.kind));
    const scripts = shipped.filter((a) => a.kind === 'script').length;
    const files = shipped.length - scripts + scripts;   // assets + scripts (1 arquivo cada)
    const extras = files + (legacy ? 0 : 1);             // + game.data.js no runtime Studio
    if (extras > 16) {
        errors.push({ code: 'package.extras', path: 'Assets',
                      message: 'pacote teria ' + extras + ' extras (maximo 16): reduza scripts/assets' });
    } else if (extras >= 14) {
        warnings.push({ code: 'package.extras', path: 'Assets',
                        message: 'pacote com ' + extras + ' extras (limite 16; data pode dividir)' });
    }
    const deps = project.data.deps || {};
    const need = legacy ? ['celeros.game']
        : ['celeros.game', 'celeros.game.spr', 'celeros.game.tilemap'];
    for (const n of need) {
        if (!deps[n]) {
            errors.push({ code: 'deps.missing', path: 'deps',
                          message: (legacy ? 'o modo legado exige ' : 'o runtime gerado exige ') + n });
        }
    }
    for (const n of Object.keys(deps)) {
        const v = localVersion(n);
        if (v && !rangeOk(deps[n], v)) {
            warnings.push({ code: 'deps.range', path: 'deps.' + n,
                            message: deps[n] + ' nao cobre a versao local ' + v });
        }
    }
    if (project.data.api < 30 && Object.keys(deps).length) {
        errors.push({ code: 'deps.api', path: 'api', message: 'deps exigem api >= 30' });
    }
}

function validateProject(project, opts) {
    opts = opts || {};
    const errors = [];
    const warnings = [];

    SC.validateProjectData(project.data, errors);
    for (const issue of project.issues || []) {
        errors.push({ code: issue.code, path: issue.path, message: issue.message });
    }
    const legacy = project.data.runtime === 'legacy';
    if (!legacy && !project.scene(project.data.startScene) &&
        (project.data.startScene || project.sceneList().length)) {
        errors.push({ code: 'scene.start', path: 'startScene',
                      message: project.data.startScene
                          ? 'cena inicial inexistente: ' + project.data.startScene
                          : 'projeto sem cena inicial' });
    }
    if (legacy) {
        const entry = project.data.legacy && project.data.legacy.entry;
        const found = entry && project.assets.some((a) =>
            a.kind === 'script' && (a.fileName === entry || a.name === entry.replace(/\.js$/, '')));
        if (!found) {
            errors.push({ code: 'legacy.entry', path: 'legacy.entry',
                          message: 'script de entrada do modo legado nao encontrado: ' + entry });
        }
    }
    for (const sc of project.sceneByGuid.values()) {
        checkScene(project, sc, project.byGuid.get(sc.guid), errors);
    }
    for (const pf of project.prefabByGuid.values()) {
        checkPrefab(project, pf, project.byGuid.get(pf.guid), errors);
    }
    if (!opts.structural) {
        checkAssetFiles(project, errors, warnings);
        checkScripts(project, errors, warnings);
        checkLimits(project, errors, warnings);
    }
    return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateProject, checkSpriteRef, checkEntity, isGraphic, isShipped, rangeOk, localVersion };
