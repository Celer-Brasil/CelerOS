// mundo.js — o mapa da Lenda de Celer: salas de 15x13 celulas em ASCII
// (E.world + E.level). Tres areas:
//   campo — overworld 4x3 (comeca na Clareira, 1,1)
//   casa  — a gruta do Sabio (a espada e a loja de bombas)
//   masm  — o Templo do Cristal, masmorra 3x3 com chave, mapa, parede
//           rachada, bumerangue e o Guardiao de pedra
//
// Bordas: abertura de 3 celulas no meio (colunas 6-8 / linhas 5-7) entre
// salas vizinhas do campo; portas 'D' de 1 celula na masmorra. As
// entradas/saidas entre areas ficam no meta da sala (porta: celula ->
// destino).

var M = {};

// ------------------------------------------------------------ legenda --
function leg(chao) {
    return {
        '.': 'grama', ',': 'flores', ':': 'areia', '~': 'agua', '=': 'madeira',
        'T': 'arvore', 'o': 'rocha', '*': 'arbusto', '+': 'lapide', 'C': 'caverna',
        '#': 'parede', '_': 'chao', 'E': 'estatua', 't': 'tocha', 'K': 'porta_chave',
        'X': 'rachada', 'D': 'porta', 'S': 'escada', 'B': 'bloco',
        'p': { spawn: 'polvo', tile: chao }, 'm': { spawn: 'morcego', tile: chao },
        'e': { spawn: 'esqueleto', tile: chao }, 'g': { spawn: 'geleia', tile: chao },
        'V': { spawn: 'sabio', tile: chao }, '$': { spawn: 'bau', tile: 'bau' },
        'h': { spawn: 'coracao', tile: chao }, 'c': { spawn: 'cristal', tile: chao },
        'k': { spawn: 'chave', tile: chao }, 'Z': { spawn: 'chefe', tile: chao },
        'L': { spawn: 'loja', tile: chao }
    };
}
M.SOLIDO = { arvore: 1, rocha: 1, arbusto: 1, lapide: 1, agua: 1, parede: 1, estatua: 1,
             tocha: 1, porta_chave: 1, rachada: 1, bloco: 1, bau: 1, bau_aberto: 1,
             porta_grade: 1 };
M.solid = function (v) { return M.SOLIDO[v] === 1; };

