cmake_minimum_required(VERSION 3.16)

# Placa alvo: smartdisplay | cyd | cyd-vspi | spotpear-dog | waveshare-watch.
# Passar no configure: idf.py -DCELEROS_BOARD=cyd ...
set(CELEROS_BOARD "smartdisplay" CACHE STRING "CelerOS target board")

# sdkconfig POR DIRETORIO DE BUILD. Sem -DSDKCONFIG o IDF usa o sdkconfig da
# RAIZ, compartilhado por todo build dir configurado assim: em 2026-11-06 o
# build do watch gravou nele USB_NATIVE/PHONE_LINK/32MB e o build seguinte do
# 4848 herdou tudo — o TinyUSB tomou o GPIO19 (SDA do GT911) e o touch morreu.
# Aqui o default vira <build>/sdkconfig e os defaults da placa entram sozinhos;
# -DSDKCONFIG/-DSDKCONFIG_DEFAULTS explicitos (CI, comandos do AGENTS) vencem.
if(NOT SDKCONFIG)
    set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig" CACHE STRING "sdkconfig deste build dir")
endif()
if(NOT SDKCONFIG_DEFAULTS AND NOT DEFINED ENV{SDKCONFIG_DEFAULTS})
    set(SDKCONFIG_DEFAULTS "sdkconfig.defaults;boards/${CELEROS_BOARD}/sdkconfig.defaults")
endif()


include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(CelerOS VERSION 1.18.0)
