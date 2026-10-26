# Jogos remontados no Celer Studio

Estes quatro projetos sao a primeira remontagem dos jogos maiores no editor
(`celer.js studio`). Eles estao em **modo legado**: o `main.js` original roda
dentro do loop do Studio (bridge), então o Play e o build reproduzem o jogo de
verdade. Assets e scripts são editáveis no projeto; a cena do painel é apenas
um cartão e ainda NÃO controla o runtime.

| Projeto | App original | Versão | Como abrir |
|---------|--------------|--------|------------|
| `Detona` | `hub_apps/Detona` | 0.10.2 | `node tools/sdk/celer.js studio "studio_games/Detona" serve --open` |
| `Arrasa` | `hub_apps/Arrasa` | 1.3.2 | `node tools/sdk/celer.js studio "studio_games/Arrasa" serve --open` |
| `Lenda de Celer` | `hub_apps/Lenda de Celer` | 1.0.4 | `node tools/sdk/celer.js studio "studio_games/Lenda de Celer" serve --open` |
| `Supernova` | `hub_apps/Supernova` | 2.6.2 | `node tools/sdk/celer.js studio "studio_games/Supernova" serve --open` |

Build/run headless:

```bash
node tools/sdk/celer.js studio "studio_games/Detona" build
node tools/sdk/celer.js studio "studio_games/Detona" run --frames 0,1200
# navegar menus (coordenadas 480x480): 200 tap 240,270 -> --input toques.txt
```

Os apps originais em `hub_apps/` não foram alterados. Cada projeto tem sua
própria cópia de assets/scripts (é isso que o editor edita) e `.studio/`
(build/undo) fica no `.gitignore` local.

## O que já funciona

- Título e gameplay dos quatro jogos no Play do Studio (480x480 nativo).
- `E.goto`, `E.push/E.pop`, `E.quit`, cenas `static`, dirty layer, módulos,
  timers/tweens, áudio, input e câmera da engine.
- Assets e scripts editáveis; build gera app flat com o `app.json` original
  (packageName/versão/api/deps), pronto para `celerctl`/hub.

## O que falta na remontagem

- Transições visuais (fade/wipe/iris) são ignoradas nesta primeira versão.
- Levels/salas/fases ainda vivem no código original; a cena do Studio não
  alimenta o runtime legado.
- Próxima etapa: extrair cada level/sala/fase para cenas/tilemaps/prefabs,
  adaptar o script do jogo para lê-los e remover `runtime: "legacy"` quando a
  cena nativa estiver completa.

Ferramenta usada para criar/atualizar: `node tools/sdk/celer.js studio
import-game <app> <projeto>`.
