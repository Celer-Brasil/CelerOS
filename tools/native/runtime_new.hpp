// operator new/delete freestanding para blobs CLRN v2 (C++).
// Incluido no TU unico do blob DEPOIS do runtime.c. Sem excecoes, o new
// normal tambem devolve nullptr em OOM — os dois caminhos sao malloc.
#pragma once

#include <new>
#include <stddef.h>

void* malloc(size_t n);
void free(void* p);

void* operator new(size_t n) noexcept { return malloc(n); }
void* operator new[](size_t n) noexcept { return malloc(n); }
void* operator new(size_t n, const std::nothrow_t&) noexcept { return malloc(n); }
void* operator new[](size_t n, const std::nothrow_t&) noexcept { return malloc(n); }
void operator delete(void* p) noexcept { free(p); }
void operator delete[](void* p) noexcept { free(p); }
void operator delete(void* p, const std::nothrow_t&) noexcept { free(p); }
void operator delete[](void* p, const std::nothrow_t&) noexcept { free(p); }
// sized delete (C++14): o compilador chama a variante com tamanho
void operator delete(void* p, size_t) noexcept { free(p); }
void operator delete[](void* p, size_t) noexcept { free(p); }
