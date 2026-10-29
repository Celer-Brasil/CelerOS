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

# Pagina do captive portal: o .html e a fonte; o build gera o .gz (servido
# com Content-Encoding: gzip) e embute so ele, como em main/WebManager.
idf_build_get_property(python PYTHON)
set(portal_gz "${CMAKE_CURRENT_BINARY_DIR}/captive_portal.html.gz")
add_custom_command(
    OUTPUT ${portal_gz}
    COMMAND ${python} -c "import gzip,sys; open(sys.argv[2],'wb').write(gzip.compress(open(sys.argv[1],'rb').read(), 9, mtime=0))"
            "${CMAKE_CURRENT_SOURCE_DIR}/captive_portal.html" ${portal_gz}
    DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/captive_portal.html"
    VERBATIM)
add_custom_target(celeros_web_captive_portal DEPENDS ${portal_gz})
add_dependencies(${COMPONENT_LIB} celeros_web_captive_portal)
target_add_binary_data(${COMPONENT_LIB} ${portal_gz} BINARY)
