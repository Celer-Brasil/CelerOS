# {{APP_NAME}}

App para [CelerOS](https://os.celer.tec.br) (ESP32, JavaScript ES5/Duktape).

## Arquivos

| arquivo | vai pro device? | o que e |
|---|---|---|
| `app.json` | sim | manifesto: versao, api, permissoes |
| `main.js` | sim | o app inteiro (apps sao single-file, sem require) |
| `icon.png` | sim | icone 64x64 PNG (troque o placeholder) |
| `celer.d.ts` | nao | tipos da API para o editor (autocomplete no VS Code) |
| `jsconfig.json` | nao | faz o editor ler `celer.d.ts` |
| `test.js` | nao | opcional: `wire(env)` com toques/estados para o `test`/`emu` |

## Comandos (dentro do repo CelerOS)

```bash
node tools/sdk/celer.js lint {{APP_DIR}}   # valida ES5 + API (rode a cada save)
node tools/sdk/celer.js emu {{APP_DIR}}    # emulador: roda e salva .dev/tela.png
python3 tools/celerctl.py dev {{APP_DIR}}  # live no dispositivo (watch + reload)
node tools/sdk/celer.js publish {{APP_DIR}} --dry  # conferir antes de publicar
```

## Regras que o lint cobra

- **ES5 puro**: sem `let`/`const`/arrow functions/`Promise`/template strings.
- Todo loop com `System.delay()` (o GC roda dentro do delay; loop seco trava).
- Permissoes: funcoes de rede exigem `"net"`, arquivos `"fs"`, gpio `"gpio"`
  em `app.json permissions`.
- Strings com acentos OK (Latin-1); emoji e aspas curvas nao (fonte do device).
- Soma dos `.js` (main + modulos) ate 64KB no hub (1MB declarando
  `"requires": ["psram"]`); cada arquivo acima de 30KB exige `api >= 6`.
- Modulos JS (API 23): `.js` chatos na pasta, carregados com
  `require("nome")` no estilo CommonJS (`exports.foo = ...` ou
  `module.exports = {...}`). Assets (`.png .wav .json .bin`) viajam no
  pacote: ate 16 extras de 128KB (256KB no total). `test.js` e dev-only,
  nunca embarca.

Guia completo da API: `Documentation/JS_API_Guide.pt-BR.md`.
