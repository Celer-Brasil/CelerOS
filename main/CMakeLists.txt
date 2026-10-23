# Componente principal do CelerOS.
#
# FONTOs sao adicionados conforme os modulos sao portados do Arduino para o
# ESP-IDF (WiFi/httpd/OTA/FS ainda nao entram no build). O spike_main.cpp e
# o entry point provisorio ate main.cpp virar app_main().

# USB device nativo (TinyUSB, CDC dupla) so para placas com GPIO19/20 livres
# e habilitacao explicita (CELEROS_USB_NATIVE). Na SmartDisplay 4848S040 o
# GPIO19 e o SDA do touch GT911: o celerctl roda na UART via SerialLink.
set(CELEROS_SRCS
    "Assets/Fonts/CelerFonts.cpp"
    "Hardware/BoardIO.cpp"
    "Display/ScreenCapture.cpp"
    "main.cpp"
    "Compat/CelerCompat.cpp"
    "FileSystem/FileSystem.cpp"
    "Display/Backlight.cpp"
    "Display/Icon.cpp"
    "WebManager/WebManager.cpp"
    "WebManager/WebAuth.cpp"
    "WebManager/WifiSetupPortal.cpp"
    "OTA/OtaManager.cpp"
    "Kernel/Core/CelerKernel.cpp"
    "Kernel/AppRunner.cpp"
    "Kernel/TimeManager.cpp"
    "Kernel/Alarms.cpp"
    "Kernel/Notifications.cpp"
    "Kernel/Services.cpp"
    "Kernel/AppServices.cpp"
    "Kernel/DeviceStats.cpp"
    "Launcher/LauncherUI.cpp"
    "Runtime/JSBindings.cpp"
    "Runtime/JsGfx.cpp"
    "Runtime/JsUi.cpp"
    "Runtime/JsSystem.cpp"
    "Runtime/JsNet.cpp"
    "Runtime/JsAi.cpp"
    "Runtime/JsFs.cpp"
    "Runtime/JsKeypad.cpp"
    "Runtime/JsSystemApps.cpp"
    "Runtime/JsTimers.cpp"
    "Runtime/JsSvc.cpp"
    "Runtime/JsModules.cpp"
    "Runtime/JsStorage.cpp"
    "Runtime/JsSensors.cpp"
    "Settings/TouchCalibrator.cpp"
    "Utils/PinStore.cpp"
    "Utils/CelerSettings.cpp"
    "Utils/AppGrants.cpp"
    "Utils/AppZip.cpp"
    "Utils/AppPackage.cpp"
    "USBDevice/USBDevice.cpp"
    "USBDevice/CelerShell.cpp"
    "USBDevice/DebugBridge.cpp"
    "USBDevice/HostLink.cpp"
    "USBDevice/JsDebugger.cpp"
    "USBDevice/LogPersist.cpp"
    "USBDevice/SerialLink.cpp"
    "UI/Kui.cpp"
    "UI/Keyboard.cpp"
    "Launcher/Screens.cpp"
    "Launcher/AlarmScreen.cpp"
    "Launcher/WatchPanels.cpp"
    "Launcher/NotificationAlert.cpp"
    "Hardware/Buttons.cpp"
    "Hardware/InputBus.cpp"
    "Runtime/JsInput.cpp"
    "Hardware/PowerPolicy.cpp"
    "Display/ScreenPower.cpp"
)
if(CONFIG_CELEROS_JS_GPIO)
    list(APPEND CELEROS_SRCS "Runtime/JsGpio.cpp")
endif()
# Audio digital (I2S) — CELEROS_AUDIO: player WAV/QOA (PcmFeed do AI.speak
# incluido), sintetizador chiptune e o decodificador QOA. O tom analogico
# (LEDC) do BoardIO fica no build: e o caminho do System.playTone em toda
# placa (a CYD tem alto-falante analogico). Sem a opcao, os stubs inline dos
# headers (AudioPlayer.h/MusicSynth.h/BoardIO.h) mantem os contratos JS.
if(CONFIG_CELEROS_AUDIO)
    list(APPEND CELEROS_SRCS "Hardware/AudioPlayer.cpp" "Hardware/MusicSynth.cpp" "Hardware/Audio/qoa.c")
