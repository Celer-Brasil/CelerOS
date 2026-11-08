#ifndef EVENT_H
#define EVENT_H

#include <functional>
#include <vector>     // mantido: includentes historicos dependem dele por transitividade
#include <algorithm>  // idem
#include <cstdint>
#include <cstdlib>
#include <new>
#include <tuple>
#include <utility>

#ifdef STM32L1
#include <FreeRTOS.h>
#include <task.h>
#include <semphr.h>
#elif defined(ESP_PLATFORM)
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#endif

#if defined(STM32L1) || defined(ESP_PLATFORM)

/**
 * @brief Mutex UNICO compartilhado por todas as instancias de Event.
 *
 * Antes cada ctor chamava xSemaphoreCreateMutex(): uma triagem de 2026-10
 * contou ~28 eventos vivos cuja grande maioria NUNCA ganha handler — eram
 * ~2.2-2.8 KB presos no heap interno do FreeRTOS a toa. Agora existe UM so
 * mutex com alocacao estatica (StaticSemaphore_t no BSS, custo ZERO de
 * heap), criado uma unica vez no primeiro uso, dentro de secao critica
 * portMUX (protege a corrida de duas cores/tasks na primeira chamada).
 * Apos criado o handle nunca mais muda, entao a leitura rapida fora da
 * secao critica e estavel.
 */
inline SemaphoreHandle_t eventMutex() {
#if defined(ESP_PLATFORM)
    static StaticSemaphore_t sStorage;
    static portMUX_TYPE sInitLock = portMUX_INITIALIZER_UNLOCKED;
    static SemaphoreHandle_t sHandle = nullptr;
    SemaphoreHandle_t h = sHandle;
    if (h == nullptr) {
        portENTER_CRITICAL(&sInitLock);
        h = sHandle;
        if (h == nullptr) {
            h = xSemaphoreCreateMutexStatic(&sStorage);
            sHandle = h;
        }
        portEXIT_CRITICAL(&sInitLock);
    }
    return h;
#else   // STM32L1: nucleo unico, static local resolve a corrida
    static StaticSemaphore_t sStorage;
    static SemaphoreHandle_t sHandle = xSemaphoreCreateMutexStatic(&sStorage);
    return sHandle;
#endif
}

#define EVENT_LOCK()   xSemaphoreTake(eventMutex(), portMAX_DELAY)
#define EVENT_UNLOCK() xSemaphoreGive(eventMutex())

#else
// Host (testes em g++ puro): sem FreeRTOS, execucao single thread — no-op.
// Sem isto o nucleo nao-template abaixo nao parsearia fora do firmware.
#define EVENT_LOCK()   ((void)0)
#define EVENT_UNLOCK() ((void)0)
#endif

/**
 * @class EventBase
 * @brief Nucleo type-erased do Event: armazenamento e maquinario COMPARTILHADOS
 *        por todas as assinaturas (compilados uma unica vez).
 *
 * A lista de handlers e um array de capacidade FIXA (kMaxHandlers) — sem
 * std::vector e sem heap para a lista. Cada inscricao mora num "box"
 * alocado com malloc pelo Event<Args...> tipado (o box guarda apenas o
 * std::function) e e invocado/destruido via ponteiros de funcao registrados
 * no attachHandler: e isso que permite compilar attach/remove/trigger/dtor
 * UMA vez para todas as instanciacoes (antes cada Event<Args...> emitia seu
 * proprio maquinario de vector, ~350B de flash por assinatura).
 *
 * Reentrancia: triggerBase() copia o array de entradas PARA A PILHA sob o
 * lock (entradas triviais; zero alocacao por trigger) e invoca fora dele.
 * removeHandler durante um trigger em curso ADIA a destruicao do box
 * (triggerDepth/pendingFree) porque o snapshot na pilha pode ainda
 * invoca-lo — "removido durante o disparo ainda roda NAQUELE disparo",
 * como sempre foi. A fila drena quando o trigger mais externo termina.
 */
class EventBase {
public:
    using HandlerId = uint32_t;  // 0 = invalido

protected:
    static constexpr unsigned kMaxHandlers = 16;  // mesmo teto do addHandler antigo

    using InvokeFn  = void (*)(void* box, const void* args);
    using DestroyFn = void (*)(void* box);

    /** Invoke nulo do slot aposentado (fila de pendentes cheia; ver removeHandlerImpl). */
    static void noopInvoke(void*, const void*) {}

    EventBase() = default;
    ~EventBase();  // destroi os box pendentes e vivos (sempre fora do lock)

    EventBase(const EventBase&) = delete;
    EventBase& operator=(const EventBase&) = delete;

