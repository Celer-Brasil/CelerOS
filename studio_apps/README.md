# studio_apps — exemplos do modo PROGRAMA

Projetos do Celer Studio com `runtime: "app"`: cada cena e uma TELA montada com
os widgets do sistema (`UI.*`). Nao tem dependencia de engine (`celeros.game.*`)
nem `psram`, entao o pacote tambem roda na CYD.

| Projeto | O que prova |
|---------|-------------|
| `Painel/` | painel do dispositivo: cards, `ui.progress`, `ui.toggle`, `ui.slider`, `ui.list`, navegacao com pilha, script de tela com `exports.props` (intervalo de leitura) e eventos que aplicam brilho/volume (perm `system`) |
| `Assistente/` | multimodal: `mic.record` (segurar para falar) + `ai.chat` com `attach: "mic"` (manda `input_audio`) + `ai.speak` na resposta; historico em estado da tela |

## Rodar

```bash
node tools/sdk/celer.js studio studio_apps/Painel describe
node tools/sdk/celer.js studio studio_apps/Painel build
node tools/sdk/celer.js studio studio_apps/Painel run --ms 900 --out /tmp/painel.png
node tools/sdk/celer.js studio studio_apps/Painel serve --open
node tools/sdk/celer.js studio studio_apps/Painel deploy      # app.zip
```

`Assistente` precisa de chave de IA no aparelho (`/local/openrouter_key.txt`,
ver `tools/push_ai_key.py`); no harness o `test/studio` injeta respostas
falsas.

## Estrutura

Igual a qualquer projeto do Studio: `celergame.project.json`, `Assets/Scenes/*.scene.json`
(as telas), `Assets/Scripts/*.js` (controladores de tela) e `.meta` por asset.
`.studio/` e cache e fica fora do git.

Estes projetos sao **testados** por `node test/studio/run.js` (build + run no
harness), entao uma mudanca no runtime de programa que quebre os widgets ou os
componentes de IA aparece na CI.
