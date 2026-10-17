# CelerNet — Design de produto da matilha CelerOS

**Português (BR)** · 2026-10-16 · Estado do código: API 41 (três pilares integrados) — CelerNet v3 na 37, recursos na 36/38, gateway USB na 39

Este documento define o CelerOS **como produto**: uma rede privada de
dispositivos — a **matilha** — na qual cada aparelho publica as features do
seu hardware (câmera, microfone, alto-falante, saídas GPIO que acionam relés,
sensores) como **recursos**, e qualquer membro — outro dispositivo **ou um
computador ligado por USB** — descobre e usa esses recursos com lease,
política e consentimento.

Três partes convivem aqui, e o texto separa com clareza:

| Parte | Marcação | O que é |
|---|---|---|
| Estado atual | *(sem marca)* | O que já roda no firmware (API 37), citado por `arquivo:linha` |
| Extensão de produto | **[PROPOSTA]** | O design novo: recursos genéricos, gateway USB, API Rust |
| Evolução | **[OPÇÃO]** | Menu de melhorias com custo/benefício, para decidir onda a onda |

---

## 1. Resumo executivo

> **Um OS, vários corpos.** Cada dispositivo CelerOS é um corpo da matilha.
> O que um corpo tem (uma câmera, um relé, um sensor de luz) a matilha toda
> enxerga — e usa — como um recurso nomeado, num ambiente fechado por chave
> de rede. O computador entra pela porta USB como mais um membro, com uma
> API Rust de primeira classe. Nada disso depende de nuvem.

O produto se apoia em **três pilares de um mesmo sistema** (integrados na
API 40/41), cada um com um papel só:

| Pilar | Papel | Peça |
|---|---|---|
| **CelerLink** | **confiança**: pareia por código de 6 dígitos e, a partir do bond, entrega a chave da matilha (convite selado) | `main/Bluetooth/CelerLink`, `main/Pack/Provision` |
| **CelerNet** + recursos | **malha**: flooding BLE cifrado (AES-CCM), presença por BEAT com caps, unicast multi-hop; recursos com lease (ResProto) e plano de dados ESP-NOW | `main/Bluetooth/CelerNet`, `main/Pack/Resources` |
| **HostLink** | **gateway**: o computador entra pelo cabo como **membro virtual** (`pc-XXXX`) e como cliente de recursos | `main/USBDevice/HostLink`, `UsbRes.h` |

O que os amarra:

- **Identidade única** (`main/Pack/PackId`): id do nó = 2 últimos bytes da
  MAC BT, nome persistente (`celernet_name`) — o mesmo no advertising do
  CelerLink, no BEAT da malha, no HELLO dos recursos e no `node` que o
  `CelerLink.scan()` devolve; o PC no cabo ganha `pcNodeOf(gateway)`.
- **Uma chave, três portas** (`Provision`): senha (`Pack.join`, `mesh join`,
  `celerctl mesh join`), convite selado pelo CelerLink (`Pack.invite`) e o
  cabo — todas terminam em `NetKeys` + `netChanged` (§5.7).
- **Pack como fachada JS**: `Pack.*` é a API do sistema; `CelerLink.*` e
  `CelerNet.*` seguem como camadas baixas (nada quebrou).

Extensões propostas neste documento:

4. **Recursos genéricos [PROPOSTA]**: tipar GPIO/relé e sensores como
   recursos de primeira classe, com metadados (unidade, faixa, esquema de
   parâmetros) e regras de segurança próprias de atuador.
5. **O computador na matilha [PROPOSTA]**: o dispositivo como gateway USB
   (S3) — novos opcodes no HostLink transportam o ResProto até o PC.
6. **API Rust `celernet` [PROPOSTA]**: crate que fala o protocolo do
   dispositivo (USB CDC/USJ ou bridge TCP) e expõe a matilha inteira como
   objetos Rust.

---

## 2. Princípios de produto

| Princípio | Consequência de design |
|---|---|
| **Offline-first** | Tudo funciona sem internet; o hub `os.celer.tec.br` é só loja/OTA. A matilha nasce e vive na sala do usuário. |
| **Privacidade por padrão** | Mic, câmera e (proposto) atuadores só abrem na rede **privada** (provisionada). A rede aberta "celer" serve de farol para descobrir quem quer entrar. |
| **O dono manda** | O uso local do hardware **revoga** sessões remotas na hora (`Resources::localClaim`, `Resources.cpp:1356`). O compartilhamento tem interruptor por recurso (`res_share_*`). |
| **Lease, não conexão** | Toda sessão de recurso vence sozinha (lease 20 s, renovada por KEEP). Se o cliente some, o recurso volta para a matilha sem estado órfão. |
| **Hardware modesto** | Frames de 31 B, mensagens de 434 B, 12 recursos por nó, 16 nós. O design cabe num ESP32 com 4 MB e num S3 com 8 KB de heap base. |
| **O PC é um membro, não um administrador** | Pela USB o PC fala o MESMO protocolo de recursos que um app JS fala pela malha. Privilégio extra nenhum. |

---

## 3. Arquitetura em camadas

```
        dispositivo A (ex.: watch)            dispositivo B (ex.: esp32-cam)
   ┌──────────────────────────────┐       ┌──────────────────────────────┐
   │  apps JS (Duktape ES5)       │       │  apps JS                     │
   │   Pack.snap("relogio")       │       │   Pack.expose("camera")*     │
   ├──────────────────────────────┤       ├──────────────────────────────┤
   │  Recursos (ResProto)         │ ◄────►│  Recursos (ResProto)         │
   │   controle: leases/OPEN/LIST │  malha│   provedores: CamRes/AudioRes│
   ├──────────────────────────────┤  BLE  ├──────────────────────────────┤
   │  DataLink (ESP-NOW)          │◄─────►│  DataLink (ESP-NOW)          │
   │   plano de dados 1470 B/quadro│ 1 hop│   bulk/stream (foto, PCM)    │
   ├──────────────────────────────┤       ├──────────────────────────────┤
   │  Pack (envelopes 'P')        │       │  Pack                        │
   ├──────────────────────────────┤       ├──────────────────────────────┤
   │  CelerNet v3 (malha BLE)     │◄─────►│  CelerNet v3                 │
   │   flood 31 B, BEAT, unicast  │       │                              │
   ├──────────────────────────────┤       ├──────────────────────────────┤
   │  CelerLink (host NimBLE)     │◄─────►│  CelerLink                   │
   │   código + bond -> convite   │ GATT  │   janela de convite          │
   └──────────────┬───────────────┘       └──────────────────────────────┘
                  │ USB / UART / bridge TCP          PackId: a mesma identidade
   ┌──────────────┴───────────────┐                 nos três pilares
   │  HostLink proto 2 + KL_RES_* │   gateway: PC = nó virtual pc-XXXX (§8.5)
   ├──────────────────────────────┤
   │  celerctl mesh/res · Rust    │   ← crate Rust [PROPOSTA] seção 9
   └──────────────────────────────┘
```

\* hoje a câmera é provedor nativo; `Pack.expose` é a via dos apps.

Regra de ouro do transporte, que o produto inteiro herda:

- **Controle** (ResProto) atravessa a malha multi-hop: um pedido de OPEN
  viaja como envelope `KIND_RES` do Pack (`Pack.cpp:198`), unicast flood com
  2 cópias e dedup por `msgId`.
- **Plano de dados** (áudio, foto, stream de sensor) é **ponto a ponto de
  1 hop** por ESP-NOW (`DataLink.h`): 1449 B úteis por quadro, sem roteador.
  Sem canal ESP-NOW comum, stream recusa com `REASON_NO_LINK`
  (`ResProto.h:80-82`) — a malha BLE (~100 B/s útil) não leva mídia.

---

