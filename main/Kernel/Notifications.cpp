#include "Notifications.h"
#include "esp_log.h"
#include "../FileSystem/FileSystem.h"
#include "../Launcher/NotificationAlert.h"
#include "../Utils/CelerSettings.h"
#include "../Display/ScreenPower.h"
#include "../Display/Theme.h"
#include "../UI/Kui.h"
#include "../Utils/GbProto.h"
#include "esp_timer.h"
#include <atomic>
#include <mutex>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

namespace {

const char* NF = "/local/notifications.txt";
std::recursive_mutex s_mux;
// Ordena as escritas do arquivo (tick x clear): sempre tomado ANTES do s_mux
std::mutex s_writeMux;
bool s_loaded = false;
std::vector<Notifications::Note> s_notes;  // mais antiga primeiro (ordem do arquivo)
int s_dnd = -1;                            // -1 = ler do NVS
void (*s_onDismiss)(uint32_t, bool) = nullptr;
// Gravacao adiada: push/remove vem da task do BLE e cada um regravava o
// arquivo inteiro (ate ~6 KB) no LittleFS, bloqueando o host NimBLE. O tick
// (service ALWAYS) consolida rajadas em no maximo 1 escrita/s.
// Atomico: o tick roda em todo present(). Sem a flag, cada quadro de jogo
// pegava os dois mutex so para descobrir que nao havia nada para gravar.
std::atomic<bool> s_dirty{false};
std::atomic<uint32_t> s_dirtyAtMs{0};
constexpr uint32_t kFlushMs = 1000;

uint32_t nowMs() { return (uint32_t)(esp_timer_get_time() / 1000); }

// So o que a fonte desenha (Latin-1), sem cortar UTF-8 ao meio; '|' e o
// separador do arquivo
std::string clean(const std::string& in, size_t maxLen) {
    std::string out = celer::gb::latin1Safe(in, maxLen);
    for (char& ch : out) {
        if (ch == '|') ch = '/';
    }
    return out;
}

void loadLocked() {
    if (s_loaded) return;
    s_loaded = true;
    s_notes.clear();
    std::string hist = FileSystem::readTextFile(NF);
    size_t pos = 0;
    while (pos < hist.size()) {
        size_t eol = hist.find('\n', pos);
        if (eol == std::string::npos) eol = hist.size();
        // Linha legivel tem no max ~300 bytes (clean() limita titulo 64 +
        // msg 160 + src 24 + numericos). Linha maior e lixo de gravacao
        // corrompida: alocar strings sem limite na CYD sem PSRAM aborta —
        // o teste vem ANTES do substr justamente para nao alocar.
        if (eol - pos > 512) {
            pos = eol + 1;
            continue;
        }
        std::string line = hist.substr(pos, eol - pos);
        pos = eol + 1;
        if (!line.empty() && line.back() == '\r') line.pop_back();  // CRLF de edicao manual
        std::vector<std::string> f;
        size_t a = 0;
        while (true) {
            size_t b = line.find('|', a);
            f.push_back(line.substr(a, b == std::string::npos ? std::string::npos : b - a));
            if (b == std::string::npos) break;
            a = b + 1;
        }
        if (f.size() < 3) continue;
        Notifications::Note n;
        n.epoch = atoll(f[0].c_str());
        n.title = clean(f[1], 64);
        n.msg = clean(f[2], 160);
        if (f.size() >= 6) {
            n.src = clean(f[3], 24);
            n.id = (uint32_t)strtoul(f[4].c_str(), nullptr, 10);
            n.read = f[5] == "1";
        } else {
            n.read = true;  // historico da API 12: ja visto
        }
        s_notes.push_back(n);
    }
    // O arquivo pode ter mais que MAX (firmware antigo, edicao manual):
    // carregar tudo violaria o teto de RAM do centro de notificacoes.
    while ((int)s_notes.size() > Notifications::MAX) s_notes.erase(s_notes.begin());
}

// Serializa o historico (sob s_mux). Sem temporarios: o title + "|" + ...
// de antes alocava 3 strings intermediarias por nota.
std::string serializeLocked() {
    std::string out;
    size_t need = 0;
    for (const auto& n : s_notes) need += n.title.size() + n.msg.size() + n.src.size() + 40;
    out.reserve(need);
    for (const auto& n : s_notes) {
        char head[48];
        snprintf(head, sizeof(head), "%lld|", (long long)n.epoch);
        out += head;
        out += n.title;
        out += '|';
        out += n.msg;
        out += '|';
        out += n.src;
        out += '|';
        snprintf(head, sizeof(head), "%lu|%d\n", (unsigned long)n.id, n.read ? 1 : 0);
        out += head;
    }
    return out;
}

// Grava FORA do s_mux (so sob s_writeMux): o push da task do BLE nao espera
// a escrita no LittleFS (ms) para enfileirar a proxima notificacao.
void writeOut(const std::string& out) {
    bool ok;
    if (out.empty()) {
        ok = FileSystem::deleteFile(NF);
    } else {
        ok = FileSystem::writeTextFile(NF, out.c_str());
    }
    if (!ok)
        ESP_LOGW("celer.notif", "historico nao gravou em %s (LittleFS cheio?)", NF);
}

// Marca o arquivo como sujo; o tick grava (coalesce rajadas do celular).
void saveLocked() {
    if (!s_dirty.load(std::memory_order_relaxed)) {
        s_dirtyAtMs.store(nowMs(), std::memory_order_relaxed);
        s_dirty.store(true, std::memory_order_release);
    }
}

}  // namespace

