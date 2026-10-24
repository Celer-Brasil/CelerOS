# Contribuindo

[English](/Celer-Brasil/CelerOS/wiki/Contributing) | **Português (BR)**

PRs vão para o `main` (commits em PT-BR descritivos são o estilo da casa).
Antes de abrir um, o checklist abaixo é o que o CI roda — e o que um
reviewer vai olhar.

## Checklist

```bash
node test/js_harness/run.js          # harness JS (apps embutidos, APIs stubadas)
g++ -std=c++17 test/cpp/run_tests.cpp -o /tmp/celeros_tests && /tmp/celeros_tests  # testes C++ no host
python3 tools/size_report.py         # custo de flash — o slot OTA da CYD é o limite que importa
```

O CI ([`.github/workflows/build.yml`](.github/workflows/build.yml)) roda o
harness JS e os testes de host a cada push/PR e depois compila o firmware
das seis placas no container oficial do ESP-IDF.

## Convenções de código

* **Só ES5** nos apps JS (`var`, `function`, sem arrow functions) — veja
  [Apps de sistema](/Celer-Brasil/CelerOS/wiki/Apps-de-Sistema).
* `#ifdef` de placa mora **só** em `main/Boards/<placa>/`; diferenças de
  compilação entre placas vivem no `BoardTraits.h` de cada uma.
* Comentários, logs e strings de CLI em português, sem acentos. Texto
  mostrado na tela pode usar acentos (as fontes cobrem Latin-1:
  U+0020..U+00FF; sem travessão, aspas curvas ou emoji). O
  `tools/acentuar.py` restaura acentos dentro de literais.
* Operações falíveis retornam `ErrorCode` (`components/ErrorCodes`), não
  `esp_err_t`; singletons usam `Singleton<T>` com ctor de token; handlers
  de `Event` só setam flags.
* API JS nova = bump de `CELEROS_API_LEVEL` no `main/CMakeLists.txt`,
  documentação nos **dois** idiomas do `JS_API_Guide` e stub no harness.
* Memória é apertada na CYD (sem PSRAM, sem exceções no hot path): um
  `std::string`/`new` que não pode crescer **aborta o aparelho** — no
  caminho sem PSRAM use malloc/realloc (veja `HttpClient::setBodySink`).

## Documentação

* **Esta wiki é gerada**: edite o `wiki/` do repo (manifesto `wiki.json` +
  `wiki/pages/`), rode `python3 tools/wiki/generate.py` para conferir e
  commit — o CI publica no merge. Edições feitas pela web são
  sobrescritas.
* **Bilíngue, inglês primeiro**: cada página escrita à mão existe em inglês
  (canônica) e em português (`Placas-Suportadas`, `Arquitetura`, ...).
  Página nova = escreva as duas, acrescente as duas no `wiki.json` (page +
  sidebar, as PT na seção "Português (BR)") e cruze os links no topo.
* Os guias de referência moram em `Documentation/` como pares `*.md` (EN) +
  `*.pt-BR.md` e são reaproveitados pela wiki por caminho.

## Adicionando uma placa

Perfis de placa são pequenos e autocontidos — os passos estão em
[Placas suportadas](/Celer-Brasil/CelerOS/wiki/Placas-Suportadas#adicionando-uma-placa).
Ajuda com bring-up é bem-vinda (uma foto da placa rodando CelerOS faz o PR
brilhar!).

## Reportando bugs

Abra uma [issue](https://github.com/Celer-Brasil/CelerOS/issues) com a placa,
versão de firmware e nível de API (Settings → Sobre, ou `celerctl info`) e
um trecho de `celerctl logcat` — ou um coredump (`celerctl coredump`) se
crashou.