## 4. CelerLink — o elo BLE

`main/Bluetooth/CelerLink.{h,cpp}`. É a infraestrutura NimBLE sob TODA a
parte sem fio de curto alcance: a malha rouba emprestado o advertising dele
para transmitir (`CelerNet.cpp:685-785`) e devolve o ar com
`refreshAdvertising()`.

### 4.1 Serviço GATT

- Serviço `b3a667a2-fdac-5298-8c13-89c980f2d1f1` (`CelerLink.cpp:45`):
  - caractere de mensagens `…d1f2` (write, write-no-rsp, notify);
  - caractere de pareamento `…d1f3` (READ = estado; WRITE = código ou
    resposta de bond).
- Mensagem máxima **240 B** (MTU preferido 256 − 3); **1 conexão** por vez
  (`boards/smartdisplay/sdkconfig.defaults:40-41`).

### 4.2 Pareamento por código (API 11, default desde a 14)

1. No CONNECT, o periférico gera um código de **6 dígitos**
   (100000–999999, `CelerLink.cpp:289`) e o expõe **somente ao app local**
   (`CelerLink.status().code`).
2. A central digita o código via `verify()`; orçamento de 3 s por
   tentativa, **3 erros derrubam** a conexão, timeout de 60 s.
3. A chave de bond nasce do código: `K = SHA256("CLK2" ‖ código ‖ desafio)[0:16]`.

### 4.3 Bond v2

- Blob NVS (`namespace "celer"`, chave `link_bonds2`, `CelerLink.cpp:107`):
  até **4 pares LRU** `{mac[6], chave[16]}`.
- Na reconexão o periférico manda um desafio novo de 8 B e a central prova
  posse da chave com `SHA256(K ‖ desafio)[0:8]` — o código nunca mais é
  digitado. 3 s de graça antes do código voltar à tela.
- **Canal selado (API 21)** para segredos: quadro `00 'S' 01 | nonce(12) |
  AES-128-GCM | tag(16)`, chave `SHA256("celer-seal-v1" ‖ bondKey)[0:16]`
  (`CelerLink.cpp:151-157`, `:389-400`). Mensagens comuns NÃO são
  criptografadas no enlace — quem farejou o pareamento original as lê.

### 4.4 Coexistência e ciclo de vida

- `CONFIG_CELEROS_PHONE_LINK` (só no watch) roda no MESMO host NimBLE:
  Gadgetbridge/Bangle.js (NUS `6e400001-…`, adv "Bangle.js xxxx"). Sem app
  no ar, o advertising visível é o do Phone Link (`CelerLink.cpp:460-483`).
- `appReset()` desconecta e limpa fila entre apps; a malha lê
  `appBusy()`/`linkActive()` para pausar o scanner (`CelerLink.h:111-125`).
- A malha **sobrevive** ao `appReset()`.

### 4.5 JS

`CelerLink.{start, scan, connect, verify, unpair, send, poll, sendSealed,
pollSealed, status}` (`main/Runtime/JsLink.cpp`).

---

## 5. CelerNet v3 — a malha

`main/Bluetooth/CelerNet.{h,cpp}`, `NetFrame.h`, `NetKeys.{h,cpp}`.
História: v1 (API 26) flood de 31 B broadcast-only; v2 (API 27) unicast com
DST, caps no BEAT, mensagens urgentes; **v3 (API 37) tudo cifrado e
autenticado** (`a82e9cb`).

### 5.1 O quadro no ar ("molde SIG")

Cada quadro é um ADV_NONCONN legado de **até 31 B** (`NetFrame.h:39-56`):

```
byte 0      'C'                       magic
byte 1      ver(4) | tipo(4)          ver = 3
byte 2      nid                       escolhe a chave no RX (HKDF da rede)
byte 3      ttl(4) | saltos(4)        EM CLARO, fora do MIC (relay não recifra)
bytes 4-10  seq24 | src16 | dst16     OFUSCADOS: XOR com AES-ECB(privKey, iv‖7B)
bytes 11+   dados cifrados AES-CCM + MIC(4)
```

- Tipos (`NetFrame.h:46-48`): `BEAT=0` (`[caps][flags][nome]`), `DATA=1`
  (mensagem ≤16 B), `FRAG=2` (`[índice|cópia(3b)][total][chunk ≤14 B]`).
- Uma mensagem de até **434 B** sai em até 31 fragmentos; as cópias de um
  unicast reutilizam a mesma `seqZero` (chave da remontagem) com seqs
  consecutivos (`NetFrame.h:317-321`).
- Nonce CCM de 13 B = `00|tipo|seq24|src|dst|iv32`; AAD = bytes 1-2. A
  ofuscação do cabeçalho copia o esquema de privacidade do BLE Mesh SIG.
- `relayPatch` troca só ttl/saltos sem recifrar — um relay não precisa (nem
  consegue) abrir o quadro.

### 5.2 Chaves — NetKeys

`main/Bluetooth/NetKeys.{h,cpp}`. Derivação determinística a partir de
**nome da matilha (1..15) + senha (≥8)**:

```
netKey   = PBKDF2-HMAC-SHA256(senha, "celernet:"+nome, 4096)  → 16 B (~0,3 s)
encKey   = HKDF(netKey, "enc")     AES-CCM (dados)
privKey  = HKDF(netKey, "priv")    AES-ECB (ofuscação do header)
adminKey = HKDF(netKey, "admin")   reservado a administração
nid      = HKDF(netKey, "nid")[0]  seleção de chave no RX
salt do HKDF: "celernet-v3"
```

- Um segundo aparelho entra na mesma matilha digitando o MESMO nome+senha —
  não há custo de sincronismo.
- A passphrase **não é armazenada**: NVS (`ns "settings"`) guarda
  `cn3_net` (nome), `cn3_key` (netKey hex), `cn3_seqm`/`cn3_seqn` (reservas
  de sequência).
- Rede aberta **"celer"**: chave fixa `SHA-256("celernet:celer:open-v3")[0:16]`
  — integridade sem sigilo (`NetKeys.cpp:135`). Até **2 redes ativas**: a
  privada como primária e a aberta como secundária para caçar nós
  "aceitando matilha" (`BFLAG_UNPROV`); quadro autenticado só na secundária
  é contado, mas **não entregue** (`CelerNet.cpp:1347`).
- Entrada sem senha: `NetKeys::joinWithKeys(nome, netKey, adminKey)` — um
  nó provisionado pode provisionar outro (hoje só interno; ver §12-c).

### 5.3 Presença e descoberta

- **BEAT a cada 3 s** (`K_BEAT_MS`) carrega `[caps][flags][nome]`. Nó id =
  2 últimos bytes da MAC BT; nome default `Celer-XXXX`.
- Tabela de **16 nós**, expiração 15 s sem prova de vida (teto 4×TTL
  enquanto o próprio TX está pendente). Prova de vida = BEAT **ou** o HELLO
  autenticado do ESP-NOW (5 s, `CelerNet::touchAlive`): com o WiFi no ar o
  coex entrega ~metade dos BEATs e o vizinho saía e voltava a cada 1–2 min
  (bancada 2026-10-17). O HELLO só renova um nó já ouvido — nome, caps,
  saltos e RSSI seguem vindo do BEAT. Discovery é **passivo**: aparece quem você
  ouve; caminho mais curto fresco vence (hops/RSSI).
- Endereçamento aceita id `A1B2` (4 hex) ou **nome** case-insensitive
  (`CelerNet.cpp:1017`).
- Caps (bitmask, `NetFrame.h:59-65`): `SPEAKER 0x01, MIC 0x02, DISPLAY
  0x04, MOTORS 0x08, LEDS 0x10, HUB 0x20, CAMERA 0x40` — derivadas do
  perfil da placa e publicadas no BEAT.
