// Fixture: uso PROTEGIDO nao incomoda — raizes opcionais (Mic/CelerNet/
// Service) e funcao acima da API declarada, todas atras de typeof, rodam
// com o recurso desligado; o app.json pode declarar api baixa (o app nao
// some do aparelho antigo) e nenhum aviso sai.
// Esperado: ZERO diagnosticos com appInfo {api: 2}.
var TEM_MALHA = typeof CelerNet !== "undefined";
var som = typeof System.sfx === "function" ? System.sfx : null;

function fala() { if (TEM_MALHA) CelerNet.broadcast("oi", 6); }
function ouve() {
    if (typeof Mic !== "undefined" && typeof Mic.start === "function") Mic.start();
}
function para() { if (typeof Service !== "undefined" && Service.stop) Service.stop(); }
function toca() { if (som) som([[440, 40]]); }

fala();
ouve();
para();
toca();
