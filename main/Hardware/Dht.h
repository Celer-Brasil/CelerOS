#pragma once

// ============================================================================
// Dht — leitura do DHT11/DHT22 (temperatura e umidade) por 1-wire.
//
// API JS (API 55): System.dht.read(pin, tipo). O protocolo e sensivel a
// microssegundos (50 us de low + 26..70 us de high por bit), entao vive no
// C++ com a janela critica curta; o app recebe os valores ja decodificados.
// O sensor precisa de pull-up no data (o modulo traz) e VCC 3,3 V (o data
// do modulo alimentado em 5 V nao e tolerante no ESP32).
//
// O driver cacheia a ultima leitura por (pino, tipo) pelo intervalo minimo
// do chip (DHT11 1 s, DHT22 2 s): chamar em loop nao martela o sensor.
// ============================================================================

namespace Dht {

struct Reading {
    bool ok = false;
    float tempC = 0;
    float humidity = 0;
    const char* error = "";
};

// Le o sensor no pino (tipo 11 ou 22). out recebe o resultado (ok=false e
// error preenchido em timeout/checksum/sem resposta). Devolve out->ok.
bool read(int pin, int type, Reading* out);

// Fim do app: limpa o cache (o proximo app nao herda leitura do anterior).
void reset();

}  // namespace Dht
