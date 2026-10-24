# wiki/ - GitHub wiki sources (published by CI)

## OVERVIEW
The GitHub wiki is GENERATED from this directory: `wiki.json` maps page names to sources, `pages/` holds the hand-written markdown (EN + `.pt-BR`), and `tools/wiki/generate.py` assembles everything (also reusing `Documentation/` guides and `tools/README*.md` by path). `.github/workflows/wiki.yml` pushes the result to `Celer-Brasil/CelerOS.wiki.git` on every change to `wiki/`, `Documentation/` or the workflow itself that lands on main (PRs get a preview publish).

## RULES
- **Never edit the wiki through the GitHub web UI**: the next CI publish overwrites it. Edit here, commit, done.
- Most pages exist in pairs (`Page.md` + `Page.pt-BR.md`). Change one, change the other.
- A new page = new file(s) in `pages/` + an entry in `wiki.json` (`page` = wiki title, `src` = path). Order in `wiki.json` drives the sidebar order.
- Wiki content is user-facing documentation (flashing, boards, tools, app development). Internal agent knowledge lives in the AGENTS.md files, not here.

## PAGES AT A GLANCE
`wiki.json` is the page list (single source): Home, Supported-Boards, Building-and-Flashing, Troubleshooting, Architecture, System-Apps, Web-Interface, Tools, celerctl-USB, OTA-Updates, App-Development-Guide, JS-API, Contributing — each with a pt-BR mirror (Home-(Português), Placas-Suportadas, ...) — plus Robot-Dog/Robo-Cachorro, Waveshare-Watch/Watch-Waveshare and Watchface-Plugins/Plugins-de-Watchface. Guides like JS-API and App-Development-Guide are assembled from `Documentation/`, so edits there flow into the wiki too.
