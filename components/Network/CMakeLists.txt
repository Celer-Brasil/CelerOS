# Rede do CelerOS: dono unico do radio WiFi (NetworkManager), estacao
# (WifiConnection), AP + captive portal de configuracao e credenciais em NVS.
# Junta os antigos componentes Connection + Wifi (que se exigiam em ciclo).
idf_component_register(
    SRCS
        "NetworkManager.cpp"
        "NetworkCredentialStore.cpp"
        "NetworkSelector.cpp"
        "WifiConnection.cpp"
        "WifiAP.cpp"
        "CaptivePortal.cpp"
        "IPAddress.cpp"
        "CredCipher.cpp"
    INCLUDE_DIRS "."
    REQUIRES
        esp_wifi
        esp_netif
        esp_event
        esp_timer
        esp_http_server
        lwip
        nvs_flash
        mbedtls
        Utility
        ErrorCodes
        Storage
)
