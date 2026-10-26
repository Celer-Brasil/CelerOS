// Bridge de runtime legado do Celer Studio (ES5). O build concatena este
// corpo no main.js gerado e chama:
//   legacyBoot(E, { entry: "legacy.main", pkg: "celeros.detona", bases: [...] })
//
// O app original chama E.init/E.run no topo do modulo. Aqui interceptamos
// E.run para CAPTURAR a tabela de cenas (sem entrar no loop) e rodamos um
// unico cenario-embalagem dentro do E.run do Studio. O loop da engine
// (input, modulos, timers, tweens, camera, audio, dirty layer) continua
// sendo o do Studio; E.goto/push/pop sao redirecionados para a tabela
// interna. Transicoes visuais (fade/wipe/iris) sao ignoradas nesta versao.

function legacyBoot(E, opts) {
    opts = opts || {};
    var pkg = opts.pkg || '';
    var bases = [];
    function addBase(b) {
        if (b && bases.indexOf(b) < 0) bases.push(b);
    }
    for (var bi = 0; bi < (opts.bases || []).length; bi++) addBase(opts.bases[bi]);
    if (pkg) {
        addBase('/local/apps/' + pkg + '/');
        addBase('/sd/apps/' + pkg + '/');
        addBase('/local/apps/' + String(pkg).replace(/[^A-Za-z0-9._-]+/g, '_') + '/');
        addBase('/sd/apps/' + String(pkg).replace(/[^A-Za-z0-9._-]+/g, '_') + '/');
    }

    // E.spr.bases e escrito pelo app original (as vezes direto): um setter
    // garante que os caminhos do pacote do Studio entrem SEMPRE primeiro.
    var curBases = bases.slice();
    if (E.spr) {
        try {
            Object.defineProperty(E.spr, 'bases', {
                configurable: true,
                enumerable: true,
                get: function () { return curBases; },
                set: function (v) {
                    var out = bases.slice(), i;
                    for (i = 0; i < (v || []).length; i++) if (out.indexOf(v[i]) < 0) out.push(v[i]);
                    curBases = out;
                }
            });
            E.spr.bases = [];
        } catch (e) {
            E.spr.bases = bases.concat(E.spr.bases || []);
        }
    }

    var origInit = E.init;
    E.init = function (o) {
        o = o || {};
        o.bases = bases.concat(o.bases || []);
        return origInit(o);
    };

    var origRun = E.run;
    var got = null;
    var pending = null;
    var cur = null;
    var curName = '';
    var stack = [];

    E.run = function (scenes, first, firstArg) {
        got = { scenes: scenes, first: first, firstArg: firstArg };
        // NAO roda o loop: o E.run do Studio e o dono do loop.
    };

    function sceneError(name) {
        var nomes = [], k;
        for (k in got.scenes) nomes.push(k);
        return new Error('cena inexistente: ' + name + ' (cenas: ' + nomes.join(', ') + ')');
    }

    E.goto = function (name, o) {
        if (!got || !got.scenes[name]) throw sceneError(name);
        pending = { kind: 'goto', name: name, arg: o ? o.arg : undefined };
    };
    E.push = function (name, o) {
        if (!got || !got.scenes[name]) throw sceneError(name);
        pending = { kind: 'push', name: name, arg: o ? o.arg : undefined };
    };
    E.pop = function (o) {
        if (!stack.length) return false;
        pending = { kind: 'pop', name: stack[stack.length - 1].name,
                    arg: o ? o.arg : undefined };
        return true;
    };
    E.depth = function () { return stack.length; };

    // o modulo legado roda o topo agora: E.init + definicoes + E.run (capturado)
    var legacy = require(opts.entry);
    if (!got) {
        throw new Error('legacy: ' + opts.entry + ' nao chamou E.run');
    }
    E.run = origRun;
    E._scenes = got.scenes;
    E._next = null;

    function saveDirty() {
        var d = E.dirty;
        return { on: d.on, bg: d._bg, paint: d._paint, clip: d._clip };
    }
    function loadDirty(v) {
        var d = E.dirty;
        d.on = v.on;
        d._bg = v.bg;
        d._paint = v.paint;
        d._clip = v.clip;
        d._prev.length = 0;
        d._cur.length = 0;
        d._full = true;
    }
    function leave(sc) {
        if (!sc) return;
        if (sc.exit) sc.exit();
        if (sc.dispose) sc.dispose();
        if (sc.cleanup) E._killGen(sc._gen);
    }
    function enter(name, arg) {
        var sc = got.scenes[name];
        if (!sc) throw sceneError(name);
        cur = sc;
        curName = name;
        E._scene = sc;
        E.prevScene = E.sceneName || '';
        E.sceneName = name;
        E._sceneGen = ++E._genSeq;
        sc._gen = E._sceneGen;
        E._redraw = true;
        E._btns.length = 0;
        E._btnOn = -1;
        E.dirty.off();
        wrapper.static = !!sc.static;
        wrapper.fps = sc.fps;
        if (sc.enter) sc.enter(arg);
    }
    function applyPending() {
        var p = pending;
        if (!p) return;
        pending = null;
        if (p.kind === 'push') {
            stack.push({ name: curName, scene: cur, gen: E._sceneGen, dirty: saveDirty() });
            if (cur && cur.pause) cur.pause();
            enter(p.name, p.arg);
        } else if (p.kind === 'pop') {
            if (!stack.length) return;
            leave(cur);
            var top = stack.pop();
            cur = top.scene;
            curName = top.name;
            E._scene = cur;
            E.prevScene = E.sceneName;
            E.sceneName = curName;
            E._sceneGen = top.gen;
            cur._gen = top.gen;
            E._redraw = true;
            E._btns.length = 0;
            E._btnOn = -1;
            wrapper.static = !!cur.static;
            wrapper.fps = cur.fps;
            loadDirty(top.dirty);
            if (cur.resume) cur.resume(p.arg);
        } else {
            leave(cur);
            while (stack.length) leave(stack.pop().scene);
            enter(p.name, p.arg);
        }
        E._trans = null;
        E._next = null;
    }

    var wrapper = {
        static: false,
        fps: undefined,
        enter: function () { enter(got.first, got.firstArg); },
        update: function (dt) {
            if (pending) applyPending();
            if (cur && cur.update) cur.update(dt);
        },
        draw: function () { if (cur && cur.draw) cur.draw(); },
        exit: function () {
            leave(cur);
            while (stack.length) leave(stack.pop().scene);
            cur = null;
        }
    };
    origRun({ legacy: wrapper }, 'legacy');
}