endif()
# Microfone (I2S1 de captura + objeto Mic) — CELEROS_MIC: cao e watch.
if(CONFIG_CELEROS_MIC)
    list(APPEND CELEROS_SRCS "Runtime/JsMic.cpp")
endif()
# Fisica nativa (verlet) — CELEROS_JS_PHYSICS: a dep celeros.physics
# feature-detecta; sem o binding, P.verletFast sai e o P.verlet JS segue.
if(CONFIG_CELEROS_JS_PHYSICS)
    list(APPEND CELEROS_SRCS "Runtime/JsPhysics.cpp")
endif()
# Camera (API 35): bindings + driver esp32-camera (managed, entra pela regra
# do idf_component.yml) + quirc vendado. O objeto JS so nasce na placa com
# pinos de camera no perfil E app com a permission "camera".
set(CELEROS_CAMERA_REQUIRES)
if(CONFIG_CELEROS_JS_CAMERA)
    list(APPEND CELEROS_SRCS "Runtime/JsCamera.cpp")
    list(APPEND CELEROS_CAMERA_REQUIRES esp32-camera quirc)
endif()
# USB Host (API 48): core generico em C++ (pilha do IDF + transfers crus) e o
# objeto JS USB.*. Nenhum driver de dispositivo mora aqui — impressora/HID
# sao JS sobre a API. CELEROS_USB_HOST nunca convive com USB device (TinyUSB)
# nem com a USJ no mesmo OTG (Kconfig garante).
if(CONFIG_CELEROS_USB_HOST)
    list(APPEND CELEROS_SRCS "USBHost/UsbDesc.cpp" "USBHost/UsbHost.cpp" "Runtime/JsUsb.cpp")
endif()
# Perfil sem vidro (CELEROS_UI=n, placas headless): a pilha de video sai do
# build — Kui, launcher visual, capturas, icones, fontes e as bindings de
# desenho. O catalogo do LauncherUI (scan/launch/autostart) fica: sem ele o
# shell/web nao abre app nenhum. LovyanGFX segue no REQUIRES: e header-only
# e o BoardDisplay stub do devkit deriva dele (o custo real eram as fontes).
if(NOT CONFIG_CELEROS_UI)
    list(REMOVE_ITEM CELEROS_SRCS
        "Assets/Fonts/CelerFonts.cpp"
        "Display/ScreenCapture.cpp"
        "Display/Icon.cpp"
        "UI/Kui.cpp"
        "UI/Keyboard.cpp"
        "Settings/TouchCalibrator.cpp"
        "Launcher/Screens.cpp"
        "Launcher/AlarmScreen.cpp"
        "Launcher/WatchPanels.cpp"
        "Launcher/NotificationAlert.cpp"
        "Runtime/JsGfx.cpp"
        "Runtime/JsUi.cpp"
        "Runtime/JsKeypad.cpp"
    )
endif()
# Aceleradores de jogo (API 33): corpo rigido nativo; o drawSprite vive no
# JsGfx.cpp atras do mesmo #if
if(CONFIG_CELEROS_JS_GAME_ACCEL)
    list(APPEND CELEROS_SRCS "Runtime/JsRigid.cpp")
endif()
# Wake word on-device "Hi Celer" (microWakeWord proprio sobre TFLite Micro):
# detector em task propria + objeto WakeWord + o frontend de features
# (vendored, mesma pipeline do treino). So no build da placa que ligar.
if(CONFIG_CELEROS_WAKE_WORD)
    file(GLOB CELEROS_WAKE_FRONTEND CONFIGURE_DEPENDS
         "Hardware/Wake/frontend/tensorflow/lite/experimental/microfrontend/lib/*.cc")
    list(APPEND CELEROS_SRCS "Hardware/WakeWord.cpp" "Runtime/JsWake.cpp"
         ${CELEROS_WAKE_FRONTEND})
    # alocacoes pequenas do frontend na PSRAM (ver Hardware/Wake/psram_alloc.h)
    set_source_files_properties(${CELEROS_WAKE_FRONTEND} PROPERTIES COMPILE_OPTIONS
        "-include;${CMAKE_CURRENT_SOURCE_DIR}/Hardware/Wake/psram_alloc.h")