    /**
     * @brief Registra um box tipado; retorna 0 se o teto estiver cheio
     *        (o caller e dono do box e deve devolve-lo nesse caso).
     */
    HandlerId attachHandler(void* box, InvokeFn invoke, DestroyFn destroy);

    /** @brief Remove por id (id 0 ou desconhecido = no-op, como antes). */
    void removeHandlerImpl(HandlerId id);

    /** @brief Snapshot do array na pilha sob o lock, invocacao fora dele. */
    void triggerBase(const void* args);

private:
    struct Entry {
        HandlerId id;    // 0 = slot livre
        void* box;       // nullptr = slot livre
        InvokeFn invoke;
        DestroyFn destroy;
    };
    struct DeadEntry {
        void* box;
        DestroyFn destroy;
    };

    Entry entries[kMaxHandlers] = {};
    DeadEntry pendingFree[kMaxHandlers] = {};  /**< box destacados aguardando o fim do trigger */
    unsigned pendingCount = 0;
    unsigned triggerDepth = 0;  /**< triggers deste evento em curso (aninhados incluidos) */
    HandlerId nextId = 0;  /**< 0 = ainda sem uso; attachHandler promove para 1 — objeto todo zero-init (BSS) */
};

inline EventBase::~EventBase() {
    // destaca tudo sob o lock e destroi fora dele (contrato do nucleo)
    DeadEntry dead[kMaxHandlers];
    Entry live[kMaxHandlers];
    unsigned nd = 0;
    unsigned nl = 0;
    EVENT_LOCK();
    for (unsigned i = 0; i < pendingCount; ++i) dead[nd++] = pendingFree[i];
    pendingCount = 0;
    for (Entry& e : entries) {
        if (e.box != nullptr) {
            live[nl++] = e;
            e = Entry{};
        }
    }
    EVENT_UNLOCK();
    for (unsigned i = 0; i < nd; ++i) dead[i].destroy(dead[i].box);
    for (unsigned i = 0; i < nl; ++i) live[i].destroy(live[i].box);
}

inline EventBase::HandlerId EventBase::attachHandler(void* box, InvokeFn invoke, DestroyFn destroy) {
    HandlerId id = 0;
    EVENT_LOCK();
    // teto defensivo: registro em rajada nao cresce sem controle
    if (nextId == 0) nextId = 1;  // primeira inscricao deste objeto (zero-init)
    for (unsigned i = 0; i < kMaxHandlers; ++i) {
        if (entries[i].box == nullptr) {
            id = nextId++;
            entries[i] = Entry{id, box, invoke, destroy};
            break;
        }
    }
    EVENT_UNLOCK();
    return id;  // 0 = cheio (nextId comeca em 1, id 0 nunca e emitido)
}

inline void EventBase::removeHandlerImpl(HandlerId id) {
    if (id == 0) return;
    void* box = nullptr;
    DestroyFn destroy = nullptr;
    EVENT_LOCK();
    for (unsigned i = 0; i < kMaxHandlers; ++i) {
        Entry& e = entries[i];
        if (e.box != nullptr && e.id == id) {
            box = e.box;
            destroy = e.destroy;
            e = Entry{};
            if (triggerDepth > 0) {
                if (pendingCount < kMaxHandlers) {
                    // ha snapshot em voo que ainda pode invocar este box:
                    // adia a destruicao para o fim do trigger mais externo
                    pendingFree[pendingCount] = DeadEntry{box, destroy};
                    ++pendingCount;
                    box = nullptr;  // ja agendado, nao destruir agora
                } else {
                    // Fila cheia: era dada como "inatingivel", mas rajada
                    // de add+remove DENTRO do proprio handler enche a fila
                    // (cada par consome um slot) e a remocao seguinte de
                    // um handler ainda vivo no snapshot estourava com
                    // destroy imediato = use-after-free (o snapshot na
                    // pilha aponta para o box). Aposenta o slot: o box
                    // morre so no dtor do evento, o id 0 some do
                    // removeHandler e o invoke vira no-op para os
                    // proximos snapshots (o corrente guarda o invoke
                    // antigo e o handler ainda roda NAQUELE disparo).
                    e = Entry{0, box, &EventBase::noopInvoke, destroy};
                    box = nullptr;
                }
            }
            break;
        }
    }
    EVENT_UNLOCK();
    if (box != nullptr) destroy(box);
}