- Presença redundante por ESP-NOW: `OP_HELLO` broadcast a cada 5 s
  (`ResProto.h:52-56`) alcança quem a malha BLE não ouve (esp32-cam em coex).

### 5.4 Tráfego: flood, unicast, cópias

- **Token bucket**: 16 fichas de rajada, 8/s — limita o roubo do
  advertising conectável (`CelerNet.cpp:243`).
- Fila TX/relay de **96 quadros** na PSRAM, tudo-ou-nada por mensagem.
- Relay: jitter `40 + ttl*40 + rand(200)` ms; FRAG atrasa a rajada inteira
  (`deferFragRelays`); supressão se vizinho do mesmo nível repetiu com
  RSSI ≥ −60.
- **Unicast com cópias** (1..3, default 2): cada cópia sai com seq novo,
  espaçada ~1,5 s. Sem ACK — a confiabilidade vem da cópia + dedup.
- Scanner passivo contínuo 10/10 ms; duty 100/30 ms com enlace GATT vivo;
  bits de coex WiFi×BLE configuráveis.
- Anti-replay: janela deslizante de 64 seqs por (rede, origem), commit
  **depois** do MIC (`NetFrame.h:210-280`). Seqs de 24 bits reservadas em
  blocos de 4096 no NVS para o nonce nunca repetir após reboot.
- Remontador: 4 slots, junta fragmentos de qualquer cópia pela chave
  (src, seqZero), slot vence em 6 s.

### 5.5 Limites e tempos (bancada)

| Parâmetro | Valor |
|---|---|
| Mensagem máxima | 434 B (31 frags × 14 B) |
| Taxa útil da malha | ~100 B/s (ordem de grandeza; token bucket 8/s × 31 B) |
| BEAT / expiração | 3 s / 15 s (teto 4×) |
| Lease de recurso | 20 s, KEEP urgente a cada 5 s |
| Retry de OPEN | 2500 ms × 5 tentativas |
| Nós / recursos por nó / leases por nó | 16 / 12 / 8 |
| Auto-start da malha | após 45 s de boot (com Phone Link; 10 s sem); **não** no 2º boot seguido após crash/WDT (contador na RAM RTC, zera com 120 s de malha no ar) — um WDT isolado (o `esp_restart` do OTA às vezes sai assim) não derruba mais a malha até o próximo boot limpo |
| Tuning de bancada | `/local/celernet_tune.txt`: `adv= defer= suppress= coex=` |

### 5.6 Entrada no produto

- Shell serial `mesh join <nome> <senha≥8>`, `mesh leave`, `mesh selftest`,
  `mesh replay`; desde a API 40 o app **Matilha** tem a tela Entrar (nome +
  senha, aguardar convite, convidar) e o cabo tem `celerctl mesh join` —
  ver §5.7.
- JS: `CelerNet.{start, stop, broadcast, sendTo, poll, nodes, status}`
  (`JsMesh.cpp`); envelopes de kernel via `Pack.*` (`JsPack.cpp`).

### 5.7 As três portas da matilha (API 40)

`main/Pack/Provision.{h,cpp}` é o caminho único da chave:

| Porta | Quem usa | Como |
|---|---|---|
| **Senha** | `Pack.join(nome, senha)` (perm `system`), shell `mesh join`, cabo `SUB_JOIN` | `joinPassword` = `NetKeys::join` (PBKDF2) + `CelerNet/Resources::netChanged` |
| **Convite** | app Matilha nos dois aparelhos | o novo abre a janela (`Pack.acceptInvite`, 10 min: CelerLink anunciando com gate de código); o membro conecta, digita o código e chama `Pack.invite()` — INVITE selado com o bond (`ProvProto.h`: nome + netKey + adminKey, ≤ 53 B) → `joinWithKeys` → ACK selado |
| **Cabo** | `celerctl mesh join` (placas sem tela) | `KL_RES_CTL SUB_JOIN` → `joinPassword`; ato de dono, independe do `res_share_usb` |

- A chave nunca passa pelo JS nem volta ao PC. O tap selado do CelerLink
  (`setSealedTap`) consome todo quadro `CNJ` antes do `pollSealed` do app.
- O convidador acha o novo pelo **scan do CelerLink** (nome na janela de
  convite). A rede aberta secundária com `BFLAG_UNPROV` segue reservada.
- **Convite sem tela** (API 41), nos mesmos 2 passos da UI (o código só
  nasce quando o membro conecta): `mesh accept` no novo (shell ou
  `celerctl mesh accept`, o código sai no `mesh`/`SUB_NET`) e `mesh invite
  <alvo>` + `mesh code <6>` no membro (`celerctl mesh invite <alvo> --de
  <porta do novo>` lê o código pelo cabo). Peer com **bond** de um
  pareamento anterior entra sem código (a reconexão é pelo desafio do bond).
- A esp32-cam **não usa o convite**: com a câmera aquecida sobram ~35 KB de
  RAM interna e o NimBLE pede 39 KB — ela é membro só por ESP-NOW e entra
  pela senha (cabo ou console).

---

## 6. Recursos da matilha — estado atual (API 36)

`main/Pack/{Pack,Resources,ResProto.h,DataLink,CamRes,AudioRes}.*`.
O servidor de recursos de cada nó mantém até **12 recursos locais**
(`s_local[12]`, `Resources.cpp:150`) e **8 leases**
(`LeaseTable<8>`, `ResProto.h:394`).

### 6.1 Opcodes de controle (payload do envelope `'P' KIND_RES`)

| Op | Valor | Direção | Corpo |
|---|---|---|---|
| DESCRIBE | 1 | cli→srv | vazio |
| LIST | 2 | srv→cli | `[n u8] n×[type u8][flags u8][nlen u8][nome ≤15]` |
| OPEN | 3 | cli→srv | `[req u8][nlen][nome][plen u8][params ≤48][link 8]` |
| ACCEPT | 4 | srv→cli | `[req u8][sid u16][leaseDs u16][transp u8][chan u8][mac 6][token u32]` |
| REFUSE | 5 | srv→cli | `[req u8][motivo u8]` |
| KEEP | 6 | cli→srv | `[sid u16]` |
| CLOSE | 7 | cli→srv | `[sid u16]` |
| REVOKE | 8 | srv→cli | `[sid u16][motivo u8]` |
| DATA | 9 | ambos | `[sid u16][seq u16][bytes ≤425]` |
| HELLO | 10 | broadcast ESP-NOW | `[caps u8][nlen u8][nome]` |

Tipos: `DATA=0, MIC=1, SPEAKER=2, CAMERA=3`. Flags do LIST:
`BUSY 0x01, SHARED 0x02, READY 0x04`. Motivos de REFUSE/REVOKE:
`notFound busy policy unsupported full local gone expired noLink`
(`ResProto.h:59-82`).

Contrato de sessão (é o coração do produto):

- **Sessão = lease** de 20 s (décimos de segundo no fio). Cliente renova
  com KEEP urgente a cada lease/4; servidor devolve o recurso sozinho quando
  o cliente some (`expireOne` → `providerStop`).
- `KEEP` de sessão desconhecida volta `REVOKE expired` e o cliente **reabre
  com o mesmo handle** — reboot do servidor é transparente.
- O OPEN vai **pelo nome** ("mic", "speaker", "camera" ou o canal do app);
  LIST é otimização (cache 30 s no cliente).
- O `link 8` do OPEN (`[flags][chan][mac 6]`) deixa o SERVIDOR escolher o
  transporte da sessão: ESP-NOW direto se os dois têm enlace e canal comum;
  senão a própria malha (`chooseTransport`, `ResProto.h:135-144`). O ACCEPT
  carrega `token u32` que autentica todo quadro ESP-NOW da sessão.