endif()
# esp_driver_usb_serial_jtag: so e puxado pelo SerialLink com
# CELEROS_LINK_ON_USJ (dog); nas demais boards o linker descarta o driver
set(CELEROS_PRIV_REQUIRES esp_driver_uart esp_driver_usb_serial_jtag)
# (depois do set acima: um append antes dele era sobrescrito)
if(CONFIG_CELEROS_WAKE_WORD)
    list(APPEND CELEROS_PRIV_REQUIRES esp-tflite-micro)
endif()
if(CONFIG_CELEROS_USB_NATIVE)
    list(APPEND CELEROS_PRIV_REQUIRES esp_tinyusb)
else()
    list(REMOVE_ITEM CELEROS_SRCS "USBDevice/USBDevice.cpp")
endif()
# Celer Link (Bluetooth BLE entre CelerOS) + CelerNet (malha por flood de
# advertising, API 26) + Pack (matilha: caps/envelopes/handoff de musica,
# API 27): NimBLE C API do IDF, sem wrapper. As fontes somem do build
# quando o board nao liga o BT — os objetos JS CelerLink/CelerNet/Pack
# simplesmente nao existem. O bt vai no REQUIRES publico (padrao dos
# exemplos NimBLE do IDF): os headers do host entram no include path do main.
set(CELEROS_BT_REQUIRES)
if(CONFIG_CELEROS_BLUETOOTH)
    list(APPEND CELEROS_SRCS "Bluetooth/CelerLink.cpp" "Bluetooth/CelerNet.cpp" "Bluetooth/NetKeys.cpp" "Pack/Pack.cpp" "Pack/PackId.cpp" "Pack/Provision.cpp" "Pack/Resources.cpp" "Pack/DataLink.cpp" "Pack/AudioRes.cpp" "Pack/CamRes.cpp" "Pack/GpioRes.cpp" "Pack/SensorRes.cpp" "Pack/Reflex.cpp" "Runtime/JsLink.cpp" "Runtime/JsMesh.cpp" "Runtime/JsPack.cpp")
    list(APPEND CELEROS_BT_REQUIRES bt esp_ringbuf)  # esp_ringbuf: RX do ESP-NOW (Pack/DataLink)
    if(CONFIG_CELEROS_PHONE_LINK)
        list(APPEND CELEROS_SRCS "Bluetooth/PhoneLink.cpp" "Runtime/JsPhone.cpp" "Launcher/PhoneScreens.cpp")
    endif()
endif()

# ---- HAL de placas: exatamente um Boards/<placa>/Board.cpp entra no build,
# e o diretorio da placa entra no include path (BoardDisplay.h resolve para
# a placa certa). Nenhum outro arquivo pode conter #ifdef de placa.
if(NOT CELEROS_BOARD)
    set(CELEROS_BOARD "smartdisplay" CACHE STRING "CelerOS target board")
endif()
if(CELEROS_BOARD STREQUAL "smartdisplay")
    set(CELEROS_BOARD_DIR Boards/smartdisplay)
elseif(CELEROS_BOARD STREQUAL "cyd")
    set(CELEROS_BOARD_DIR Boards/cyd)
elseif(CELEROS_BOARD STREQUAL "cyd-vspi")
    set(CELEROS_BOARD_DIR Boards/cyd-vspi)
elseif(CELEROS_BOARD STREQUAL "spotpear-dog")
    set(CELEROS_BOARD_DIR Boards/spotpear-dog)
    # Watchdog de bateria no deep sleep: ULP-RISC-V le o ADC1 do divisor
    list(APPEND CELEROS_SRCS "${CELEROS_BOARD_DIR}/DogUlp.cpp")
    set(CELEROS_ULP_APP ulp_dog)
    set(CELEROS_ULP_SOURCES "Boards/spotpear-dog/ulp/ulp_main.c")
    set(CELEROS_ULP_REQUIRES ulp)
    set(CELEROS_ULP_EXP "${CELEROS_BOARD_DIR}/DogUlp.cpp")
