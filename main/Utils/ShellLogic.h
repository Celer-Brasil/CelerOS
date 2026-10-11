#ifndef CELER_UTILS_SHELL_LOGIC_H
#define CELER_UTILS_SHELL_LOGIC_H

// Logica PURA do shell do CelerOS (main/USBDevice/CelerShell.cpp), extraida
// em header sem dependencia de ESP-IDF para rodar nos testes host
// (test/cpp/run_tests.cpp) — o mesmo papel do Utils/JsonMap.h. Tudo aqui e
// reentrante: o interpretador de script nao guarda estado entre chamadas
// (a politica de device — cwd, $?, guarda de aninhamento — fica no
// CelerShell.cpp, que so delega).

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

namespace shl {

// Par do CelerShell::MAX_LINE (o editor de linha entrega linhas desse tamanho)
constexpr int kMaxLine = 256;

// ------------------------------------------------------------------ caminhos

// Resolve 'arg' contra 'cwd' e normaliza ('.', '..', '//'); absoluto ignora
// o cwd. Devolve sempre absoluto comecando em '/' (raiz vira "/"). O
// chamador continua responsavel pela jail (pathAllowed) — aqui e so texto.
inline std::string resolvePath(const std::string& cwd, const char* arg) {
    std::string base = (arg[0] == '/') ? arg : cwd + "/" + arg;
    std::string out;
    size_t i = 0;
    while (i < base.size()) {
        size_t j = base.find('/', i);
        if (j == std::string::npos) j = base.size();
        if (j > i) {
            std::string seg = base.substr(i, j - i);
            if (seg == "..") {
                size_t s = out.rfind('/');
                if (s != std::string::npos) out.resize(s);
            } else if (seg != ".") {
                out += '/';
                out += seg;
            }
        }
        i = j + 1;
    }
    return out.empty() ? "/" : out;
}

// ---------------------------------------------------------------- glob/busca

// Glob de '*' e '?' (find -name, sem regex).
inline bool wildMatch(const char* pat, const char* str) {
    const char* star = nullptr;
    const char* back = nullptr;
    while (*str != '\0') {
        if (*pat == *str || *pat == '?') {
            pat++;
            str++;
        } else if (*pat == '*') {
            star = pat++;
            back = str;
        } else if (star != nullptr) {
            pat = star + 1;
            str = ++back;
        } else {
            return false;
        }
    }
    while (*pat == '*') pat++;
    return *pat == '\0';
}

// Substring ignorando caixa (grep -i), sem alocar.
inline bool containsCI(const char* hay, const char* needle) {
    for (const char* h = hay; *h != '\0'; h++) {
        const char* a = h;
        const char* b = needle;
        while (*b != '\0' && tolower((unsigned char)*a) == tolower((unsigned char)*b)) {
            a++;
            b++;
        }
        if (*b == '\0') return true;
    }
    return false;
}

// --------------------------------------------------------------------- tail

// Offset onde comecam as ultimas 'n' linhas do arquivo ABERTO 'f' (faz os
// seeks; deixa o arquivo POSICIONADO no comeco achado). EOF sem '\n' final
// conta como fechamento da ultima linha, como no tail(1). -1 em erro de
// seek. Varre de tras pra frente em janelas de 512 B: nao le o arquivo
// inteiro para a RAM.
inline long tailStart(FILE* f, long n) {
    if (fseek(f, 0, SEEK_END) != 0) return -1;
    const long size = ftell(f);
    long start = 0;
    if (size > 0) {
        char last;
        int seen = 0;
        if (fseek(f, size - 1, SEEK_SET) == 0 && fread(&last, 1, 1, f) == 1 && last != '\n') {
            seen = 1;  // EOF sem '\n': a ultima linha ja esta fechada
        }
        char buf[512];
        long pos = size;
        while (pos > 0) {
            const long take = (pos > (long)sizeof(buf)) ? (long)sizeof(buf) : pos;
            pos -= take;
            if (fseek(f, pos, SEEK_SET) != 0) return -1;
            const size_t got = fread(buf, 1, (size_t)take, f);
            for (int i = (int)got - 1; i >= 0; i--) {
                if (buf[i] != '\n') continue;
                // o (n+1)-esimo fim-de-linha atras fecha a linha que fica
                // fora da janela; dali em diante sao as n ultimas
                if (++seen == n + 1) {
                    start = pos + i + 1;
                    pos = 0;
                    break;
                }
            }
        }
    }
    if (fseek(f, start, SEEK_SET) != 0) return -1;
    return start;
}

// ---------------------------------------------------------------- variaveis

// Devolve o valor da variavel ou nullptr se nao existe.
typedef const char* (*VarLookup)(void* ctx, const char* name);

// Expande $NOME, ${NOME} e $? (lastRc) em qualquer posicao. Variavel
// desconhecida vira string vazia (POSIX) e '$' seguido de outra coisa
// (digito, '$', espaco, fim...) e literal.
inline void expandVars(const char* src, char* dst, size_t dstSize, VarLookup lookup,
                       void* ctx, int lastRc) {
    size_t o = 0;
    for (size_t i = 0; src[i] != '\0' && o + 1 < dstSize; i++) {
        if (src[i] != '$') {
            dst[o++] = src[i];
            continue;
        }
        char name[24];
        const char* val = nullptr;
        char rcbuf[12];
        const char c1 = src[i + 1];
        if (c1 == '{') {
            const char* close = strchr(src + i + 2, '}');
            if (close == nullptr) {
                dst[o++] = '$';
                continue;  // '{' sem '}': o resto sai literal
            }
            const size_t n = (size_t)(close - (src + i + 2));
            if (n < sizeof(name)) {
                memcpy(name, src + i + 2, n);
                name[n] = '\0';
                val = lookup(ctx, name);
            }
            i = (size_t)(close - src);
        } else if (c1 == '?') {
            snprintf(rcbuf, sizeof(rcbuf), "%d", lastRc);
            val = rcbuf;
            i++;
        } else if (isalpha((unsigned char)c1) || c1 == '_') {
            size_t n = 0;
            for (const char* p = src + i + 1;
                 (isalnum((unsigned char)*p) || *p == '_') && n < sizeof(name) - 1; p++) {
                name[n++] = *p;
            }
            name[n] = '\0';
            val = lookup(ctx, name);
            i += n;
        } else {
            dst[o++] = '$';
            continue;
        }
        if (val != nullptr) {
            size_t vl = strlen(val);
            if (vl > dstSize - 1 - o) vl = dstSize - 1 - o;
            memcpy(dst + o, val, vl);
            o += vl;
        }
    }
    dst[o] = '\0';
}

// ----------------------------------------------------------- aritmetica set

enum class Arith { None, Ok, DivZero };

// Casa INTEIRO com "[-]N OP [-]N" (OP em + - * / %): e o contador do sh
// (set I=$I + 1). O %n do sscanf exige o fim da string — datas e texto
// ficam None ("2026-10-10" NAO vira subtracao); espaco no fim e tolerado.
inline Arith arithEval(const char* val, long* out) {
    long lhs = 0, rhs = 0;
    char op = 0;
    int pos = -1;
    if (sscanf(val, "%ld %c %ld %n", &lhs, &op, &rhs, &pos) != 3 ||
        pos != (int)strlen(val)) {
        return Arith::None;
    }
    switch (op) {
        case '+': *out = lhs + rhs; return Arith::Ok;
        case '-': *out = lhs - rhs; return Arith::Ok;
        case '*': *out = lhs * rhs; return Arith::Ok;
        case '/':
        case '%':
            if (rhs == 0) return Arith::DivZero;
            *out = (op == '/') ? lhs / rhs : lhs % rhs;
            return Arith::Ok;
        default:
            return Arith::None;
    }
}

// --------------------------------------------------- interpretador (sh)

// Executa uma linha (comando com saida visivel / condicao calada) e devolve
// o codigo dela.
typedef int (*ExecFn)(void* ctx, const char* line);
// Eco/mensagens do interpretador (trace, erros de estrutura, -e).
typedef void (*PrintFn)(void* ctx, const char* fmt, ...);

struct ScriptOpts {
    bool stopErr = false;  // -e: para no primeiro comando com rc != 0
    bool trace = false;    // -x: ecoa "+ linha" antes de rodar
};

// Roda o script linha a linha: uma linha = um comando (# comenta a linha
// inteira; sem aspas). Blocos multilinha:
//   if COND / else / end      COND e um comando rodado CALADO por condExec
//   while COND / end          (0 = verdadeiro), re-avaliado a cada volta —
//   break / continue          a volta e um fseek no proprio arquivo, sem
//                             corpo em RAM (teto de 65535 iteracoes).
// 'lineExec' roda as linhas com saida visivel; 'execCtx' e o ctx das duas.
// Devolve o rc do ultimo comando executado (1 em erro estrutural).
inline int runScript(FILE* f, const ScriptOpts& opts, ExecFn lineExec, ExecFn condExec,
                     void* execCtx, PrintFn print, void* printCtx) {
    // Um bloco aberto (if/while) do script em execucao.
    struct Frame {
        char type;       // 'i' = if, 'w' = while
        bool dead;       // empilhado sob ramo pulado: nada neste bloco roda
        bool skipping;   // o ramo atual esta pulado (cond falsa/break/continue)
        bool taken;      // if: a condicao foi verdadeira (decide o else)
        bool brk;        // break pedido: no end, sai do while sem reavaliar
        bool cont;       // continue pedido: no end, reavalia direto
        uint32_t iters;  // while: reavaliacoes (teto anti-travamento)
        long bodyOff;    // while: offset da primeira linha do corpo
        char cond[120];  // condicao crua: re-expande a cada volta ($I muda)
    };
    Frame fr[8];
    int nfr = 0;
    int rc = 0;
    long lineno = 0;
    bool bad = false;
    bool stopped = false;
    char line[kMaxLine];

    while (fgets(line, sizeof(line), f) != nullptr) {
        lineno++;
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = '\0';
        char* s = line;
        while (*s == ' ' || *s == '\t') s++;
        if (*s == '\0' || *s == '#') continue;

        // primeira palavra: palavra de controle vale como PALAVRA INTEIRA
        // no comeco da linha — "echo if" nao abre bloco
        char* wend = s;
        while (*wend != '\0' && *wend != ' ' && *wend != '\t') wend++;
        const size_t wlen = (size_t)(wend - s);
        char* rest = wend;
        while (*rest == ' ' || *rest == '\t') rest++;

        bool skipping = false;
        for (int i = 0; i < nfr; i++) {
            if (fr[i].skipping) {
                skipping = true;
                break;
            }
        }

        const bool isIf = (wlen == 2 && strncmp(s, "if", 2) == 0);
        const bool isWhile = (wlen == 5 && strncmp(s, "while", 5) == 0);
        const bool isElse = (wlen == 4 && strncmp(s, "else", 4) == 0);
        const bool isEnd = (wlen == 3 && strncmp(s, "end", 3) == 0);
        const bool isBreak = (wlen == 5 && strncmp(s, "break", 5) == 0);
        const bool isCont = (wlen == 8 && strncmp(s, "continue", 8) == 0);

        if (isIf || isWhile) {
            if (*rest == '\0') {
                print(printCtx, "sh: linha %ld: %s sem condicao\r\n", lineno,
                      isIf ? "if" : "while");
                bad = true;
                break;
            }
            if (nfr >= 8) {
                print(printCtx, "sh: linha %ld: blocos aninhados demais (>8)\r\n", lineno);
                bad = true;
                break;
            }
            if (strlen(rest) >= sizeof(fr[0].cond)) {
                print(printCtx, "sh: linha %ld: condicao longa demais\r\n", lineno);
                bad = true;
                break;
            }
            Frame& F = fr[nfr++];
            memset(&F, 0, sizeof(F));
            F.type = isIf ? 'i' : 'w';
            F.dead = skipping;  // pai pulando: o bloco inteiro e morto
            strcpy(F.cond, rest);
            if (F.dead) {
                F.skipping = true;  // a condicao NAO roda: efeito colateral zero
            } else {
                F.taken = (condExec(execCtx, rest) == 0);
                F.skipping = !F.taken;
                if (isWhile && F.taken) F.bodyOff = ftell(f);
            }
            continue;
        }
        if (isElse) {
            if (nfr == 0 || fr[nfr - 1].type != 'i') {
                print(printCtx, "sh: linha %ld: else sem if\r\n", lineno);
                bad = true;
                break;
            }
            if (*rest != '\0') {
                print(printCtx, "sh: linha %ld: else nao aceita '%s'\r\n", lineno, rest);
                bad = true;
                break;
            }
            if (!fr[nfr - 1].dead) fr[nfr - 1].skipping = fr[nfr - 1].taken;
            continue;
        }
        if (isEnd) {
            if (nfr == 0) {
                print(printCtx, "sh: linha %ld: end sem bloco\r\n", lineno);
                bad = true;
                break;
            }
            if (*rest != '\0') {
                print(printCtx, "sh: linha %ld: end nao aceita '%s'\r\n", lineno, rest);
                bad = true;
                break;
            }
            Frame& F = fr[nfr - 1];
            if (F.type == 'w' && !F.dead) {
                if (F.brk) {
                    nfr--;  // break: sai do laco sem reavaliar
                } else if (F.skipping && !F.cont) {
                    nfr--;  // condicao virou falsa: sai do laco
                } else {
                    // corpo completou (ou continue): re-avalia a condicao
                    if (++F.iters > 65535) {
                        print(printCtx, "sh: while passou de 65535 iteracoes (linha %ld)\r\n",
                              lineno);
                        bad = true;
                        break;
                    }
                    F.skipping = false;
                    F.cont = false;
                    if (condExec(execCtx, F.cond) == 0) {
                        if (fseek(f, F.bodyOff, SEEK_SET) != 0) {
                            print(printCtx, "sh: seek falhou no while (linha %ld)\r\n", lineno);
                            bad = true;
                            break;
                        }
                        // frame permanece: mais uma volta do corpo
                    } else {
                        nfr--;
                    }
                }
            } else {
                nfr--;  // end de if (ou de while morto): so fecha
            }
            continue;
        }
        if (isBreak || isCont) {
            if (skipping) continue;  // break/continue em ramo pulado: texto morto
            if (*rest != '\0') {
                print(printCtx, "sh: linha %ld: %s nao aceita '%s'\r\n", lineno, s, rest);
                bad = true;
                break;
            }
            int w = nfr - 1;
            while (w >= 0 && fr[w].type != 'w') w--;
            if (w < 0) {
                print(printCtx, "sh: linha %ld: %s fora de while\r\n", lineno,
                      isBreak ? "break" : "continue");
                bad = true;
                break;
            }
            for (int k = w; k < nfr; k++) fr[k].skipping = true;  // cala os blocos internos
            if (isBreak) fr[w].brk = true;
            else fr[w].cont = true;
            continue;
        }

        if (skipping) continue;
        if (opts.trace) print(printCtx, "+ %s\r\n", s);
        rc = lineExec(execCtx, s);
        if (opts.stopErr && rc != 0) {
            print(printCtx, "sh: parou na linha %ld (rc %d): %s\r\n", lineno, rc, s);
            stopped = true;
            break;
        }
    }
    if (bad) rc = 1;  // erro estrutural: nao herda o rc do ultimo comando bom
    if (!bad && !stopped && nfr > 0) {
        print(printCtx, "sh: fim do arquivo com %d bloco(s) aberto(s) (falta end)\r\n", nfr);
        rc = 1;
    }
    return rc;
}

}  // namespace shl

#endif  // CELER_UTILS_SHELL_LOGIC_H