- `DataLink` (ESP-NOW): quadro de **1470 B** (1449 úteis), kinds
  `DATA/STREAM/BULK/BULK_ACK/CTRL`, AES-CCM com a encKey da rede, nonce =
  MAC de origem + seq32, anti-replay por (rede, MAC) (`DataLink.h:19-44`).

### 6.2 Provedores nativos

| Recurso | Tipo | Arbitragem | Plano de dados |
|---|---|---|---|
| `mic` | MIC, exclusivo | policy `res_share_mic` (default 1) + privada | STREAM PCM16 mono 16 kHz, blocos 16 ms/512 B (`AudioRes.cpp`) |
| `speaker` | SPEAKER, exclusivo | `res_share_spk` | STREAM → `PcmFeed` com 160 ms de jitter |
| `camera` | CAMERA, exclusivo | `res_share_cam` + privada, gated `CONFIG_CELEROS_JS_CAMERA` | foto: BULK confiável (blocos ≤1400 B + BULK_ACK bitmap, 4 rodadas, até 358 KB); vídeo fps 1..10 sem reenvio (`CamRes.cpp`) |
| canais de apps | DATA, shared | sem policy | DATA pela malha ou ESP-NOW |

- `Pack.expose(nome, shared)` registra canal de dados do app; sai com
  `appReset()` via `REVOKE "gone"` (`Resources.cpp:1454`, `:1588`).
- Política do dono (`policyAllows`, `Resources.cpp:378`): (a) mic/camera
  **só em matilha privada** (`NetKeys::provisioned()`); (b) interruptor
  `res_share_mic/spk/cam` (default "1", só via shell hoje). O dono recebe
  **notificação informativa** "em uso por X" — não é pedido de consentimento.
- Uso local ganha: `Mic.start`/`Camera` locais revogam as sessões remotas
  (`localClaim`, `Resources.cpp:1356`).

### 6.3 JS

`Pack.{resources, open, status, read, write, close, expose, unexpose,
publish, sessions, pollWrite, listen, speak, record, recording, level,
recordStop, snap, view, drawFrame}` (`JsPack.cpp`; documentado na seção 41
do `JS_API_Guide`). Abrir mic/câmera **remotamente** exige as mesmas
permissões locais do app (`gpio`/`mic`/`camera` em `app.json` + consentimento
no launcher).

### 6.4 Lacunas do estado atual (motivam as próximas seções)

1. Só existem 4 tipos; **sensor, GPIO/relé e display não são recursos** —
   um relé só é acionado por app rodando NO próprio nó
   (`System.relay*`, `JsGpio.cpp`, gated `PERM_GPIO`).
2. `Entry` não tem id estável, unidade, faixa nem esquema de params; nome
   ≤15 B; params do OPEN são JSON ad-hoc de 48 B (`"fps"`, `"q"`).
3. Sem autorização por identidade: qualquer membro da matilha privada passa;
   política = 1 bit global por tipo.
4. Streams são 1-hop ESP-NOW; a malha multi-hop não leva mídia.
5. ~~O PC não participa~~ — resolvido pelo gateway USB (B.1, API 39) e
   pelo nó virtual (§8.5, API 41). O `matilha mesh` (nó BLE cru em
   NetFrame v2, sem a cripto da v3) saiu na API 41: um caminho só para o PC
   na malha, o gateway. O `tools/matilha` ficou como cliente do CelerLink.

---

## 7. [PROPOSTA] Recursos genéricos — "feature como recurso"

A ideia central do produto: **qualquer feature do hardware vira recurso
publicado**, com o mesmo ciclo OPEN→ACCEPT→lease→DATA→CLOSE. Três peças:
tipos novos, metadados no catálogo e provedores nativos.

### 7.1 Tipos novos

```
TYPE_GPIO   = 4   // saídas digitais e relés; também entrada digital sob demanda
TYPE_SENSOR = 5   // leitura periódica ou sob demanda, com unidade e faixa
TYPE_DISPLAY= 6   // opcional (onda futura): texto/notify num display remoto
```

### 7.2 Metadados no catálogo (LIST v2)

O LIST atual não tem onde caber unidade/faixa. Proposta **retrocompatível
por opcode**: o cliente que entende metadados pede com opcode novo.

```
OP_DESCRIBE_META = 11   cli->srv  vazio          (cliente moderno)
OP_LIST_META     = 12   srv->cli  [n u8] n×{ [type][flags][nlen][nome]
                                    [mlen u8] mlen×TLV }        (se mlen>0)
TLV: [tag u8][len u8][valor]
  TAG_UNIT   = 1   ASCII curto ("C", "%", "kPa", "lx")      (sensor)
  TAG_RANGE  = 2   [min f32][max f32] LE                    (sensor/gpio pwm)
  TAG_SCHEMA = 3   JSON curto descrevendo params do OPEN    (todos)
  TAG_VER    = 4   [u8] versão do esquema do recurso
```

- Clientes velhos continuam mandando `DESCRIBE` e recebendo LIST simples —
  nenhum quadro muda de formato, nada quebra.
- `TAG_SCHEMA` padroniza os params de 48 B do OPEN, que hoje são ad-hoc
  (`paramInt` entende só `fps`/`q`, `Resources.cpp:410`).
- Teto honesto: `ENV_PAYLOAD=430` B dá para ~6 recursos com metadados cheios
  num LIST; o DESCRIBE continua sendo por nó, e o cache do cliente já é 30 s.

### 7.3 GPIO / relé (TYPE_GPIO)

**Registro.** Provedor nativo `GpioRes` (C++, `main/Pack/GpioRes.*`),
registrado por perfil de placa no `Resources::init`:

- Cada **relé** do SKU vira um recurso nomeado e exclusivo: `rele1`,
  `rele2`, … (nomes podem ser customizados em NVS pelo dono: `rele1 → bomba`).
- Um recurso genérico `gpio` (exclusivo) expõe os pinos livres para
  digital IO avançado (pwm, pulso) — o mesmo conjunto que `System.gpio`
  já guarda com `gpioDeniedMask`/pinos reservados (`JsGpio.cpp:42-63`).

**Params do OPEN** (o `TAG_SCHEMA` descreve; ≤48 B):

```json
{"pin":26,"mode":"out","off":0}          // gpio genérico
{"off":1}                                // rele1: auto-off ao fim do lease
```

**DATA ops** (payload do frame DATA da sessão):

```
[1][0|1]        WRITE  (aciona)
[2]             READ   → resposta [2][0|1]
[3][ms u16]     PULSE  (pulso com auto-retorno)
[4][duty u16]   PWM
```

**Segurança de atuador** (diferencial de produto — relé é física real):

- Exclusivo **por padrão** (duas pontas não brigam pela bomba).
- **Auto-off**: com `off:1` no OPEN, o fim do lease (expiração, CLOSE ou
  REVOKE) devolve o pino ao estado seguro — a matilha inteira pode cair
  que o relé desliga. É o mesmo contrato de lease que já devolve a câmera,
  agora com consequência física.
- **Local sempre ganha**: `localClaim` estendido para gpio — `System.relay`
  no próprio nó revoga a sessão remota na hora.
- **Privada + interruptor NOVO default "0"**: `res_share_gpio` nasce
  DESLIGADO (mic/cam nascem ligados por serem leitura passiva de uso
  esperado; atuar é diferente). Notificação no dono a cada abertura.
- `Pack.open(no, "rele1")` em JS exige perm `gpio` do app, igual a mic/cam.

### 7.4 Sensores (TYPE_SENSOR)

**Registro.** Provedor nativo `SensorRes`: por perfil de placa, registra
as leituras que o firmware já tem (ADC livre, e no futuro I2C — BME280 etc.):
`temp`, `lum`, `bat`, … Cada um com `TAG_UNIT`/`TAG_RANGE`.

