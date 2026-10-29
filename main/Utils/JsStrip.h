#ifndef CELEROS_JS_STRIP_H
#define CELEROS_JS_STRIP_H

// ============================================================================
// JsStripper — enxuga o fonte ES5 de um app em streaming antes do compile:
// remove comentarios, indentacao e espacos repetidos/finais. Quebras de linha
// sao TODAS preservadas (inclusive as de dentro de comentarios de bloco): o
// numero de linha dos erros do Duktape continua batendo com o arquivo.
//
// Por que: sem PSRAM o fonte inteiro precisa de um bloco CONTIGUO no heap
// durante o compile (App Store: 44KB -> ~31KB). Uso em duas passadas sobre o
// mesmo arquivo: out = nullptr so conta (tamanho exato), depois aloca e
// preenche. Estado persiste entre chunks (feed pode ser chamado por pedaco).
// Tambem roda IN-PLACE (out == entrada; CelerKernel com PSRAM): todo char
// emitido corresponde a um ja consumido, entao a escrita nunca passa da
// leitura (test/cpp confere contra as duas passadas em todos os apps).
//
// Heuristica de regex vs divisao: '/' abre regex quando o ultimo token
// significativo nao e operando (identificador, numero, ')' ou ']') ou e uma
// palavra-chave que precede expressao (return, typeof, ...). Palavra-chave
// logo apos '.' e propriedade, nao keyword: `obj.return / 2` e divisao.
// Strings e regexes sao copiados byte a byte.
//
// Header-only e sem dependencias do IDF: testado no host (test/cpp).
// ============================================================================

#include <stddef.h>
#include <string.h>

namespace celer {

class JsStripper {
public:
    explicit JsStripper(char* out = nullptr) : m_out(out) {}

    void feed(const char* in, size_t n) {
        for (size_t i = 0; i < n; i++) step(in[i]);
    }

    // Fim do fonte: descarrega '/' e espaco pendentes. Devolve o total.
    size_t finish() {
        endWord();
        if (m_slash) {
            m_slash = false;
            code('/');
        }
        return m_n;
    }

    size_t size() const { return m_n; }

private:
    enum State { Code, Str, LineComment, BlockComment, Regex };

    char* m_out;
    size_t m_n = 0;
    State m_s = Code;
    char m_quote = 0;
    bool m_esc = false;
    bool m_star = false;        // BlockComment: ultimo char foi '*'
    bool m_blockNl = false;     // BlockComment: teve quebra de linha
    bool m_reClass = false;     // Regex: dentro de [...]
    bool m_slash = false;       // Code: '/' visto, aguardando o proximo
    bool m_lineStart = true;
    bool m_space = false;       // espaco pendente (so sai antes de codigo)
    char m_last = 0;            // ultimo token: 0 inicio, 'a' operando, 'k' keyword, ou pontuacao
    char m_word[12];
    int m_wlen = 0;             // -1: palavra longa demais (nao e keyword)
    bool m_dot = false;         // '.' visto: a palavra seguinte e propriedade

    void emit(char c) {
        if (m_out) m_out[m_n] = c;
        m_n++;
    }

    static bool isIdent(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' ||
               c == '$' || (unsigned char)c >= 0x80;
    }

    void endWord() {
        if (m_wlen == 0) return;
        if (m_dot) {
            // obj.return: a palavra vem depois de '.', e propriedade, nunca
            // keyword — `obj.return / 2` e divisao, nao abre regex
            m_dot = false;
            m_last = 'a';
            m_wlen = 0;
            return;
        }
        static const char* const kKw[] = {"return", "typeof", "case",   "do",         "else",
                                          "in",     "new",    "void",   "delete",     "throw",
                                          "instanceof"};
        m_last = 'a';
        if (m_wlen > 0) {
            m_word[m_wlen] = 0;
            for (const char* kw : kKw) {
                if (strcmp(m_word, kw) == 0) {
                    m_last = 'k';
                    break;
                }
            }
        }
        m_wlen = 0;
    }

    bool regexAllowed() const {
        if (m_last == 0 || m_last == 'k') return true;
        if (m_last == 'a' || m_last == ')' || m_last == ']') return false;
        return true;  // pontuacao/operador: o proximo e expressao
    }

    // Char de codigo visivel (nao espaco): sai com o espaco pendente antes
    void code(char c) {
        if (m_space && !m_lineStart) emit(' ');
        m_space = false;
        m_lineStart = false;
        emit(c);
    }

    void newline() {
        m_space = false;  // espaco final da linha cai fora
        m_lineStart = true;
        emit('\n');
    }

    void step(char c) {
        switch (m_s) {
            case Str:
                emit(c);
                if (m_esc) {
                    m_esc = false;
                } else if (c == '\\') {
                    m_esc = true;
                } else if (c == m_quote) {
                    m_s = Code;
                    m_last = 'a';
                } else if (c == '\n') {
                    m_s = Code;  // string mal formada: o compile acusa
                    m_lineStart = true;
                }
                return;
            case LineComment:
                if (c == '\n') {
                    m_s = Code;
                    newline();
                }
                return;
            case BlockComment:
                if (c == '\n') {
                    newline();
                    m_blockNl = true;
                } else if (m_star && c == '/') {
                    m_s = Code;
                    if (!m_blockNl) m_space = true;  // a/**/b nao vira ab
                    return;
                }
                m_star = (c == '*');
                return;
            case Regex:
                emit(c);
                if (m_esc) {
                    m_esc = false;
                } else if (c == '\\') {
                    m_esc = true;
                } else if (c == '[') {
                    m_reClass = true;
                } else if (c == ']') {
                    m_reClass = false;
                } else if (c == '/' && !m_reClass) {
                    m_s = Code;
                    m_last = 'a';  // flags seguem como identificador
                } else if (c == '\n') {
                    m_s = Code;
                    m_lineStart = true;
                }
                return;
            case Code:
                break;
        }

        if (m_slash) {
            m_slash = false;
            if (c == '/') {
                endWord();
                m_s = LineComment;
                return;
            }
            if (c == '*') {
                endWord();
                m_s = BlockComment;
                m_star = false;
                m_blockNl = false;
                return;
            }
            endWord();
            bool re = regexAllowed();
            code('/');
            if (re) {
                m_s = Regex;
                m_esc = false;
                m_reClass = false;
                step(c);  // o char seguinte ja e corpo da regex
                return;
            }
            m_last = '/';
        }

        if (isIdent(c)) {
            if (m_wlen >= 0) {
                if (m_wlen < (int)sizeof(m_word) - 1) m_word[m_wlen++] = c;
                else m_wlen = -1;
            }
            code(c);
            return;
        }
        if (m_wlen != 0) {
            if (m_wlen < 0) {
                m_wlen = 0;
                m_last = 'a';
            } else {
                endWord();
            }
        }

        switch (c) {
            case ' ':
            case '\t':
            case '\r':
                if (!m_lineStart) m_space = true;
                return;
            case '\n':
                newline();
                return;
            case '/':
                m_slash = true;  // decide no proximo char (comentario/regex/divisao)
                return;
            case '"':
            case '\'':
                code(c);
                m_s = Str;
                m_quote = c;
                m_esc = false;
                return;
            default:
                code(c);
                m_last = c;
                // '.' marca que a proxima palavra e propriedade; qualquer outro
                // pontuador desmarca (o flag nunca atravessa um token)
                m_dot = (c == '.');
                return;
        }
    }
};

}  // namespace celer

#endif  // CELEROS_JS_STRIP_H
