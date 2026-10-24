# Plugins de watchface

[English](/Celer-Brasil/CelerOS/wiki/Watchface-Plugins) | **Português (BR)**

Desde a **API 16**, apps instalados podem colocar um widget no mostrador
(watchface) do CelerOS. O primeiro da loja é o **Previsao**: ao ser baixado,
ele instala um plugin que mostra a temperatura, a condição e a mínima/máxima
do dia direto no relógio — e um toque na linha abre o app completo.

## Como funciona

O watchface é um app JS (`celeros.watchface`). A cada 30 segundos ele
reescaneia duas origens e carrega até **2 plugins**:

1. `<pasta do app>/watchface.js` — para instalações completas (imagem do
   sistema, `celerctl push` de pasta, instalador por SD);
2. `/local/data/<packageName>/watchface.js` — o appData privado do app. É o
   caminho que a **loja** usa: ela instala só `main.js`/`app.json`/ícone, e a
   origem exigiria permissão de sistema para escrever na pasta de outro app.
   O plugin viaja **dentro do `main.js`** como uma string e o app o grava no
   próprio appData na primeira execução — instalar o app *é* instalar o
   plugin; desinstalar o app remove os dois (appData é apagado junto).

Um plugin que errar na
avaliação ou no desenho é dispensado (e fica de quarentena até o próximo
scan) — ele **nunca derruba o relógio**. O plugin roda **dentro do watchface**
e herda as permissões dele (app de sistema): só instale plugins de autores em
quem você confia — o mesmo critério de qualquer app.

## Contrato do plugin

O `watchface.js` é avaliado dentro de uma função e termina em `return`:

```js
// dentro do plugin vale o mesmo ambiente de um app: System, FS, Storage...
var T = System.theme();
var dados = null;
return {
    id: "meu.plugin",                    // único; dedup entre as origens
    sig: function () { return "..."; },  // op.: string barata; mudou = redesenha
    line: function () { return "texto"; },          // texto simples, ou...
    draw: function (x, y, w, h, bg) { /* ... */ },  // ...desenho próprio
    open: "meu.app"                      // op.: toque na linha abre o app
};
```

- A banda de widgets fica acima do rodapé (estilos **digital** e
  **analógico**; o **mínimo** fica limpo de propósito). Cada linha tem
  168x22 px do espaço virtual 240x320; com 2 plugins, a trilha de segundos
  sai de cena.
- `draw(x, y, w, h, bg)` recebe o retângulo da linha; com papel de parede,
  `bg` é a cor da pílula (desenhe-a antes do texto); sem, é `null`.
- `sig()` roda a cada tick (~150 ms): seja barato. Leia arquivos no máximo
  uma vez por minuto (o plugin do Previsao faz esse throttle).
- Toque numa linha com `open` chama `System.launchApp` (API 16): o relógio
  sai pela porta limpa e o launcher abre o app de destino.

## Escrevendo um app com plugin

O esqueleto do lado do app (veja o completo em `hub_apps/Previsao/main.js`):

```js
var DATA = FS.appData();                       // /local/data/<pkg>/
var PLUGIN_SRC = [ "/* o mesmo JS acima */" ].join("\n");
function instalaPlugin() {
    if (FS.readTextFile(DATA + "watchface.js") === PLUGIN_SRC) return;
    FS.writeTextFile(DATA + "watchface.js", PLUGIN_SRC);   // idempotente
}
instalaPlugin();
```

Reescreva o arquivo quando o plugin mudar de versão (a comparação de string
já resolve: só grava quando difere). O app guarda os dados do widget no
appData dele (ex.: `forecast.json`) e o plugin lê — o watchface é app de
sistema e enxerga o appData de todos.

## Referências

- `data/apps/Watchface/main.js` — carregador e banda de widgets
- `hub_apps/Previsao/` — o primeiro plugin, de ponta a ponta
- [JS API](/Celer-Brasil/CelerOS/wiki/JS-API) — `System.launchApp` (API 16)