**Semântica.** Compartilhado (N leituras simultâneas não brigam). O
cliente abre com `{"rate":ms}` (0 = sob demanda) e recebe DATA periódico:

```
[ts u32][valor f32 LE]     (unidade no TAG_UNIT do catálogo)
```

Na malha (transporte BLE) o rate mínimo prático é ~1 Hz; via ESP-NOW ou USB,
até 10 Hz. O provedor com `rate>0` só amostra com assinante vivo (lease).

**JS**: `Pack.open(no,"temp",{rate:1000})` + `Pack.read(h)`; atalho
proposto `Pack.sensor(no, nome, cb)` na onda de eventos (§12-b).

### 7.5 Registro por apps

`Pack.expose` ganha metadados opcionais — o app que publica um canal de
dados pode declarar unidade/esquema, e vira cidadão de primeira classe no
catálogo (o PC enxerga `Pack.expose("estufa/lampada")` como TYPE_GPIO de
app se ele seguir o esquema de ops de gpio — convenção, não runtime).

---

## 8. [PROPOSTA] O computador na matilha — USB device (S3)

### 8.1 Modelo: o dispositivo é o gateway

O PC **não fala BLE**. Ele fala com UM dispositivo CelerOS pela porta USB
device (existente só nas S3: watch = CDC nativo ~110 KB/s, dog = USJ
~113 KB/s; as placas ESP32 clássicas continuam UART/CH340), e esse
dispositivo **proxya** o ResProto: responde pelo que é dele e pelo que
enxerga na malha.

```
PC (crate Rust) ──USB CDC/USJ──► dispositivo gateway ──malha BLE/ESP-NOW──► nós
      KL_RES_*                       (HostLink proto 2)        ResProto
```

O PC vira **membro virtual da matilha**: o gateway aloca um node id
sintético (faixa reservada `0xFF00..0xFFFE` — ids reais são 2 bytes de MAC
BT, em que essa faixa é improvável; na colisão o gateway escolhe outro id),
insere o PC na tabela de presença do
CelerNet local e no mapa de links do Resources. Apps na malha podem mandar
**para** o PC (`Pack.sendTo("pc")` chega como evento no Rust) — o PC não é
só consumidor.

### 8.2 Novos opcodes no HostLink