elseif(CELEROS_BOARD STREQUAL "waveshare-watch")
    set(CELEROS_BOARD_DIR Boards/waveshare-watch)
    # Servico de movimento (QMI8658: pedometro + raise) e exclusivo do watch
    list(APPEND CELEROS_SRCS "${CELEROS_BOARD_DIR}/Motion.cpp")
    # Sentinela ULP do deep sleep (ulp/): o WatchUlp.cpp inclui o header
    # gerado ulp_watch.h; o binario e embutido no app pela macro abaixo.
    list(APPEND CELEROS_SRCS "${CELEROS_BOARD_DIR}/WatchUlp.cpp")
    set(CELEROS_ULP_APP ulp_watch)
    set(CELEROS_ULP_SOURCES "Boards/waveshare-watch/ulp/ulp_main.c")
    set(CELEROS_ULP_REQUIRES ulp)
    set(CELEROS_ULP_EXP "${CELEROS_BOARD_DIR}/WatchUlp.cpp")
elseif(CELEROS_BOARD STREQUAL "devkit")
    set(CELEROS_BOARD_DIR Boards/devkit)
elseif(CELEROS_BOARD STREQUAL "devkit-s3")
    set(CELEROS_BOARD_DIR Boards/devkit-s3)
elseif(CELEROS_BOARD STREQUAL "esp32-cam")
    set(CELEROS_BOARD_DIR Boards/esp32-cam)
else()
    message(FATAL_ERROR "CELEROS_BOARD='${CELEROS_BOARD}' desconhecida (opcoes: smartdisplay | cyd | cyd-vspi | spotpear-dog | waveshare-watch | devkit | devkit-s3 | esp32-cam)")
endif()
list(APPEND CELEROS_SRCS "${CELEROS_BOARD_DIR}/Board.cpp")

idf_component_register(
    SRCS
        ${CELEROS_SRCS}
    INCLUDE_DIRS
        "."
        "Compat"
        "Hardware/Wake/frontend"
    REQUIRES
        LovyanGFX
        driver
        esp_adc
        esp_driver_rmt
        esp_driver_touch_sens
        esp_driver_tsens
        esp_timer
        spi_flash
        esp_hw_support
        fatfs
        sdmmc
        joltwallet__esp_littlefs
        mbedtls
        Network
        Http
        System
        esp_https_ota
        app_update
        espcoredump
        nvs_flash
        esp_wifi
        esp_coex  # CelerNet: bits de malha no agendador WiFi x BLE (sempre no build pelo WiFi)
        bblanchon__arduinojson
        lwip
        esp_netif
        duktape
        ${CELEROS_BT_REQUIRES}
        ${CELEROS_CAMERA_REQUIRES}
        ${CELEROS_ULP_REQUIRES}
    PRIV_REQUIRES
        ${CELEROS_PRIV_REQUIRES}
)

# Programa ULP-RISC-V (watch): build externo pelo IDF, binario embutido no
# componente. O 3o argumento e a fonte que inclui o header gerado (dep. de
# rebuild). Vars vazias nas outras placas = bloco vira no-op.
if(CELEROS_ULP_APP)
    # IDF 6.1: os includes do componente ulp nao chegam ao projeto externo
    # (COMPONENT_INCLUDES = INTERFACE_INCLUDE_DIRECTORIES do main) pela via
    # normal do REQUIRES — mesma quirk do bt/NimBLE abaixo. Caminho explicito.
    set_property(TARGET ${COMPONENT_LIB} APPEND PROPERTY INTERFACE_INCLUDE_DIRECTORIES
        "$ENV{IDF_PATH}/components/ulp/ulp_common/include"
        "$ENV{IDF_PATH}/components/ulp/ulp_riscv/include")
    ulp_embed_binary(${CELEROS_ULP_APP} "${CELEROS_ULP_SOURCES}"
                     "${CELEROS_ULP_EXP}" TYPE riscv)
    # ... e o WatchUlp.cpp (lado main) tambem nao ve ulp_riscv.h/ulp_common.h
    target_include_directories(${COMPONENT_LIB} PRIVATE
        "$ENV{IDF_PATH}/components/ulp/ulp_common/include"
        "$ENV{IDF_PATH}/components/ulp/ulp_riscv/include")
endif()

target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_LIST_DIR}/${CELEROS_BOARD_DIR}")