// ------------------------------------------------------------- campo --
var campo = {
    w: 4, h: 3, legend: leg('grama'),
    rooms: {
        '0,0': { meta: { nome: 'Bosque Norte', bau: 'bombas' }, lines: [
            'TTTTTTTTTTTTTTT',
            'TT.....T......T',
            'T..**..T..g...T',
            'T..*$*.T......T',
            'T......TTT....T',
            'T..............',
            'T....g.........',
            'T..............',
            'T..TTT....**..T',
            'T....T....*...T',
            'T....T........T',
            'T.............T',
            'TTTTTT...TTTTTT'] },
        '1,0': { meta: { nome: 'Cemiterio' }, lines: [
            'TTTTTTTTTTTTTTT',
            'T.............T',
            'T.+..+..+..+..T',
            'T.............T',
            'T.+..+.e+..+..T',
            '...............',
            '.....,...c.....',
            '...............',
            'T.+..+..+..+..T',
            'T......e......T',
            'T.+..+..+..+..T',
            'T.............T',
            'TTTTTT...TTTTTT'] },
        '2,0': { meta: { nome: 'Monte Cinzento',
                         portas: { '7,1': { area: 'masm', c: 1, r: 2, at: [7, 11] } } }, lines: [
            'ooooooooooooooo',
            'oooooooCooooooo',
            'oo....o.o....oo',
            'o.............o',
            'o..p.......p..o',
            '...............',
            '.......o.......',
            '...............',
            'o....o...o....o',
            'o.............o',
            'o..oo..p..oo..o',
            'o.............o',
            'oooooo...oooooo'] },
        '3,0': { meta: { nome: 'Lago do Norte' }, lines: [
            'TTTTTTTTTTTTTTT',
            'T~~~~~~~~~~~~~T',
            'T~~~~~~~~~~~~~T',
            'T~~~......~~~~T',
            'T~~....m....~~T',
            '.......~~.....T',
            '....m.~~~~....T',
            '.......~~.....T',
            'T~~.........~~T',
            'T~~~...h...~~~T',
            'T~~~~.....~~~~T',
            'T~~~~~...~~~~~T',
            'TTTTTT...TTTTTT'] },
        '0,1': { meta: { nome: 'Floresta Oeste' }, lines: [
            'TTTTTT...TTTTTT',
            'T.....T...TT..T',
            'T.TT......T...T',
            'T.T..m..T.....T',
            'T...TT..T..TT.T',
            'T.T.....T......',
            'T.T.TTT...m....',
            'T......T.......',
            'T.TTT..T..TTT.T',
            'T...T.....T...T',
            'T.m.T..TT.....T',
            'T.......T.....T',
            'TTTTTT...TTTTTT'] },
        '1,1': { meta: { nome: 'Clareira', inicio: [7, 6],
                         portas: { '2,2': { area: 'casa', c: 0, r: 0, at: [7, 11] } } }, lines: [
            'TTTTTT...TTTTTT',
            'Tooooo.......TT',
            'ToCooo....,...T',
            'T.............T',
            'T..,....,.....T',
            '...............',
            '.....,.........',
            '...............',
            'T........,....T',
            'T.,...........T',
            'T.....,....**.T',
            'T..........*..T',
            'TTTTTT...TTTTTT'] },
        '2,1': { meta: { nome: 'Campo Aberto' }, lines: [
            'TTTTTT...TTTTTT',
            'T.............T',
            'T..o.....o....T',
            'T......p......T',
            'T.............T',
            '.....o...o.....',
            '...p.......p...',
            '.....o...o.....',
            'T.............T',
            'T......c......T',
            'T..o.....o....T',
            'T.............T',
            'TTTTTT...TTTTTT'] },
        '3,1': { meta: { nome: 'A Ponte' }, lines: [
            'TTTTTT...TTTTTT',
            'T.............T',
            'T....p........T',
            '~~~~~~===~~~~~~',
            '~~~~~~===~~~~~~',
            '..............T',
            '.......p......T',
            '..............T',
            'T.............T',
            'T..o......o...T',
            'T......p......T',
            'T.............T',
            'TTTTTT...TTTTTT'] },
        '0,2': { meta: { nome: 'Bosque Sul' }, lines: [
            'TTTTTT...TTTTTT',
            'T.....T.......T',
            'T.g...T...g...T',
            'T.....T.......T',
            'T..TTTT..TTT..T',
            'T..............',
            'T.....g........',
            'T..............',
            'T..TT.....TT..T',
            'T.............T',
            'T..g......*...T',
            'T.........*...T',
            'TTTTTTTTTTTTTTT'] },
        '1,2': { meta: { nome: 'Estrada Velha' }, lines: [
            'TTTTTT:::TTTTTT',
            'T.....:::.....T',
            'T..p..:::.....T',
            'T.....:::..o..T',
            'T..o..:::.....T',
            ':::::::::::::::',
            ':::::::::::::::',
            ':::::::::::::::',
            'T.............T',
            'T...o....p....T',
            'T.............T',
            'T.............T',
            'TTTTTTTTTTTTTTT'] },
        '2,2': { meta: { nome: 'Praia' }, lines: [
            'TTTTTT...TTTTTT',
            'T.............T',
            'T..p......p...T',
            'T.............T',
            'T:::::::::::::T',
            ':::::::c:::::::',
            ':::p:::::::::::',
            ':::::::::::::::',
            'T:::::::::::::~',
            'T::::c:::::::~~',
            '~~:::::::::~~~~',
            '~~~~~~~~~~~~~~~',
            '~~~~~~~~~~~~~~~'] },
        '3,2': { meta: { nome: 'Ilha', bau: 'conteiner' }, lines: [
            'TTTTTT...TTTTTT',
            '~~~~~~...~~~~~~',
            '~~~~~~...~~~~~~',
            '~~~~.......~~~~',
            '~~~...***...~~~',
            '====..*$*...~~~',
            '====.......p~~~',
            '====........~~~',
            '~~~.........~~~',
            '~~~~.......~~~~',
            '~~~~~~~~~~~~~~~',
            '~~~~~~~~~~~~~~~',
            '~~~~~~~~~~~~~~~'] }
    }
};

