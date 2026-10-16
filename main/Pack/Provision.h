#ifndef CELEROS_PACK_PROVISION_H
#define CELEROS_PACK_PROVISION_H

#include <stdint.h>

// Entrar na matilha (API 40) — as tres portas, um so caminho de chave:
//
//   senha     joinPassword(nome, senha): o shell (mesh join), o JS
//             (Pack.join) e o cabo (KL_RES_CTL SUB_JOIN) chamam a MESMA
//             funcao (PBKDF2 ~0,3 s; so de pilha interna — grava NVS).
//   convite   pelo CelerLink: o aparelho novo abre a janela (acceptInvite,
//             10 min; anuncia e exige o codigo de 6 digitos), quem ja esta
//             na matilha conecta, digita o codigo e manda o INVITE selado
//             (invite). Ver ProvProto.h.
//   cabo      o PC pelo HostLink usa a porta da senha (SUB_JOIN).
//
// Depois de qualquer porta: CelerNet::netChanged + Resources::netChanged
// (a malha e o plano ESP-NOW passam a cifrar com a matilha nova).
namespace Provision {

enum State : uint8_t {
    IDLE = 0,
    WAITING,   // convidado: janela aberta, esperando o INVITE
    JOINED,    // convidado: entrou pelo convite
    SENT,      // convidador: INVITE enviado, esperando o ACK
    OK,        // convidador: o convidado confirmou
    FAIL,      // ACK de falha, ACK que nao veio em 10 s ou envio recusado
};

void init();   // registra o tap selado no CelerLink (idempotente)
void tick();   // do Pack::tick (pilha interna): aplica o convite, prazos

bool joinPassword(const char* name, const char* password);
void leave();

// Convidado: abre/fecha a janela de convite. Abrir liga o advertising do
// CelerLink com pareamento por codigo (o app mostra status().code). A
// janela fecha sozinha em 10 min, ao entrar ou se o app sair (appReset
// derruba o advertising).
bool acceptInvite(bool on);

// Convidador: manda o convite ao peer conectado e VERIFICADO por codigo
// (bond). false sem matilha privada, sem peer verificado ou se o selo
// recusar. O resultado chega em state(): SENT -> OK | FAIL.
bool invite();

// Convite sem tela (shell "mesh invite", cabo SUB_INVITE/SUB_INVITE_CODE,
// API 41) — os mesmos 2 passos da UI, porque o codigo so nasce na conexao:
//   inviteConnect: scan do CelerLink e conecta no alvo (nome do anuncio, id
//     "AA:BB:.." ou id da malha "1CAE"); o novo passa a exibir o codigo
//     (tela, ou pendingCode() pelo cabo dele).
//   inviteCode: digita o codigo, manda o INVITE e espera o ACK (10 s);
//     desconecta no fim, deu certo ou nao.
// Bloqueantes (ate ~10 s): so de task que pode esperar (shell/canal USB).
// Peer com bond (ja pareado antes): a reconexao entra pelo desafio do bond,
// sem codigo — inviteConnect manda a chave na hora e *done = true.
bool inviteConnect(const char* target, bool* done);
bool inviteCode(const char* code);

// Codigo de 6 digitos da janela aberta (convidado com pareamento pendente)
// ou "" — a tela mostra; num aparelho SEM tela o dono le pelo cabo.
void pendingCode(char out[7]);

State state();
const char* stateName(State s);

}  // namespace Provision

#endif  // CELEROS_PACK_PROVISION_H
