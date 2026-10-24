# wiki/ — fonte da wiki do GitHub

Esta pasta é a fonte da verdade da
[wiki do repositório](https://github.com/Celer-Brasil/CelerOS/wiki). O
workflow [.github/workflows/wiki.yml](../.github/workflows/wiki.yml) roda o
gerador a cada push no `main` (ou PR) que mexa em documentação e publica o
resultado no repo da wiki (`Celer-Brasil/CelerOS.wiki.git`) com force-push.
**Edições feitas pela web são sobrescritas** — sempre edite aqui.

## Estrutura

```
wiki/
├── wiki.json     # manifesto: repo, branch, paginas (fonte -> pagina) e sidebar
└── pages/*.md    # paginas escritas a mao (Home, Arquitetura, ...)
```

As demais páginas são reaproveitadas de arquivos que já existem no repo
(`Documentation/JS_API_Guide*.md`, `tools/README_OTA*.md`, ...) por caminho,
via manifesto.

## Convenção bilíngue

A wiki é **bilíngue, inglês primeiro**: a página em inglês é a canônica e
fica com o nome simples (`Supported-Boards`, `Architecture`); a tradução
portuguesa mantém título em português (`Placas-Suportadas`, `Arquitetura`,
`Home-(Português)`) e aparece na seção "Português (BR)" da sidebar. Cada
página escrita a mão cruza o par de idiomas com um seletor no topo
(`English | Português (BR)`).

## Gerando localmente

```bash
python3 tools/wiki/generate.py            # saida em build/wiki
python3 tools/wiki/generate.py --out /tmp/wiki
```

O gerador é Python puro (stdlib). Links relativos que apontam para arquivos
do repo são reescritos na saída:

* imagens → copiadas para `assets/` dentro da wiki;
* arquivo que também é página → link interno da wiki;
* qualquer outro arquivo/pasta → URL absoluta do GitHub (`blob`/`tree`).

Links absolutos, âncoras e caminhos começando com `/` (links internos da
wiki) passam intactos. Links quebrados viram aviso no console.

## Como adicionar uma página

1. Escreva `wiki/pages/Nome-Da-Pagina.md` em **inglês** e a tradução
   (ex.: `Placas-...`, `Home.pt-BR.md`) — ou aponte o `src` para um
   arquivo existente do repo no `wiki.json`.
2. Acrescente a entrada em `pages` e a seção certa em `sidebar` no
   `wiki.json` (traduções vão na seção "Português (BR)").
3. Rode o gerador para conferir e commit — o CI publica no merge.