`main/USBDevice/HostLink.h:115-151` é a fonte única da tabela (o
`celerctl.py` extrai por regex; firmware velho responde "opcode
desconhecido" e o host degrada com graça). `KL_STATS=0x20` é o último;
a partir daí está livre:

| Opcode | Nome | Direção | Papel |
|---|---|---|---|
| `0x21` | `KL_RES_CTL` | host→dev, dev→host | Controle ResProto (req/resp síncrono, estilo `KL_DEBUG_CTL`) |
| `0x22` | `KL_RES_DATA` | dev→host, não-solicitado | Dados de sessão (stream/bulk/eventos), entra na `push_queue` como LOG_DATA/DEBUG_DATA |

**`KL_RES_CTL`** — payload: `[subop u8][reqId u8][len u16][corpo]`;
resposta com o MESMO opcode: `[status u8][reqId u8][len u16][corpo]`
(o status u8 é a convenção de todo opcode do HostLink, `HostLink.h:22`).
Subops espelham o ResProto:

```
SUB_DESCRIBE=1  → corpo: vazio | [flags u8] do gateway
SUB_LIST     =2  → LIST do gateway (locais)
SUB_MESH_LIST=3  → [nid u16] | LIST de um nó da malha (gateway proxya DESCRIBE)
SUB_OPEN     =4  → corpo = OPEN ResProto integral (com link sintético)
SUB_KEEP     =5  → [sid u16]
SUB_CLOSE    =6  → [sid u16]
SUB_WRITE    =7  → DATA host→gateway: [sid u16][seq u16][bytes ≤8100]
SUB_JOIN     =8  → [nlen][nome][plen][senha] entra na matilha (API 40)
SUB_LEAVE    =9  → volta à rede aberta (API 40)
SUB_NET      =10 → [flags]? → JSON {net, prov, node, name, pc, invite, code} (API 40; flag NET_ENTER = o PC entra como nó virtual)
SUB_SEND     =11 → [to u16][payload] envelope DO PC (nó virtual, API 41)
SUB_OPEN_AT  =12 → [node u16][nlen][nome][plen][params] -> [h] (API 41)
SUB_HWRITE   =13 → [h][bytes] DATA no recurso remoto (API 41)
SUB_HCLOSE   =14 → [h] (API 41)
SUB_POLL     =15 → [OPÇÃO] drena eventos pendentes (o RES_DATA cobre)
SUB_CONFIG   =16 → [OPÇÃO] [bits u8]: p.ex. auto-KEEP configurável
```

**`KL_RES_DATA`** — payload: `[sid u16][seq u16][bytes]` (formato DATA do
ResProto). Frames BULK/BULK_ACK do CamRes trafegam por aqui quando a
sessão é com o PC (o Rust reenvia o bitmap, mesma semântica de 4 rodadas).

**Sessão no fio**: o ACCEPT para um cliente-USB devolve
`transp=TRANSPORT_USB=2` (constante nova); o gateway registra o lease com
`link = {flags: LINK_UP|LINK_LOCKED, mac sintético}` — para o servidor de
recursos, o PC é um par ESP-NOW cujo cabo é o USB. Toda a mecânica de
lease/keep/expiração é **reaproveitada sem mudança**.

### 8.3 Segurança

- Posse física da porta USB = posse do canal (já é o modelo do shell/celerctl
  hoje). O diferencial: **acesso a recursos é gated pelas MESMAS políticas
  da malha** — mic/câmera/sensor exigem o gateway **provisionado** numa
  matilha privada; GPIO exige `res_share_gpio=1`; a camada USB tem o seu
  interruptor mestre `res_share_usb` (default **"0"**, ligada junto com o
  join: `mesh join` sugere `set res_share_usb 1`).
- O dono recebe notificação "PC Kxxxx usando câmera" como recebe de um nó.
- Limite: a sessão HostLink é única por device (último HELLO ganha,
  `HostLink.cpp:1037-1082`) — dois PCs não falam com o mesmo device ao
  mesmo tempo; o segundo recebe "sessao ativa em outro canal".
- Queda do enlace: o modo link da UART/USJ caduca em 8 s sem frames (o
  Rust mantém HELLO de keepalive < 8 s); CDC cai junto com o cabo. Em
  ambos os casos o gateway fecha os leases do PC — e o auto-off do §7.3
  desliga o relé.

### 8.4 Limites honestos (o que funciona na onda B e o que fica para depois)

| Cenário | Onda B (proposta mínima) | Depois |
|---|---|---|
| Recursos DO gateway (mic, câmera, gpio, sensor do próprio device) | ✅ completos, inclusive stream (foto/PCM por `KL_RES_DATA`) | — |
| LIST/descoberta da malha inteira | ✅ (proxya DESCRIBE/LIST a cada nó) | — |
| Recursos de OUTROS nós, controle | ✅ (OPEN/KEEP/CLOSE proxyados pela malha) | — |
| Recursos de OUTROS nós, dados (stream 1-hop ESP-NOW) | ⚠️ só se o gateway dividir canal ESP-NOW com o nó; senão `REASON_NO_LINK` (a regra que os apps já vivem) | §12-e: gateway puxa e re-chunka por USB |
| PC como destino de `Pack.sendTo` | ✅ (nó virtual + `KL_RES_DATA` de evento) | subscrição filtrada |

### 8.5 O PC como nó virtual (API 41)

Com a sessão HostLink viva, `res_share_usb=1` **e** o PC tendo pedido
(`SUB_SEND`, `SUB_OPEN_AT`, `SUB_SNAP/REC/PLAY_AT` ou `SUB_NET` com
`NET_ENTER` — o `mesh listen`), o gateway põe o PC na matilha
(`Resources::usbProxySync` → `CelerNet::setProxy`). Só a sessão não basta:
cada `celerctl info` fazia o `pc-XXXX` entrar e sair nos vizinhos. O pedido
vale até a sessão acabar.

- **Id e nome**: `packid::pcNodeOf(gateway) = 0xFF00 | byte baixo` (0xFFFF
  vira 0xFFFE), nome `pc-XXXX` (XXXX = id do gateway). Substitui o 0xFFFE
  fixo da B.1 — dois gateways na mesma matilha não colidem (salvo bytes
  baixos iguais).
- **Presença**: BEAT extra com `src = pc`, caps `HUB` e `BFLAG_PROXY = 0x04`;
  mesmo contador de seq do gateway (o nonce inclui o src: sem reuso). Os
  vizinhos listam `pc-XXXX` em `Pack.members()`. Cabo fora = BEAT para e o
  membro expira.
- **Para o PC**: `mine` da CelerNet inclui o id do proxy; o Pack desvia
  envelope custom (dedup por msgId) ou mensagem crua para uma fila (PSRAM,
  no 1º uso) e o tick manda pelo cabo — nunca chega aos apps do gateway.
  No gateway, `"pc"` resolve para o proxy e a entrega é local.
- **Do PC**: `SUB_SEND` → `Pack::sendAs(pc, ...)` → `CelerNet::sendFrom`.
- **Recursos de outros nós** (controle da B.2): `SUB_OPEN_AT` faz o gateway
  ser **cliente por procuração** (`Resources::open`, retry/KEEP/reabertura
  de sempre; até 2 handles do PC). Resposta = handle; resultado e DATA
  chegam como eventos. A troca de app não fecha procurações; a queda do
  cabo fecha (auto-off no dono).
- **Eventos** (`KL_RES_DATA` com sid 0 — 0 é o "livre" das sessões):
  `EV_MSG [from][nn][nome][raw][payload]`, `EV_STATE [h][state][reason][node]`,
  `EV_DATA [h][bytes]`.
- CLI: `celerctl mesh status|join|leave|accept|invite|send|listen`,
  `celerctl res relay -n <nó> rele1 on`.
- **Mídia de outros nós pelo cabo** (API 41), no padrão do celerctl — por
  arquivo no gateway: `SUB_SNAP_AT` (foto → `PC_SNAP_PATH`), `SUB_REC_AT`
  (mic → WAV em `PC_REC_PATH`), `SUB_PLAY_AT` (o PC manda PCM16 16 kHz em
  `PC_PLAY_PATH` e o gateway toca no speaker do outro nó, no ritmo do tempo
  real). O fim chega em `EV_STATE done`; o celerctl baixa/envia pelo
  READ/WRITE de sempre (`res snap|rec|play -n <nó>`). O WAV é convertido no
  PC: o device não tem um segundo parser de WAV.
- **Robustez do cabo**: o tempo dentro de um handler longo não conta como
  ócio do host; quem só espera (listen, `--segura`) manda keepalive a cada
  3 s; todo laço do celerctl guarda os frames sem pedido (`PUSH_CMDS`, os
  eventos do nó virtual inclusive).

### 8.6 Transporte padronizado: malha + ESP-NOW (API 41)

- **Todo envelope do Pack** (custom, música — e as mensagens do e para o
  PC) sai pela malha BLE **e** por uma cópia ESP-NOW (`KIND_ENV`, token =
  destino) quando o ESP-NOW está de pé — como o controle dos recursos já
  fazia. O `msgId` deduplica. Bancada: com WiFi no AP, a malha entregou ~25%
  dos quadros entre duas 4848; com a cópia, 19/19 pings ao PC.
- **Caça de canal**: nó fora de AP (canal livre), sem sessão ESP-NOW e sem
  ouvir a matilha há 20 s varre 1..13 (400 ms) com `HELLO` + `HELLO_HUNT`;
  quem ouve responde na hora e o caçador fica no canal. Bancada: a esp32-cam
  fora do AP achou o canal 9 das 4848 sozinha e serviu foto e vídeo.

**Status (Onda B.1, API 39):** a B.1 pousou com o fio desta seção — `KL_RES_CTL=0x21`/`KL_RES_DATA=0x22`, subops `DESCRIBE/LIST/MESH/OPEN/KEEP/CLOSE/WRITE` (os TLVs do `POLL`/`CONFIG` ficaram para a B.2: o `RES_DATA` não-solicitado cobre o poll e o auto-KEEP do gateway é fixo), PC como cliente com node `0xFFFE` e transporte `TRANSPORT_USB`, auto-KEEP no gateway, queda do cabo = `usbSession(false)` = leases mortos (auto-off), master `res_share_usb` (default "0", `cfg res_share_usb 1`). O catálogo da malha vem do cache (`SUB_MESH`). **A B.2 pousou na API 41**: OPEN de recursos de OUTROS nós proxyado pelo gateway (`SUB_OPEN_AT`) e mídia por arquivo (`SUB_SNAP_AT`/`SUB_REC_AT`/`SUB_PLAY_AT` — foto, mic e speaker de outro nó, §8.5). A CLI do `celerctl` (`res ls/relay/sensor/...`) é o veículo de bancada da B.1; a crate Rust segue sendo a onda C.

---

## 9. [PROPOSTA] API Rust — crate `celernet`

### 9.1 Camadas

```
┌─────────────────────────────────────────────────────────┐
│ alto nível: Device, Relay, Camera, Sensor, Mic, Nodes   │  ergonômico
├─────────────────────────────────────────────────────────┤
│ cliente ResProto: leases, keep, retry, remontagem bulk  │  protocolo
├─────────────────────────────────────────────────────────┤
│ framing HostLink: 0x43/CRC32/janela/resync/filters      │  transporte lógico
├─────────────────────────────────────────────────────────┤
│ trait Transport: SerialTransport · BridgeTransport      │  bytes
│   (serialport: CDC/USJ/UART)  (TCP 5555 + AUTH + probe) │
└─────────────────────────────────────────────────────────┘
```

- **Framing** reimplementa o proto 2 (`HostFrame.h`): magic `0x43`,
  CRC32 `0xEDB88320` (= `crc32` do zlib — `crc32fast` serve), HELLO
  `"CELERCTL2"` negocia proto 2, janela deslizante nos ops chunked,
  resync por silêncio (250 ms só na UART), roteamento de frames
  não-solicitados (`LOG_DATA`→log, `DEBUG_DATA`→debug, `KL_RES_DATA`→
  stream de recursos), **keepalive HELLO a cada 3 s** (o modo link da
  UART/USJ caduca em 8 s).
- **`BridgeTransport`** fala o DebugBridge TCP/UDP 5555: banner
  `CELERBRIDGE 1 …`, `AUTH <token>`, probe UDP `CELERPROBE1` para
  descoberta na LAN — útil quando o device está na parede e o PC na mesa.
- **ResProto client** replica a máquina de estados do lado cliente do
  firmware (`Resources.cpp`): retry de OPEN 2500 ms × 5, KEEP a cada
  lease/4, reabertura transparente em `expired`, remontagem de BULK com
  bitmap de ACK.

### 9.2 Superfície (blocking core; feature `tokio` para async)

```rust
use celernet::{devices, GpioOp};

// descoberta: varre seriais (VID 0x303A/0x1A86/0x10C4) e faz probe UDP 5555
for d in devices()? {
    println!("{} {}", d.port, d.info.board);      // confirma com HELLO
}

let dev = celernet::open("/dev/ttyACM0")?;        // ou by_serial("K44A1…")
println!("{}", dev.info()?.api_level);            // 37

// ── recursos: locais + da malha inteira (gateway proxya DESCRIBE_META)
for r in dev.resources()? {
    println!("{}:{} {:?} {:?} {}", r.node, r.name, r.ty, r.flags, r.unit_or("-"));
}

// ── relé: lease exclusivo com auto-off; drop() = CLOSE
let mut bomba = dev.relay("bomba")?;              // OPEN rele1, off:1
bomba.on()?;                                      // WRITE 1
std::thread::sleep(std::time::Duration::from_secs(30)); // KEEP automático em background
bomba.off()?;
drop(bomba);                                      // recurso devolvido

// ── câmera (do gateway ou de um nó da malha, ex.: "cam")
let cam = dev.camera_on("cam")?;                  // OPEN camera no nó cam
cam.snap("foto.jpg")?;                            // BULK confiável → arquivo
let fps = cam.view(2)?;                           // 2 fps, frames JPG no callback

// ── sensor com stream
let mut t = dev.sensor("temp")?.rate_ms(1000)?;   // OPEN {"rate":1000}
t.stream(|v| println!("{:.1} {}", v.value, v.unit))?;   // "23.4 C"

// ── mic/speaker remotos (PCM16 16 kHz) e canais de app
let mic = dev.listen_on("relogio")?;              // PCM do watch no PC
let ch  = dev.channel("estufa/log")?;             // TYPE_DATA de um app
ch.send(b"deploy ok")?;

// ── malha: presença e eventos que chegam AO PC (nó virtual)
for n in dev.mesh_nodes()? { println!("{} hops={} caps={:?}", n.name, n.hops, n.caps); }
dev.on_mesh_event(|ev| println!("{:?} {}", ev.from, ev.text))?;  // Pack.sendTo("pc")
```

Erros: `CelernetError::{Transport, Protocol, Refused(Reason)}` — `Reason`
espelha 1:1 os `REASON_*` do ResProto (`notFound`, `busy`, `policy`,
`noLink`, …), para o cliente saber se vale reabrir.

### 9.3 CLI companion (`cnet`, binário da mesma crate — [OPÇÃO])

```
cnet devices                     # USB + LAN (probe 5555)
cnet res ls [-a]                 # catálogo do gateway + malha, com unidade/faixa
cnet relay bomba on|off|pulse 500
cnet cam snap -n cam foto.jpg
cnet sensor temp watch           # segue o stream
cnet mesh                        # nós da matilha
```

É o "celerctl de recursos" para quem não escreve Rust — e o isca de demo
do produto.

### 9.4 Qualidade

- **Unit**: vetores-ouro do framing compartilhados com `test/cpp`
  (o CRC e o HELLO são determinísticos); remontagem BULK fora de ordem.
- **Integração**: contra `celerctl sim` (o simulador do device já roda o
  HostLink) e contra um **fake device** em Rust para CI sem hardware.
- **Bancada**: watch (CDC) e dog (USJ) — relay on/off com osciloscópio no
  pino, snap da câmera da malha, stream de sensor 1 Hz por 1 h (vazamento).

---

## 10. Histórias ponta a ponta

### 10.1 "Relé da bomba pela USB"

1. O dono faz `mesh join fazenda senhaforte` no shell do 4848 (SKU com
   relés) e `set res_share_gpio 1`.
2. `GpioRes` registra `rele1` (exclusivo, `off:1` no schema, TAG_UNIT "—").
3. O PC liga o cabo (ttyACM0). `cnet res ls` mostra o catálogo do gateway
   + `relogio:mic`, `cam:camera`, `4848:rele1`.
4. `dev.relay("rele1")?.on()` → OPEN pela malha (2 cópias) → ACCEPT sid,
   lease 20 s → WRITE 1 → relé fecha. Notificação no 4848: "rele1 em uso
   por PC".
5. O cabo é arrancado no meio: 8 s depois o gateway expira a sessão HostLink,
   fecha o lease, e o **auto-off** devolve o pino. Sem Estado órfão, sem
   bomba ligada para sempre.

### 10.2 "A câmera do quintal"

1. esp32-cam liga, entra na matilha (provisionado), `CamRes` publica
   `camera`; caps `CAMERA 0x40` vão no BEAT e no HELLO ESP-NOW.
2. No watch: `Pack.snap("cam", {path:"quintal.jpg"})` — DESCRIBE→OPEN pela
   malha, ACCEPT escolhe ESP-NOW (mesmo canal), foto em BULK+ACK.
3. No PC (gateway = 4848 na mesma antena): `dev.camera_on("cam")?.snap(...)`
   — o gateway é o cliente; os blocos chegam a ele e seguem por USB.

### 10.3 "O sensor da janela"

1. Um devkit com LDR na porta do ADC publica `lum` (TYPE_SENSOR,
   TAG_UNIT "k%", TAG_RANGE 0..100), shared, rate sob demanda.
2. Watch: `Pack.open("sensor-janela","lum",{rate:1000})` e pinta no watchface.
3. PC: `cnet sensor lum watch` assina o stream; com §12-b, um threshold
   `lum<10` dispara evento na matilha e acende a luz pelo relé — sem
   nenhum app instalado em lugar nenhum.

---

## 11. Segurança — modelo de ameaças

| Ataque | Defesa atual | Nota |
|---|---|---|
| Esnifar o ar da malha | v3: tudo AES-CCM; header ofuscado (molde SIG) — sequências/ids não vazam | Rede aberta "celer" é integridade-only **de propósito** (farol) |
| Injetar quadro na malha | MIC sobre payload + AAD; chave só com nome+senha | PBKDF2 4096 (~0,3 s no device): senha fraca = matilha fraca; documento orienta senha ≥12 |
| Replay | janela RPL de 64 seqs por (rede, origem), commit pós-MIC; seqs reservadas em NVS | `mesh replay` prova o gate |
| Nó de fora tentando recursos | `policyAllows`: mic/cam exigem `provisioned()`; interrupts `res_share_*` | GPIO [PROPOSTA] default **0** + privada |
| Nó legítimo abusing | hoje: NENHUMA ACL por peer — qualquer membro da privada abre o que estiver compartilhado | §12-c (ACL com adminKey), §12-d (consentimento) |
| Pareamento BLE | código 6 dígitos só na tela local, 3 falhas derrubam, bond v2 prova posse, canal selado GCM p/ segredos | mensagens comuns de link são em claro por design (não carregam segredo) |
| PC pela USB | posse física + políticas de recurso + `res_share_usb` default 0 + notificação | sem token: modelo "cabo na mão = dono", igual ao shell de hoje |
| Bridge TCP (LAN) | token 8 chars, comparação constante, lockout, AUTH em 15 s | `res` NÃO passa pelo bridge na onda B — avaliar em §12 |

Princípio herdado do kernel: **o uso local ganha sempre** — o dono nunca
perde o hardware para a rede (mic/câmera/gpio revogam sessões remotas).

---

## 12. Menu de evolução [OPÇÃO]

Ordenado por razão custo/benefício para o produto. Cada item diz o que
destrava e o custo honesto.

| # | Opção | O que destrava | Custo | Onda |
|---|---|---|---|---|
| a | **Metadados TLV no catálogo** (§7.2) | unidade/faixa/esquema no PC e nos apps; base de TUDO abaixo | baixo: 2 opcodes + TLV no servidor | A |
| b | **Eventos/subscrição de sensor** (threshold → push na matilha) | automação sem app: "escuro → acende luz"; o PC vira painel | médio: avaliador no SensorRes + envelope `KIND_EVENT` | D |
| c | **ACL por peer** assinada com `adminKey` (allowlist de node ids por recurso) | fecha a lacuna "qualquer membro abre tudo"; provisioning sem senha vira real (`joinWithKeys` + ACL) | médio: NVS por recurso + campo no OPEN | D |
| d | **Consentimento por pedido**: diálogo no dono ("PC quer a câmera — permitir 5 min?") (a UI de join pousou na API 40: app Matilha, convite pelo CelerLink) | produto para gente não-técnica | médio: tela nativa no dono + fila de pedidos | D |
| e | **Streams multi-hop por re-chunking**: gateway/nó intermediário puxa o stream e re-envia (USB ou malha) | câmera/mic de qualquer nó no PC sem ESP-NOW comum | alto (latência/buffer na PSRAM) | E |
| f | **Rust direto no BLE** (`btleplug`) + porte do NetFrame v3 no host: o PC vira nó REAL da malha sem gateway | PC fala com nós sem cabo (o porte Python v2 foi aposentado na API 41) | médio-alto: NetFrame v3 + chaves no host | E |
| g | **Rules engine na matilha** (reflexos: `se sensor X > Y então relay Z`) | automação local permanente, sobrevive ao PC | alto: parser+runner residente na PSRAM | F |
| h | **Handoff de sessão**: lease migra de nó (PC→watch) sem reabrir | continuar assistindo a câmera saindo de casa | médio: REVOKE+migração assistida | F |
| i | **mDNS/DNS-SD no bridge** + `celernet` como serviço do sistema | `cnet devices` acha pela rede sem probe próprio | baixo | C |
| j | **Catálogo no HELLO ESP-NOW** (hash do LIST; DESCRIBE só quando muda) | descoberta de malha inteira ~instantânea p/ o PC | baixo-médio | C |

Recomendação de corte: **a → (8+9) → j/i → c/b/d**. Os itens e–g são a
fronteira onde a matilha deixa de ser "rede de recursos" e vira
"sistema distribuído" — valem ondas próprias, cada uma com bench de
RAM interna antes (a lição de 2026-10-07: RAM interna é o recurso escasso).

---

## 13. Roadmap em ondas

| Onda | Escopo | Gates |
|---|---|---|
| **A — Recursos genéricos** | `TYPE_GPIO/SENSOR` + `OP_*_META` (TLV) + `GpioRes`/`SensorRes` nativos + `res_share_gpio` default 0 + auto-off no lease | `test/cpp` (codec LIST_META, lease+auto-off), `meshsim` (cenário relé 2 nós), bench 4848 (relés físicos) |
| **Pilares (API 40/41)** | ✅ PackId (identidade única), Provision (senha · convite selado CelerLink · cabo), app Matilha com Entrar, nó virtual `pc-XXXX` com BEAT proxy, `SUB_SEND`, procuração `SUB_OPEN_AT` | `test/cpp` (PackId, ProvProto, JOIN, eventos, BEAT proxy), `meshsim` (convite + 3 portas; nó virtual), `test_celerctl` (mesh, procuração); bancada pendente |
| **B — Gateway USB** | B.1 ✅ `KL_RES_CTL/DATA` + transporte USB + auto-KEEP + `res_share_usb`; B.2 ✅ nó virtual, proxy de OPEN e mídia de outros nós pelo cabo (API 41) | `test/cpp` (frame KL_RES), celerctl `sim` (novo opcode), bench watch CDC + dog USJ, teste do cabo arrancado (§10.1-5) |
| **C — crate `celernet`** | transport trait + framing + ResProto client + API alto nível + fake device p/ CI (+ `cnet`, mDNS, hash-HELLO se julgado) | cargo test, integração vs sim, bancada 1 h de stream |
| **D — Confiança** | ACL adminKey + consentimento + eventos/threshold + UI de join | meshsim (ACL negando nó), bench de RAM interna |
| **E/F — Fronteira** | re-chunking, Rust-BLE, rules engine, handoff | desenho próprio, uma onda cada |

Bump de API a cada onda que mexe no fio (A e B são APIs 38 e 39
candidatas); `celer.js types` regenera junto quando superfície JS muda.

---

## 14. Apêndice — constantes de protocolo

### A. NetFrame v3 (`NetFrame.h`)

| Constante | Valor |
|---|---|
| HDR / MIC | 11 / 4 B |
| ADV_MAX / DATA_MAX | 31 / 16 B |
| CHUNK_MAX / MAX_FRAGS / MSG_MAX | 14 / 31 / 434 B |
| DST_BROADCAST | 0xFFFF |
| TTL_DEFAULT / TTL_MAX | 4 / 8 |
| Tipos | BEAT=0, DATA=1, FRAG=2 |
| CAPS | SPK 01, MIC 02, DISP 04, MOT 08, LED 10, HUB 20, CAM 40 |
| BFLAG | UNPROV 01, ADMIN 02, PROXY 04 (nó virtual, API 41) |
| Token bucket | 16 rajada, 8/s |
| Fila TX/RX | 96 / 8 |
| Nós / expiração | 16 / 15 s (teto 4×) |
| RPL | 32 entradas × janela 64 seqs |
| Remontagem | 4 slots, 6 s |

### B. ResProto (`ResProto.h`)

| Constante | Valor |
|---|---|
| Opcodes | DESCRIBE 1 … HELLO 10 (+ META 11/12 propostos) |
| Tipos | DATA 0, MIC 1, SPEAKER 2, CAMERA 3 (+ GPIO 4, SENSOR 5, DISPLAY 6 propostos) |
| Flags LIST | BUSY 01, SHARED 02, READY 04 |
| REASON_* | 1 notFound … 9 noLink |
| RES_NAME_MAX / PARAMS_MAX / LIST_MAX | 15 / 48 / 12 |
| ENV_PAYLOAD / MAX_DATA | 430 / 425 B |
| LEASE_DS_DEFAULT | 200 (20 s) |
| Envelope Pack | 'P' + kind + msgId u16; KIND_MUSIC/RES=3/CUSTOM |
| DataLink | frame 1470 B (1449 úteis); kinds DATA/STREAM/BULK/BULK_ACK/CTRL |
| Transportes | MESH=0, ESPNOW=1, USB=2 |

### C. HostLink proto 2 (`HostLink.h:115-151`, `HostFrame.h`)

| Constante | Valor |
|---|---|
| Frame | `0x43 cmd u8 len u16 crc32 u32 payload` (CRC=0xEDB88320 sobre cmd+len+payload) |
| HELLO | payload `"CELERCTL2"` negocia proto 2 |
| Resposta | mesmo opcode; byte 0 = status (0 OK) |
| MAX_PAYLOAD | 8192 (S3) / 4096 (ESP32) |
| Janelas | USJ 4, UART S3 4, CDC 2, CYD 1, TCP 4 |
| Opcodes | 0x01 HELLO … 0x20 STATS, 0x21 KL_RES_CTL, 0x22 KL_RES_DATA (subops 1..14 no `UsbRes.h`; eventos do nó virtual com sid 0) |
| Velocidades | UART 78 KB/s @921600 · USJ ~113 · CDC ~110 KB/s |
| Canais USB | watch = CDC nativo (TinyUSB, CDC1) · dog = USJ · smartdisplay = UART CH340 · ESP32 clássicos = UART |
| DebugBridge | TCP/UDP 5555, `CELERBRIDGE 1 …`, `AUTH <token>`, probe `CELERPROBE1` |
| Sessão | única por device; último HELLO ganha; modo link caduca em 8 s sem frames |

---

*Fontes: main/Bluetooth/{CelerLink,CelerNet,NetFrame,NetKeys}, main/Pack/*,
main/Runtime/{JsLink,JsMesh,JsPack,JsGpio,JsMic}.cpp,
main/USBDevice/{HostLink,HostFrame,USBDevice,CelerShell}, tools/celerctl.py,
tools/matilha/, test/{cpp,meshsim,matilha}. Citações de linha referem-se ao
tree em 2026-10-16 (pós a82e9cb, API 37).*
