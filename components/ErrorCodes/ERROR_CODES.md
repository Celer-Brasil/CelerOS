# ErrorCodes Component

Códigos de erro padronizados do CelerOS. Cada `ErrorCode` é um inteiro de 16 bits
por valor: comparação é de inteiros, as constantes são `constexpr` no header e as
descrições legíveis vivem em rodata (flash), sem mapa nem `std::string` em RAM.

## API

```cpp
class ErrorCode {
public:
    ErrorCode();                       // inválido (id 0)
    constexpr explicit ErrorCode(uint16_t id);

    const char* description() const;   // literal em flash, nunca nulo
    bool isValid() const;              // id != 0
    bool operator==(const ErrorCode& other) const;
    bool operator!=(const ErrorCode& other) const;
};
```

- `ErrorCode()` (padrão) é o código **inválido**; qualquer constante nomeada é válida.
- `CommonErrorCodes::None` é o sucesso convencional das funções que retornam `ErrorCode`.
- Para logar: `ESP_LOGE(TAG, "%s", err.description())`.

## Uso

```cpp
#include "CommonErrorCodes.h"   // inclui todas as categorias

ErrorCode connectToServer(const std::string& host) {
    if (host.empty()) return CommonErrorCodes::ArgumentError;
    if (!socket.connect(host)) return CommonErrorCodes::SocketConnectFailed;
    return CommonErrorCodes::None;
}

ErrorCode err = connectToServer("api.example.com");
if (err != CommonErrorCodes::None) {
    if (err == CommonErrorCodes::SocketConnectFailed) retry();
    ESP_LOGE(TAG, "connect falhou: %s", err.description());
}
```

Constantes novas: declarar `inline constexpr ErrorCode Nome{N};` na categoria
apropriada (próximo id livre) e a descrição em `kDescriptions[]` (`ErrorCode.cpp`),
na posição `N-1`, além de subir `kMaxKnownId` (`ErrorCode.h`) para o novo teto.
Os ids são estáveis: dispositivos comparam números, não reordenar nem renumerar.
O id fica documentado na tabela abaixo.

## Referência (id → constante)

| Ids | Categoria | Constantes |
|-----|-----------|------------|
| 1–12 | Gerais (`GeneralErrorCodes.h`) | Invalid, None, UnknownError, OperationFailed, NotImplemented, NotInitialized, ArgumentError, Timeout, CommandAlreadyRegistered, InvalidCommand, ConnectionClosed, ListIsEmpty |
| 13–16 | Rede (`NetworkErrorCodes.h`) | NetworkDown, HostUnreachable, ConnectionRefused, AddressInUse |
| 17–24 | Socket (`NetworkErrorCodes.h`) | SocketClosed, SocketSendFailed, SocketReceiveFailed, SocketCreationFailed, SocketConnectFailed, SocketBindFailed, SocketListenFailed, SocketAcceptFailed |
| 25–31 | WiFi (`WifiErrorCodes.h`) | WifiInitFailed, WifiConnectionFailed, WifiAPStartFailed, WifiScanFailed, WifiNetworkNotFound, WifiAuthFailed, WifiStopFailed |
| 32–35 | Bluetooth (`BluetoothErrorCodes.h`) | BluetoothInitFailed, BluetoothConnectionFailed, BluetoothServiceCreationFailed, BluetoothCharacteristicCreationFailed |
| 36–41 | Arquivos (`FileErrorCodes.h`) | FileNotFound, FileOpenError, FileReadError, FileWriteError, FileExists, FileIsEmpty |
| 42–46 | Armazenamento (`StorageErrorCodes.h`) | StorageInitFailed, StorageReadError, StorageWriteError, StorageNotMounted, StorageFull |
| 47–49 | Usuário (`UserErrorCodes.h`) | AuthenticationFailed, UserNotFound, UserAlreadyExists |
| 50–51 | Hardware (`HardwareErrorCodes.h`) | SensorError, DeviceNotResponding |
| 52–54 | Comunicação (`CommunicationErrorCodes.h`) | CommunicationError, CommunicationTimeout, ChecksumError |

## Build

```cmake
idf_component_register(SRCS "ErrorCode.cpp" INCLUDE_DIRS ".")
```

Consumidores declaram `REQUIRES ErrorCodes` no próprio `CMakeLists.txt`
(fazem isso `components/Network` e `components/Storage`).

## Compatibilidade

- ESP-IDF >= 5.0.0, C++17 ou superior
- Plataformas: ESP32, ESP32-S2, ESP32-S3, ESP32-C3, ESP32-C6
