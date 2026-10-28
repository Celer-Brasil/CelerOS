#include "ErrorCode.h"

#include <cstddef>

namespace {

// Descricoes dos codigos, indexadas por id-1 (ver ERROR_CODES.md).
// Literais ficam em rodata; nao ha mapa nem string em RAM.
const char* const kDescriptions[] = {
    /*  1 Invalid */ "Invalid error code",
    /*  2 None */ "No error occurred",
    /*  3 UnknownError */ "An unexpected error occurred",
    /*  4 OperationFailed */ "The requested operation failed",
    /*  5 NotImplemented */ "Functionality not implemented yet",
    /*  6 NotInitialized */ "Component not initialized",
    /*  7 ArgumentError */ "Invalid argument provided",
    /*  8 Timeout */ "Operation timed out",
    /*  9 CommandAlreadyRegistered */ "Command already registered",
    /* 10 InvalidCommand */ "Invalid command received",
    /* 11 ConnectionClosed */ "Connection is closed",
    /* 12 ListIsEmpty */ "The list is empty",
    /* 13 NetworkDown */ "Network connection is down",
    /* 14 HostUnreachable */ "Host is unreachable",
    /* 15 ConnectionRefused */ "Connection refused",
    /* 16 AddressInUse */ "Network address is in use",
    /* 17 SocketClosed */ "Socket is closed",
    /* 18 SocketSendFailed */ "Failed to send data through socket",
    /* 19 SocketReceiveFailed */ "Failed to receive data from socket",
    /* 20 SocketCreationFailed */ "Failed to create socket",
    /* 21 SocketConnectFailed */ "Failed to connect socket",
    /* 22 SocketBindFailed */ "Failed to bind socket",
    /* 23 SocketListenFailed */ "Failed to listen on socket",
    /* 24 SocketAcceptFailed */ "Failed to accept connection on socket",
    /* 25 WifiInitFailed */ "WiFi initialization failed",
    /* 26 WifiConnectionFailed */ "Failed to connect to WiFi network",
    /* 27 WifiAPStartFailed */ "Failed to start WiFi Access Point",
    /* 28 WifiScanFailed */ "WiFi scan for networks failed",
    /* 29 WifiNetworkNotFound */ "The specified WiFi network was not found",
    /* 30 WifiAuthFailed */ "WiFi authentication failed",
    /* 31 WifiStopFailed */ "Failed to stop WiFi",
    /* 32 BluetoothInitFailed */ "Bluetooth initialization failed",
    /* 33 BluetoothConnectionFailed */ "Failed to establish Bluetooth connection",
    /* 34 BluetoothServiceCreationFailed */ "Failed to create Bluetooth service",
    /* 35 BluetoothCharacteristicCreationFailed */ "Failed to create Bluetooth characteristic",
    /* 36 FileNotFound */ "File not found",
    /* 37 FileOpenError */ "Error opening file",
    /* 38 FileReadError */ "Error reading from file",
    /* 39 FileWriteError */ "Error writing to file",
    /* 40 FileExists */ "File already exists",
    /* 41 FileIsEmpty */ "File is empty",
    /* 42 StorageInitFailed */ "Storage device initialization failed",
    /* 43 StorageReadError */ "Error reading from storage device",
    /* 44 StorageWriteError */ "Error writing to storage device",
    /* 45 StorageNotMounted */ "Storage device not mounted",
    /* 46 StorageFull */ "Storage device is full",
    /* 47 AuthenticationFailed */ "User authentication failed",
    /* 48 UserNotFound */ "User not found",
    /* 49 UserAlreadyExists */ "User already exists",
    /* 50 SensorError */ "Sensor reading failed or is invalid",
    /* 51 DeviceNotResponding */ "Hardware device not responding",
    /* 52 CommunicationError */ "A communication error occurred",
    /* 53 CommunicationTimeout */ "Communication timeout",
    /* 54 ChecksumError */ "Checksum or CRC verification failed",
};

const size_t kDescriptionCount = sizeof(kDescriptions) / sizeof(kDescriptions[0]);

// kMaxKnownId (ErrorCode.h) precisa cobrir a tabela inteira
static_assert(kDescriptionCount == 54, "kMaxKnownId fora de sincronia com kDescriptions");

} // namespace

const char* ErrorCode::description() const {
    if (!isValid()) {
        return "Invalid Error Code";
    }
    return kDescriptions[_id - 1];
}
