#ifndef ERRORCODE_H
#define ERRORCODE_H

#include <stdint.h>

/**
 * @file ErrorCode.h
 * @brief Codigo de erro leve: um inteiro por valor, descricao em flash.
 *
 * Sem registro em RAM: cada constante e constexpr e a comparacao e de
 * inteiros. As descricoes vivem em rodata (veja ErrorCode.cpp); os ids
 * numericos estao documentados em ERROR_CODES.md.
 */
class ErrorCode {
public:
    /** Codigo invalido (id 0), resultado de construtor padrao. */
    constexpr ErrorCode() : _id(0) {}

    /** Constroi a partir do id numerico (1..N; 0 fica invalido). */
    constexpr explicit ErrorCode(uint16_t id) : _id(id) {}

    /**
     * @brief Descricao legivel do erro, para logs.
     *
     * @return Literal em flash; nunca nulo. Codigo invalido devolve
     *         "Invalid Error Code".
     */
    [[nodiscard]] const char* description() const;

    /**
     * @brief Indica se o codigo foi definido.
     *
     * @return true se o id e de um codigo conhecido; false para o codigo
     *         padrao (id 0) e para ids fora da tabela (ex.: valor corrompido).
     */
    [[nodiscard]] bool isValid() const { return _id != 0 && _id <= kMaxKnownId; }

    /** Comparacao por id (barata; nao ha string envolvida). */
    constexpr bool operator==(const ErrorCode& other) const { return _id == other._id; }

    /** Desigualdade por id. */
    constexpr bool operator!=(const ErrorCode& other) const { return _id != other._id; }

private:
    /** Ultimo id documentado (tabela de descricoes em ErrorCode.cpp). */
    static constexpr uint16_t kMaxKnownId = 54;
    uint16_t _id;
};

#endif // ERRORCODE_H
