idf_component_register(SRCS "calls.c" INCLUDE_DIRS "." REQUIRES duktape esp_timer)
target_add_binary_data(${COMPONENT_LIB} "../../../../tools/sdk/engine/celeros.grid.js" TEXT)