// -------------------------------------------------------------- casa --
var casa = {
    w: 1, h: 1, legend: leg('chao'),
    rooms: {
        '0,0': { meta: { nome: 'Gruta do Sabio', interior: true,
                         portas: { '7,12': { area: 'campo', c: 1, r: 1, at: [2, 3] } } }, lines: [
            '###############',
            '#t___________t#',
            '#_____________#',
            '#_____________#',
            '#______V______#',
            '#_____________#',
            '#___c_____c___#',
            '#_____________#',
            '#______L______#',
            '#_____________#',
            '#_____________#',
            '#_____________#',
            '#######S#######'] }
    }
};

// -------------------------------------------------------------- masm --
var masm = {
    w: 3, h: 3, legend: leg('chao'),
    rooms: {
        '1,2': { meta: { nome: 'Templo - Entrada', masmorra: true,
                         portas: { '7,12': { area: 'campo', c: 2, r: 0, at: [7, 2] } } }, lines: [
            '#######D#######',
            '#t___________t#',
            '#_____________#',
            '#__E_______E__#',
            '#_____________#',
            '#_____________#',
            'D_____________D',
            '#_____________#',
            '#_____________#',
            '#__E_______E__#',
            '#_____________#',
            '#t___________t#',
            '#######S#######'] },
        '0,2': { meta: { nome: 'Templo - Poco', masmorra: true, bau: 'chave', bauAoLimpar: true }, lines: [
            '###############',
            '#_____________#',
            '#_g_________g_#',
            '#_____________#',
            '#___##___##___#',
            '#_____________#',
            '#______$______D',
            '#_____________#',
            '#___##___##___#',
            '#_____________#',
            '#_g_________g_#',
            '#_____________#',
            '###############'] },
        '2,2': { meta: { nome: 'Templo - Ninho', masmorra: true, bau: 'mapa' }, lines: [
            '###############',
            '#_____________#',
            '#_m_________m_#',
            '#_____________#',
            '#____E___E____#',
            '#_____________#',
            'D______$______#',
            '#_____________#',
            '#____E___E____#',
            '#_____________#',
            '#_m_________m_#',
            '#_____________#',
            '###############'] },
        '1,1': { meta: { nome: 'Templo - Salao', masmorra: true }, lines: [
            '#######K#######',
            '#_____________#',
            '#__e_______e__#',
            '#_____________#',
            '#_____BBB_____#',
            '#_____________#',
            'X_____________D',
            '#_____________#',
            '#_____BBB_____#',
            '#_____________#',
            '#__e_______e__#',
            '#_____________#',
            '#######D#######'] },
        '0,1': { meta: { nome: 'Templo - Camara Oculta', masmorra: true, bau: 'bumerangue' }, lines: [
            '###############',
            '#t___________t#',
            '#_____________#',
            '#_____________#',
            '#_____E_E_____#',
            '#_____________#',
            '#______$______X',
            '#_____________#',
            '#_____E_E_____#',
            '#_____________#',
            '#___h_____h___#',
            '#t___________t#',
            '###############'] },
        '2,1': { meta: { nome: 'Templo - Fosso', masmorra: true, bau: 'bombas', bauAoLimpar: true }, lines: [
            '###############',
            '#_____________#',
            '#__e_______e__#',
            '#_____~~~_____#',
            '#_____~~~_____#',
            '#_____________#',
            'D______$______#',
            '#_____________#',
            '#_____~~~_____#',
            '#_____~~~_____#',
            '#__e_______e__#',
            '#_____________#',
            '###############'] },
        '1,0': { meta: { nome: 'Templo - Guardiao', masmorra: true, chefe: true }, lines: [
            '###############',
            '#t___________t#',
            '#_____________#',
            '#______Z______#',
            '#_____________#',
            '#__E_______E__#',
            '#_____________#',
            '#_____________#',
            '#__E_______E__#',
            '#_____________#',
            '#_____________#',
            '#t___________t#',
            '#######D#######'] }
    }
};

M.AREAS = { campo: campo, casa: casa, masm: masm };
// pares de parede rachada (bomba abre os dois lados): sala -> [celula, sala do outro lado, celula]
M.RACHADAS = {
    'masm:1,1': { '0,6': { area: 'masm', c: 0, r: 1, cell: [14, 6] } },
    'masm:0,1': { '14,6': { area: 'masm', c: 1, r: 1, cell: [0, 6] } }
};
// porta trancada: abre com chave (persistente dos dois lados)
M.TRANCADAS = {
    'masm:1,1': { '7,0': { area: 'masm', c: 1, r: 0, cell: [7, 12] } }
};

module.exports = M;
