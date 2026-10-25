# Agente de frota

[English](/Celer-Brasil/CelerOS/wiki/Fleet-Agent) | **Português (BR)**

O `celeros.agent` é o app de sistema opcional que transforma uma placa CelerOS
em nó gerenciado: roda `service.js` em background (API 50), manda heartbeat
para um plano de controle e aplica OTA assinado, atualização de apps, reboot ou
diagnóstico. Vem na imagem de fábrica de todas as placas e fica inativo até
existir um `/local/celercloud.json`.

O agente é público (o [repositório CelerOS](https://github.com/Celer-Brasil/CelerOS/blob/main/data/apps/Celer%20Agent));
o plano de controle é um serviço separado. O contrato é a dependência
`celeros.cloud` e o JSON abaixo — qualquer servidor que fale isso gerencia uma
frota.

## O que ele reporta

Cada heartbeat leva versão/API do firmware (preenchidas pelo `celeros.cloud`
via `System.getOSVersion()`/`getAPILevel()`), placa, uptime, inventário de apps
e capacidades:

| Cap | Significado |
|---|---|
| `agent` | este app está rodando |
| `ota` | o firmware consegue iniciar um OTA |
| `ota_signed` | o firmware valida a assinatura ECDSA P-256 do manifesto (CelerOS 1.11.6+) |
| `apps` | consegue atualizar apps instalados pelo hub |
| `reboot` | consegue reiniciar o aparelho |
| `private_hub` | há token de leitura da loja privada (`/local/hub_token.txt` ou `hubToken` na config) |

O plano de controle deve usar `ota_signed` para avisar sobre firmware antigo,
não para bloquear o primeiro upgrade: uma placa na 1.11.5 ainda pode receber a
imagem 1.11.6 assinada, e a partir dela todo manifesto é autenticado.

## Comandos

O plano enfileira um comando; o agente acka só os tipos que possui
(`open`/`close` pertencem ao app da vertical, não ao agente):

| Tipo | O que faz |
|---|---|
| `os_update` | `System.otaCheck` → `System.otaStart` com o manifesto do canal; manifesto recusado vira ack de falha |
| `update_apps` | `{packages:[pkg]}` ou todos: resolve o hub, baixa `app.zip`, confere MD5, `System.installZip`, regrava `deps.json` |
| `self_update` | atualiza o próprio `celeros.agent` e chama `Service.stop()`; o próximo boot roda o código novo |
| `reboot` | reporta e reinicia |
| `sync` | força heartbeat imediato |
| `diagnostics` | devolve firmware/API/placa/RAM/Wi-Fi/apps/OTA no evento |

Os comandos ficam persistidos em `/local/cloud_commands.json` até o ack, então
queda de rede ou reboot não os perde. O agente processa um por vez;
`updateBusy`/`shellActive`/Wi-Fi são gates, mas um app em foreground não bloqueia
um update explícito.

## Segurança

* O manifesto OTA é assinado com ECDSA P-256; o aparelho confere a assinatura e
  o SHA-256 do stream antes de trocar de slot. Manifesto HTTPS sem assinatura
  válida é recusado. A chave privada não está no repositório.
* Pacotes de app vêm só do hub configurado, com MD5 conferido antes do
  `installZip` atômico; o token da loja privada só é anexado a URLs desse hub.
* O serviço herda as permissões declaradas (`net`, `fs`, `system`) e as
  concedidas pelo dono; OTA/instalação/reboot exigem `system`.
* O segredo do aparelho nunca vai para logs ou eventos; o plano de controle só
  vê o hash.

## Setup

1. Grave uma imagem CelerOS que inclua o `Celer Agent` (1.11.0+; API 50).
2. Conceda: `celerctl shell "grant Celer Agent"`.
3. Grave `/local/celercloud.json` a partir do enrollment do plano:

```json
{
  "url": "https://<projeto>.supabase.co",
  "key": "<chave publishable>",
  "tenantId": "<uuid do tenant>",
  "deviceId": "<id do device>",
  "secret": "<segredo de uso único>",
  "kind": "totem",
  "heartbeatMs": 60000
}
```

4. Loja privada opcional: grave o token de leitura em `/local/hub_token.txt`
   (uma linha, escopo `private`, mesmo tenant).
5. Confira: `celerctl shell "svc list"` mostra o `Celer Agent` no ar; o próximo
   heartbeat preenche `caps`/`apps` no plano de controle.

## Evidência de bancada (2026-10-25)

* A 1.11.5 instalou um manifesto local 1.11.6 assinado; o plano viu
  `agent.os_update.done` no boot novo.
* A 1.11.6 recusou um manifesto 1.11.7 com assinatura inválida sem baixar o
  `firmware.bin`; o comando foi ackado como `agent.command.failed` e a placa
  ficou na 1.11.6.
* A mesma placa buscou o manifesto do hub por HTTPS e logou
  `manifesto assinado: assinatura confere`.
* `self_update` 1.0.0→1.0.3 e um app privado 1.0.0→1.0.1 foram instalados com
  `deps.json` preservado.

Veja a [API JS](/Celer-Brasil/CelerOS/wiki/API-JS) seção 50 para a superfície do
svchost e [Atualização OTA](/Celer-Brasil/CelerOS/wiki/Atualizacao-OTA) para o
formato do manifesto.
