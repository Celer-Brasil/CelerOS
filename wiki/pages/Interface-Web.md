# Interface web

[English](/Celer-Brasil/CelerOS/wiki/Web-Interface) | **Português (BR)**

Todo aparelho com Wi-Fi conectado roda um servidor web pequeno. Abra o IP
mostrado no app Web Server (ou no `celerctl info`) em qualquer navegador da
mesma rede para gerenciar arquivos, enviar firmware e assistir a tela ao
vivo.

## Autenticação

Todas as páginas ficam atrás de HTTP Basic Auth:

* usuário: **admin**
* senha: gerada por aparelho — aparece no app Web Server no dispositivo ou
  no `celerctl info` (campo `web_pass`).

A comparação é de tempo constante, e depois de várias tentativas falhas o
servidor responde `429 Too Many Requests` por 30 segundos. O tráfego é HTTP
puro na sua rede — trate a senha de acordo.

## Páginas

| Rota | O que faz |
|---|---|
| `/` | File manager: navegar/criar/enviar/baixar/apagar arquivos e editar texto na LittleFS (`/local`) e no SD (`/sd`) |
| `/update` | Página de upload de firmware (mesmo fluxo de Settings → Atualização do Sistema) |
| `/screen` | Espelho da tela ao vivo com toque remoto (veja abaixo) |

## Tela ao vivo (`/screen`)

O espelho consulta `/api/screen`, que devolve um quadro RGB565 comprimido
em RLE. No aparelho, o quadro é lido pela própria task da UI, alguns
blocos de linhas por vez em pontos seguros — a tela segue fluida enquanto
alguém assiste. Espere ~1–2 fps na CYD e bem mais na SmartDisplay (barramento
maior, PSRAM).

A página tem botões **Pause** e **Zoom 2x**, e clicar-e-arrastar no canvas
envia toques ao aparelho pela mesma fila do `celerctl tap` — o toque do
navegador vale exatamente como o do dedo. É também um jeito prático de
operar os alvos pequenos do toque resistivo da CYD.

Para scripts próprios, o endpoint cru também existe:

```bash
# um quadro (u16 w + u16 h + u8 fmt + pares RLE {u16 contagem, u16 rgb565}, LE)
curl -u admin:<senha> http://<ip-do-aparelho>/api/screen > quadro.bin

# injetar um toque (exige o header X-Celer-Request)
curl -u admin:<senha> -X POST -H "X-Celer-Request: 1" \
  "http://<ip-do-aparelho>/api/touch?d=1&x=200&y=91"   # d=0 solta
```

## Desligando

O servidor pode ser desligado pelo app Web Server no aparelho
(`System.webState(false)`); ele volta sozinho no próximo boot com Wi-Fi.
Sem credenciais salvas, o aparelho abre o portal cativo
`CelerOS-Setup-XXXX` — veja
[Solução de problemas](/Celer-Brasil/CelerOS/wiki/Solução-de-Problemas).
