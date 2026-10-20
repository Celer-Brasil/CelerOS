#ifndef CELER_UTILS_JSTHROW_H
#define CELER_UTILS_JSTHROW_H

// Throw de mensagem JA formatada sem passar pelo vsnprintf do Duktape.
// Dois motivos: (a) duk_error com argumentos de conversao corrompe o heap a
// partir de um lightfunc (bancada 2026-10-02, commit 172f669); (b) a mensagem
// pre-formatada ainda pode conter '%' vindo do app (nome de arquivo), que o
// duk_error interpretaria como formato sem varargs. Cria o Error e seta
// .message direto, sem formato e sem variadicos.
//
// Header proprio (e nao dentro do JsInternal.h) porque o teste/duk extrai o
// corpo de JsModules.cpp e compila no Duktape real sem o JsInternal.h.

#include "duktape.h"

inline duk_ret_t jsThrowMsg(duk_context* ctx, duk_errcode_t code, const char* msg) {
    duk_push_error_object_raw(ctx, code, (const char*) DUK_FILE_MACRO,
                              (duk_int_t) DUK_LINE_MACRO, nullptr);
    duk_push_string(ctx, msg != nullptr ? msg : "");
    duk_put_prop_string(ctx, -2, "message");
    return duk_throw(ctx);
}

#endif  // CELER_UTILS_JSTHROW_H