inline void EventBase::triggerBase(const void* args) {
    // snapshot trivial na pilha: o array pode mudar (add/remove) enquanto os
    // handlers rodam; 16 entradas x 4 palavras e o custo, zero heap.
    Entry snap[kMaxHandlers];
    EVENT_LOCK();
    for (unsigned i = 0; i < kMaxHandlers; ++i) snap[i] = entries[i];
    ++triggerDepth;  // a partir daqui removeHandler so adia
    EVENT_UNLOCK();
    for (Entry& e : snap) {
        if (e.box != nullptr) e.invoke(e.box, args);
    }
    DeadEntry dead[kMaxHandlers];
    unsigned nd = 0;
    EVENT_LOCK();
    --triggerDepth;
    if (triggerDepth == 0) {
        nd = pendingCount;
        for (unsigned i = 0; i < nd; ++i) dead[i] = pendingFree[i];
        pendingCount = 0;
    }
    EVENT_UNLOCK();
    for (unsigned i = 0; i < nd; ++i) dead[i].destroy(dead[i].box);
}

/**
 * @class Event
 * @brief Manages events and their handlers.
 *
 * This class allows you to register handlers (callbacks) that are called when the event is triggered.
 * Handlers can be added or removed dynamically. The class is thread-safe.
 *
 * Contrato (convencao do CelerOS): handlers sao RAPIDOS — so setam flags /
 * copiam valores. O trigger() tira um SNAPSHOT da lista sob o mutex e invoca
 * os handlers FORA do lock: handler que chame addHandler/removeHandler (ou
 * dispare o mesmo evento de volta) nao deadlocka. O snapshot agora sao as
 * entradas triviais copiadas PARA A PILHA — zero alocacao por trigger (antes
 * era um vector no heap a cada disparo).
 *
 * Custo por assinatura: so o thunk de desempacotamento + wrappers finos;
 * todo o maquinario (attach/remove/trigger/dtor) vive UMA vez em EventBase.
 *
 * Mutex: UM so, compartilhado por todas as instancias (ver eventMutex()).
 * As secoes criticas sao minusculas (copia de entradas triviais), entao o
 * compartilhamento nao gera contencao na pratica.
 *
 * removeHandler(id) usa o id devolvido pelo addHandler — std::function nao
 * tem operator== em C++17, e a variante antiga "por valor" nunca compilou
 * (ninguem a instanciou). Um handler removido DURANTE um trigger em curso
 * ainda roda NAQUELE disparo (o snapshot ja foi tirado).
 */
template <typename... Args>
class Event : public EventBase {
public:
    using Handler = std::function<void(Args...)>;
    // HandlerId: herdado de EventBase (uint32_t, 0 = invalido)

    Event() = default;
    ~Event() = default;  // boxes destruidos pelo nucleo (type-erased)

    /**
     * @brief Adds a handler to the event.
     * @param handler The function to be called when the event is triggered.
     * @return HandlerId to use with removeHandler (0 se o registro falhou).
     *
     * Cada inscricao aloca um box (malloc + placement-new) guardando so o
     * std::function — lambdas que capturam apenas `this` cabem no
     * small-buffer, logo o box e a UNICA alocacao. Falha de malloc devolve
     * 0, exatamente como o teto cheio (caminho silencioso, como antes).
     */
    HandlerId addHandler(Handler handler) {
        if (!handler) return 0;
        using Fn = std::function<void(Args...)>;
        Fn* box = static_cast<Fn*>(malloc(sizeof(Fn)));
        if (box == nullptr) return 0;
        new (box) Fn(std::move(handler));
        HandlerId id = attachHandler(box, &Event::thunk, &Event::destroyBox);
        if (id == 0) {  // teto cheio: devolve o box na hora
            box->~Fn();
            free(box);
        }
        return id;
    }

    /**
     * @brief Removes a handler by the id returned by addHandler.
     */
    void removeHandler(HandlerId id) {
        removeHandlerImpl(id);
    }

    /**
     * @brief Triggers the event, calling all registered handlers.
     * @param args Arguments to pass to the handlers.
     *
     * Os argumentos sao empacotados UMA vez num std::tuple<Args...>: refs
     * permanecem refs (handlers veem o mesmo objeto de antes), valores sao
     * copiados como antes.
     */
    void trigger(Args... args) {
        std::tuple<Args...> packed{args...};
        triggerBase(static_cast<const void*>(&packed));
    }

private:
    /** @brief Thunk por assinatura: desempacota a tupla e invoca o box. */
    static void thunk(void* box, const void* args) {
        unpackInvoke(box, args, std::index_sequence_for<Args...>{});
    }

    template <std::size_t... I>
    static void unpackInvoke(void* box, const void* args, std::index_sequence<I...>) {
        const std::tuple<Args...>& packed = *static_cast<const std::tuple<Args...>*>(args);
        (*static_cast<std::function<void(Args...)>*>(box))(std::get<I>(packed)...);
    }

    /** @brief Destrutor tipado do box (chamado pelo nucleo, fora do lock). */
    static void destroyBox(void* box) {
        static_cast<std::function<void(Args...)>*>(box)->~function();
        free(box);
    }
};

#endif // EVENT_H
