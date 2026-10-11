# Utility Component

Componente utilitário com classes auxiliares e padrões de design para desenvolvimento em ESP32/ESP-IDF.

> **Nota**: Para containers thread-safe (SafeList, SafeMap, SafeQueue, SafeVector), veja o componente [SafeContainers](../SafeContainers/SAFE_CONTAINERS.md).

## Índice

- [Event](#event)
- [Timeout](#timeout)

---

## Event

Sistema de eventos thread-safe para arquitetura event-driven. Permite registrar callbacks que são chamados quando o evento é disparado.

### Características

- **Thread-safe**: Usa mutex FreeRTOS para proteção
- **Variadic templates**: Suporta qualquer número e tipo de argumentos
- **Cross-platform**: Compatível com STM32 e ESP32

### API

```cpp
template <typename... Args>
class Event {
public:
    Event();
    ~Event();
    
    void addHandler(std::function<void(Args...)> handler);
    void removeHandler(std::function<void(Args...)> handler);
    void trigger(Args... args);
};
```

### Exemplo de Uso

```cpp
#include "Event.h"

// Evento sem argumentos
Event<> onButtonPressed;

// Evento com argumentos
Event<int, const std::string&> onDataReceived;

// Registrar handlers
onButtonPressed.addHandler([]() {
    ESP_LOGI("APP", "Botão pressionado!");
});

onDataReceived.addHandler([](int code, const std::string& message) {
    ESP_LOGI("APP", "Dados recebidos: %d - %s", code, message.c_str());
});

// Disparar eventos
onButtonPressed.trigger();
onDataReceived.trigger(200, "OK");
```

### Uso em Classes

```cpp
class SensorManager {
public:
    Event<float> onTemperatureChanged;
    Event<float, float> onHumidityAndTemp;
    Event<> onSensorError;
    
    void readSensor() {
        float temp = readTemperature();
        float humidity = readHumidity();
        
        if (temp != _lastTemp) {
            _lastTemp = temp;
            onTemperatureChanged.trigger(temp);
        }
        
        onHumidityAndTemp.trigger(humidity, temp);
    }
    
private:
    float _lastTemp = 0;
};

// Uso
SensorManager sensor;
sensor.onTemperatureChanged.addHandler([](float temp) {
    ESP_LOGI("APP", "Temperatura: %.2f°C", temp);
});
```

---

## Timeout

Gerenciador de timeout baseado em ticks do FreeRTOS.

### API

```cpp
class Timeout {
public:
    Timeout();
    Timeout(uint32_t timeout, bool start);
    
    void SetTimeout(uint32_t timeout);  // em milissegundos
    void Start();
    void Stop();
    
    bool TrueUntilTimeout();  // true enquanto não expirou
    bool TimeoutOccurred();   // true se expirou
};
```

### Exemplo de Uso

```cpp
#include "Timeout.h"

// Timeout de 5 segundos, iniciado automaticamente
Timeout connectionTimeout(5000, true);

while (TrueUntilTimeout()) {
    if (tryConnect()) {
        connectionTimeout.Stop();
        break;
    }
    vTaskDelay(pdMS_TO_TICKS(100));
}

if (connectionTimeout.TimeoutOccurred()) {
    ESP_LOGE("APP", "Timeout de conexão!");
}

// Reutilizar timeout
connectionTimeout.SetTimeout(10000);
connectionTimeout.Start();
```

### Uso em Loops de Retry

```cpp
Timeout retry(3000, true);
int attempts = 0;

while (!retry.TimeoutOccurred() && attempts < 5) {
    if (sendData()) {
        ESP_LOGI("APP", "Dados enviados!");
        break;
    }
    attempts++;
    vTaskDelay(pdMS_TO_TICKS(500));
}
```

---

## Dependências

Componente header-only (os .cpp mortos — `Utility.cpp`, `CrossPlatformUtility.cpp` — e o `Singleton.h` sairam na triagem de 2026-10, zero chamadores no repo):

```cmake
idf_component_register(
    INCLUDE_DIRS "."
    REQUIRES
        nvs_flash
        esp_driver_gpio
)
```

## Compatibilidade

- ESP-IDF >= 5.0.0
- FreeRTOS
- C++17 ou superior
- Plataformas: ESP32, ESP32-S2, ESP32-S3, ESP32-C3, ESP32-C6
