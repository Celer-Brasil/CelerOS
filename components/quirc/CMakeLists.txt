# quirc — decodificador de QR-code (Daniel Beer, licenca ISC).
# Vendored do upstream https://github.com/dlbeer/quirc (snapshot do master,
# ultimo release tag v1.2 / 2025-05-20): 4 fontes + headers, C puro, sem
# dependencias. Patches locais (documentados em ../README.md): alocacao do
# buffer de imagem prefere a PSRAM.
idf_component_register(SRCS "lib/decode.c" "lib/identify.c" "lib/quirc.c" "lib/version_db.c"
                       INCLUDE_DIRS "lib")