# IDF 6.1: os includes do host NimBLE nao chegam ao main via REQUIRES bt
# (o alvo do bt registra a lista depois do main). Caminhos explicitos —
# o mesmo conjunto que bt/host/nimble/CMakeLists.txt exporta como publico.
if(CONFIG_CELEROS_BLUETOOTH)
    set(CELEROS_NIMBLE $ENV{IDF_PATH}/components/bt/host/nimble)
    # pasta do esp_bt.h por alvo: o bt mapeia S3 -> esp32c3 (TARGET_SRC_NAME
    # em components/bt/CMakeLists.txt; nao existe include/esp32s3)
    if(CONFIG_IDF_TARGET_ESP32S3)
        set(CELEROS_BT_CTRL_INC esp32c3)
    else()
        set(CELEROS_BT_CTRL_INC ${IDF_TARGET})
    endif()
    target_include_directories(${COMPONENT_LIB} PRIVATE
        "${CELEROS_NIMBLE}/nimble/porting/nimble/include"
        "${CELEROS_NIMBLE}/nimble/porting/npl/esp-idf/include"
        "${CELEROS_NIMBLE}/nimble/nimble/host/include"
        "${CELEROS_NIMBLE}/nimble/nimble/include"
        "${CELEROS_NIMBLE}/nimble/nimble/host/services/gap/include"
        "${CELEROS_NIMBLE}/nimble/nimble/host/services/gatt/include"
        "${CELEROS_NIMBLE}/nimble/nimble/host/util/include"
        "${CELEROS_NIMBLE}/nimble/nimble/transport/include"
        "${CELEROS_NIMBLE}/port/include"
        "$ENV{IDF_PATH}/components/bt/porting/include"
        "$ENV{IDF_PATH}/components/bt/porting_btdm/controller/btdm_common/include"
        # esp_bt.h do controlador (potencia de TX no ESP32 classico, CelerLink)
        "$ENV{IDF_PATH}/components/bt/include/${CELEROS_BT_CTRL_INC}/include"
        # freertos/ringbuf.h: RX do ESP-NOW dos recursos (Pack/DataLink)
        "$ENV{IDF_PATH}/components/esp_ringbuf/include"
    )
endif()

# IDF 6.1: os includes do quirc nao chegam ao main pela via normal do
# REQUIRES (mesma quirk do bt/NimBLE acima) — caminho explicito.
if(CONFIG_CELEROS_JS_CAMERA)
    target_include_directories(${COMPONENT_LIB} PRIVATE
        "${CMAKE_CURRENT_LIST_DIR}/../components/quirc/lib")
endif()

# ---- Paginas web: o .html e a fonte; o build gera o .gz (servido com
# Content-Encoding: gzip) e embute so ele — ~4x menos flash que o texto cru.
idf_build_get_property(python PYTHON)
set(CELEROS_WEB_PAGES)
if(CONFIG_CELEROS_WEB_SERVER)
    set(CELEROS_WEB_PAGES WebManager/filemanager.html WebManager/ota_upload.html)
    if(CONFIG_CELEROS_UI)
        list(APPEND CELEROS_WEB_PAGES WebManager/screen.html)
    endif()
endif()
foreach(page ${CELEROS_WEB_PAGES})
    get_filename_component(page_name ${page} NAME)
    set(page_gz "${CMAKE_CURRENT_BINARY_DIR}/${page_name}.gz")
    add_custom_command(
        OUTPUT ${page_gz}
        COMMAND ${python} -c "import gzip,sys; open(sys.argv[2],'wb').write(gzip.compress(open(sys.argv[1],'rb').read(), 9, mtime=0))"
                "${CMAKE_CURRENT_SOURCE_DIR}/${page}" ${page_gz}
        DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/${page}"
        VERBATIM)
    add_custom_target(celeros_web_${page_name} DEPENDS ${page_gz})
    add_dependencies(${COMPONENT_LIB} celeros_web_${page_name})
    target_add_binary_data(${COMPONENT_LIB} ${page_gz} BINARY)
endforeach()

target_compile_definitions(${COMPONENT_LIB} PRIVATE
    CELEROS_VERSION="1.10.1"
    CELEROS_API_LEVEL=49
)

# F3: app JS em task propria ("celerapp") — opt-in via Kconfig
if(CONFIG_CELEROS_APP_TASK)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CELEROS_APP_TASK=1)
endif()
