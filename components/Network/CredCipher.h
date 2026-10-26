#ifndef NETWORK_CRED_CIPHER_H
#define NETWORK_CRED_CIPHER_H

#include <stddef.h>

/**
 * @file CredCipher.h
 * @brief Cifragem das senhas WiFi em repouso (AES-128-CCM via PSA).
 *
 * Chave de 16 bytes gerada na primeira inicializacao (esp_fill_random) e
 * guardada no proprio namespace NVS do store ("net_creds", chave "k"). O
 * objetivo e tirar a senha em TEXTO CLARO da flash: quem ler a particao NVS
 * (dump, app com acesso a flash) nao ve mais a senha. NAO e protecao contra
 * um atacante com controle fisico total do chip e flash encryption
 * desligada — a chave mora na mesma particao (modelo de ameaca honesto, o
 * mesmo do Tactility). A chave de CelerNet ("cn3_key") e o webauth sao
 * dominios separados e NAO sao usados aqui.
 *
 * Formato cifrado (hex): nonce[12] || ciphertext || tag[8]. O nonce e
 * aleatorio por cifragem e viaja junto (nao ha IV deterministico).
 *
 * Thread-safe apos init(): a chave fica em RAM imutavel e as operacoes PSA
 * sao serializaveis. init() e chamado uma vez, no boot, pelo
 * NetworkCredentialStore::init (caminho single-thread).
 */

/**
 * @namespace CredCipher
 */
namespace CredCipher {

/**
 * @brief Prepara a chave: carrega do NVS ou gera na primeira vez.
 *
 * Deve ser chamado uma vez no boot, depois de NVS::initialize(). Em falha o
 * store falha fechado (nao salva rede sem cifra — disponibilidade da
 * senha nao vale o texto claro persistente).
 *
 * @return true se a chave esta pronta para cifrar/decifrar.
 */
bool init();

/**
 * @brief Cifra uma senha (NUL-terminada) em hex "nonce||ct||tag".
 *
 * @param plain  senha em claro (ate 64 bytes, tamanho de KnownNetwork).
 * @param hexOut buffer de saida (sugestao: 192 bytes).
 * @param hexCap capacidade de hexOut.
 * @return true em sucesso.
 */
bool encrypt(const char* plain, char* hexOut, size_t hexCap);

/**
 * @brief Decifra um hex produzido por encrypt().
 *
 * @param hex    texto hex (nonce||ct||tag).
 * @param out    buffer de saida NUL-terminado.
 * @param outCap capacidade de out (sugestao: sizeof(KnownNetwork::password)).
 * @return true em sucesso; false em hex invalido/tag errada/chave ausente —
 *         o chamador trata como senha vazia (rede continua listada).
 */
bool decrypt(const char* hex, char* out, size_t outCap);

}  // namespace CredCipher

#endif  // NETWORK_CRED_CIPHER_H
