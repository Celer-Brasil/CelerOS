cmake_minimum_required(VERSION 3.16)

# Placa alvo: smartdisplay | cyd | cyd-vspi | spotpear-dog | waveshare-watch.
# Passar no configure: idf.py -DCELEROS_BOARD=cyd ...
set(CELEROS_BOARD "smartdisplay" CACHE STRING "CelerOS target board")


include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(CelerOS VERSION 1.12.0)
