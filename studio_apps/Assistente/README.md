# Assistente

Programa do Celer Studio (runtime "app": telas com o toolkit UI do sistema).

```bash
node tools/sdk/celer.js studio . --serve   # abre o editor
node tools/sdk/celer.js studio . build     # gera o app em .studio/build
node tools/sdk/celer.js studio . run       # roda no harness (PNG)
```

A fonte da verdade sao `celergame.project.json`, `Assets/**`, `*.scene.json` e `*.prefab.json`.
