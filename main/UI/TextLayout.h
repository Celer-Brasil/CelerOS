#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace kui::textLayout {

// Mede prefixos UTF-8 completos. A janela dobra ate a primeira medida que
// excede a largura; mesmo uma mensagem enorme so e medida perto desta linha.
template <class Fits>
size_t fittingPrefix(const std::string& s, size_t pos, Fits fits) {
    const size_t remaining = s.size() - pos;
    auto boundary = [&](size_t n) {
        while (n && n < remaining && ((uint8_t)s[pos + n] & 0xC0) == 0x80) n--;
        return n;
    };
    size_t lo = 0, hi = std::min<size_t>(32, remaining);
    while (fits(boundary(hi))) {
        if (hi == remaining) return hi;
        lo = hi;
        hi += std::min(hi, remaining - hi);
    }
    while (hi - lo > 1) {
        const size_t mid = lo + (hi - lo) / 2;
        if (fits(boundary(mid))) lo = mid;
        else hi = mid;
    }
    return boundary(lo);
}

template <class Measure>
std::string ellipsize(const std::string& s, int width, Measure measure) {
    if (measure(s.c_str()) <= width) return s;
    if (measure("..") > width) return measure(".") <= width ? "." : "";
    std::string buf;
    auto withDots = [&](size_t n) {
        buf.assign(s, 0, n);
        while (!buf.empty() && buf.back() == ' ') buf.pop_back();
        buf += "..";
    };
    const size_t cut = fittingPrefix(s, 0, [&](size_t n) {
        withDots(n);
        return measure(buf.c_str()) <= width;
    });
    withDots(cut);
    return buf;
}

template <class Measure>
std::vector<std::string> wrap(const std::string& s, int width, int maxLines, Measure measure) {
    std::vector<std::string> lines;
    std::string buf;
    size_t pos = 0;
    for (int ln = 0; ln < maxLines && pos < s.size(); ln++) {
        const size_t remaining = s.size() - pos;
        size_t cut = fittingPrefix(s, pos, [&](size_t n) {
            buf.assign(s, pos, n);
            return measure(buf.c_str()) <= width;
        });
        if (cut < remaining) {
            if (ln + 1 == maxLines) {
                buf.assign(s, pos, cut);
                if (s.find_first_not_of(' ', pos + cut) != std::string::npos) {
                    while (!buf.empty() && buf.back() == ' ') buf.pop_back();
                    buf += "..";
                }
                lines.push_back(ellipsize(buf, width, measure));
                break;
            }
            size_t word = cut;
            while (word > 0 && s[pos + word] != ' ') word--;
            if (word > 0) cut = word;
            if (cut == 0) {  // coluna mais estreita que o glifo: avanca um caractere inteiro
                do { cut++; } while (cut < remaining && ((uint8_t)s[pos + cut] & 0xC0) == 0x80);
            }
        }
        lines.push_back(s.substr(pos, cut));
        pos += cut;
        while (pos < s.size() && s[pos] == ' ') pos++;
    }
    return lines;
}

}  // namespace kui::textLayout