namespace Notifications {

void push(const std::string& title, const std::string& msg, const std::string& src,
          uint32_t extId) {
    bool quiet;
    std::string shown;
    {
        std::lock_guard<std::recursive_mutex> lock(s_mux);
        loadLocked();
        if (extId != 0) {
            for (size_t i = 0; i < s_notes.size(); i++) {
                if (s_notes[i].id == extId) {
                    s_notes.erase(s_notes.begin() + i);
                    break;
                }
            }
        }
        Note n;
        time_t now;
        time(&now);
        n.epoch = now;
        n.title = clean(title, 64);
        shown = n.title;
        n.msg = clean(msg, 160);
        n.src = clean(src, 24);
        n.id = extId;
        s_notes.push_back(n);
        while ((int)s_notes.size() > MAX) s_notes.erase(s_notes.begin());
        saveLocked();
        // Nao Perturbe silencia tudo; chamada do celular tambem (a CallScreen
        // toca por conta propria — toast/bipe/alerta competiriam com ela)
        quiet = dnd() || n.src == "phone:call";
    }
    // Bipe + alerta aplicados no proximo tick (task da UI): push pode vir da
    // task do BLE, que nao toca no vidro nem no I2S. No watch o alerta em
    // tela cheia (NotificationAlert) substitui o toast; nas demais placas
    // fica o toast de sempre.
    if (quiet) return;
    ScreenPower::beep();
#if CONFIG_CELEROS_UI
    if (ScreenPower::active()) {
        NotificationAlert::request();
    } else {
        kui::Navigator::toast(shown, THEME_ACCENT, 3000);  // fila cross-task
    }
#else
    // Sem vidro: o aviso do push e o bipe + logcat
    celer_log_printf("[notif] %s\n", shown.c_str());
#endif
}

// Service ALWAYS: consolida as gravacoes adiadas. Roda nos dois pumps
// (celerLoop e present), entao tambem descarrega com app aberto.
void tick() {
    if (!s_dirty.load(std::memory_order_acquire)) return;
    const uint32_t at = s_dirtyAtMs.load(std::memory_order_relaxed);
    if ((uint32_t)(nowMs() - at) < kFlushMs) return;
    std::lock_guard<std::mutex> wlock(s_writeMux);
    std::string out;
    {
        std::lock_guard<std::recursive_mutex> lock(s_mux);
        if (!s_dirty.load(std::memory_order_relaxed)) return;
        if ((uint32_t)(nowMs() - s_dirtyAtMs.load(std::memory_order_relaxed)) < kFlushMs) return;
        s_dirty.store(false, std::memory_order_relaxed);
        out = serializeLocked();
    }
    writeOut(out);
}

std::vector<Note> list() {
    std::lock_guard<std::recursive_mutex> lock(s_mux);
    loadLocked();
    return std::vector<Note>(s_notes.rbegin(), s_notes.rend());
}

bool removeAt(int index) {
    uint32_t extId = 0;
    {
        std::lock_guard<std::recursive_mutex> lock(s_mux);
        loadLocked();
        int real = (int)s_notes.size() - 1 - index;  // list() e invertida
        if (index < 0 || real < 0) return false;
        if (s_notes[real].src.rfind("phone:", 0) == 0) extId = s_notes[real].id;
        s_notes.erase(s_notes.begin() + real);
        saveLocked();
    }
    if (extId != 0 && s_onDismiss) s_onDismiss(extId, false);
    return true;
}

bool removeById(uint32_t extId) {
    if (extId == 0) return false;
    std::lock_guard<std::recursive_mutex> lock(s_mux);
    loadLocked();
    for (size_t i = 0; i < s_notes.size(); i++) {
        if (s_notes[i].id == extId) {
            s_notes.erase(s_notes.begin() + i);
            saveLocked();
            return true;
        }
    }
    return false;
}

void clear() {
    bool hadPhone = false;
    {
        std::lock_guard<std::mutex> wlock(s_writeMux);
        std::lock_guard<std::recursive_mutex> lock(s_mux);
        loadLocked();
        for (const auto& n : s_notes) hadPhone = hadPhone || (n.id != 0 && n.src.rfind("phone:", 0) == 0);
        s_notes.clear();
        FileSystem::deleteFile(NF);
        s_dirty.store(false, std::memory_order_relaxed);  // o arquivo ja sumiu; nada pendente
        s_dirtyAtMs.store(0, std::memory_order_relaxed);
    }
    if (hadPhone && s_onDismiss) s_onDismiss(0, true);
}

void setOnDismiss(void (*cb)(uint32_t id, bool all)) { s_onDismiss = cb; }

int unread() {
    std::lock_guard<std::recursive_mutex> lock(s_mux);
    loadLocked();
    int n = 0;
    for (const auto& x : s_notes) n += x.read ? 0 : 1;
    return n;
}

void markAllRead() {
    std::lock_guard<std::recursive_mutex> lock(s_mux);
    loadLocked();
    bool changed = false;
    for (auto& x : s_notes) {
        if (!x.read) {
            x.read = true;
            changed = true;
        }
    }
    if (changed) saveLocked();
}

bool dnd() {
    std::lock_guard<std::recursive_mutex> lock(s_mux);
    if (s_dnd < 0) s_dnd = CelerSettings::get("dnd", "") == "1" ? 1 : 0;
    return s_dnd == 1;
}

void setDnd(bool on) {
    std::lock_guard<std::recursive_mutex> lock(s_mux);
    s_dnd = on ? 1 : 0;
    CelerSettings::set("dnd", on ? "1" : "");
}

}  // namespace Notifications
