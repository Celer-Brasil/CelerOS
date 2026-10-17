#include "JSBindings.h"
#include "JsInternal.h"
#include "../Hardware/BoardIO.h"
#if CONFIG_CELEROS_BLUETOOTH
#include "../Pack/Resources.h"
#include "../Pack/AudioRes.h"
#endif

// =====================================================
// Mic Bindings - gravacao de microfone (objeto Mic, API level 19)
// =====================================================
//
// O audio do dono e dado sensivel: o objeto so nasce para apps que
// DECLARARAM "mic" no app.json e receberam a concessao do usuario
// (mesma disciplina do gpio), em placa com microfone no perfil
// (mic.ws >= 0 — hoje o cao robotico e o watch). Faltando qualquer um
// dos dois, typeof Mic === "undefined" e o app cai no teclado.
//
// Uso tipico (falar com a IA): segurar o botao chama Mic.start({ms}),
// o loop anima o nivel com Mic.level(); soltar chama Mic.stop(), que
// devolve o base64 do WAV pronto para o content part input_audio do
// AI.chat. Mic.stop({raw:true}) devolve o WAV cru (salvar/playWav).

// Mic.start([opts]) opts={ms}: teto da captura em ms (default 6000,
// 200..10000). true = gravando; false = sem mic/sem RAM/ocupado.
duk_ret_t JSBindings::js_micRecStart(duk_context *ctx) {
    int ms = 6000;
    if (duk_is_object(ctx, 0) && !duk_is_array(ctx, 0)) {
        duk_get_prop_string(ctx, 0, "ms");
        if (duk_is_number(ctx, -1)) ms = duk_get_int(ctx, -1);
        duk_pop(ctx);
    }
    // Init do canal I2S/codec pode esperar o lock (500 ms) e o codec do
    // watch acorda: o tempo NATIVO conta na janela do exec-timeout.
    present();
#if CONFIG_CELEROS_BLUETOOTH
    // o dono vem primeiro: sessao remota no nosso mic (Pack.listen/record de
    // outro no) e revogada — dois leitores no canal roubariam chunks
    Resources::localClaim(resproto::TYPE_MIC);
    // Revoke com task presa no i2s_read (ate 400 ms de espera do sourceStop):
    // entrar na gravacao agora seria contencao de dois leitores no MESMO
    // canal. O app ve false e tenta de novo no proximo toque.
    if (AudioRes::sourceActive()) {
        CelerKernel::noteAppYield();
        duk_push_boolean(ctx, 0);
        return 1;
    }
#endif
    const bool ok = BoardIO::micRecStart(ms);
#if CONFIG_CELEROS_BLUETOOTH
    if (ok) {
        // janela entre o claim e o start: uma sessao remota aberta nesse
        // intervalo tambem e revogada (o app e o dono do mic enquanto grava)
        Resources::localClaim(resproto::TYPE_MIC);
    }
#endif
    CelerKernel::noteAppYield();
    duk_push_boolean(ctx, ok ? 1 : 0);
    return 1;
}

// Mic.stop([opts]) opts={raw:true}: encerra e devolve string — o base64
// do WAV por padrao (formato do input_audio das LLMs), o WAV cru com
// {raw:true}. null = nao estava gravando (ou faltou RAM no montador).
duk_ret_t JSBindings::js_micRecStop(duk_context *ctx) {
    bool raw = false;
    if (duk_is_object(ctx, 0) && !duk_is_array(ctx, 0)) {
        duk_get_prop_string(ctx, 0, "raw");
        raw = duk_get_boolean(ctx, -1) != 0;
        duk_pop(ctx);
    }
    // join da task (ate ~150 ms no i2s_read) + WAV/base64 de ate ~430 KB: o
    // tempo NATIVO passa da janela do exec-timeout (mesmo caso do
    // Pack.recordStop)
    present();
    size_t len = 0;
    uint32_t ms = 0;
    char* p = BoardIO::micRecStop(!raw, &len, &ms);
    CelerKernel::noteAppYield();  // janela renovada antes de voltar ao bytecode
    if (p == nullptr) {
        duk_push_null(ctx);
        return 1;
    }
    return jsPushOwnedString(ctx, p, len);
}

// Mic.recording(): true enquanto a task captura — false no teto de ms
// (o buffer continua la ate o stop, que o app chama ao ver isto virar false)
duk_ret_t JSBindings::js_micRecRecording(duk_context *ctx) {
    duk_push_boolean(ctx, BoardIO::micRecActive() ? 1 : 0);
    return 1;
}

// Mic.level(): RMS 0..100 do ultimo chunk (-1 = nao gravando)
duk_ret_t JSBindings::js_micRecLevel(duk_context *ctx) {
    duk_push_int(ctx, BoardIO::micRecLevel());
    return 1;
}
