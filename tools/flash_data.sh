#!/usr/bin/env bash
# Gera a imagem LittleFS de data/ e grava na particao "littlefs".
# Uso: tools/flash_data.sh [smartdisplay|cyd|spotpear-dog|waveshare-watch|devkit|esp32-cam] [PORTA]
# (PORTA default: /dev/ttyACM0 no spotpear-dog/waveshare-watch, /dev/ttyUSB0 nas outras)
# Requer ambiente ESP-IDF exportado (parttool via python do IDF).
set -euo pipefail

BOARD="${1:-smartdisplay}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Porta default por placa: o cao e o watch so tem o USB-Serial/JTAG nativo
# do S3 (/dev/ttyACM0); as outras usam conversor USB-serial (/dev/ttyUSB0).
# Com o default unico em ttyUSB0, "flash_data.sh spotpear-dog" gravava no
# OUTRO aparelho conectado (ex.: a SmartDisplay) sem erro nenhum.
case "$BOARD" in
  spotpear-dog|waveshare-watch) DEFAULT_PORT="/dev/ttyACM0" ;;
  *)            DEFAULT_PORT="/dev/ttyUSB0" ;;
esac
PORT="${2:-$DEFAULT_PORT}"
if [ ! -e "$PORT" ]; then
    echo "porta $PORT nao existe (passe a porta: $0 $BOARD /dev/ttyXXX)"; exit 1
fi
echo "placa: $BOARD  porta: $PORT"

case "$BOARD" in
  smartdisplay|spotpear-dog) PART_CSV="partitions_16MB.csv" ;;
  cyd|devkit)   PART_CSV="partitions_4MB.csv" ;;
  esp32-cam)    PART_CSV="partitions_4MB_cam.csv" ;;
  waveshare-watch) PART_CSV="partitions_32MB.csv" ;;
  *) echo "board invalida: $BOARD (smartdisplay|cyd|spotpear-dog|waveshare-watch|devkit|esp32-cam)"; exit 1 ;;
esac

# Tamanho vem do proprio CSV (fonte unica, sem duplicar valor aqui)
SIZE=$(awk -F',' '$1 ~ /^littlefs/ {gsub(/[[:space:]]/, "", $5); print $5}' "$ROOT/$PART_CSV")
if [ -z "$SIZE" ]; then echo "littlefs nao encontrada em $PART_CSV"; exit 1; fi

# Overlay opcional da placa: boards/<placa>/data/ soma por cima de data/
# (apps exclusivos de uma placa — ex.: Dog Face do cao robotico).
STAGE="$ROOT/build/littlefs-stage-$$"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -a "$ROOT/data/." "$STAGE/"
if [ -d "$ROOT/boards/$BOARD/data" ]; then
    cp -a "$ROOT/boards/$BOARD/data/." "$STAGE/"
    echo "overlay: boards/$BOARD/data somado"
fi
# Pastas .dev (capturas/artefatos de desenvolvimento, gitignored) nao vao
# para a imagem de fabrica: no smartdisplay sao 18 KB reais (~32-64 KB em
# blocos de 4 KB no littlefs).
find "$STAGE" -type d -name .dev -prune -exec rm -rf {} + 2>/dev/null || true
# Exclusao opcional da placa: boards/<placa>/data-exclude.txt (um caminho
# relativo a data/ por linha; # comenta) sai do stage — ex.: o relogio nao
# leva Terminal/HTTP Demo.
EXCL="$ROOT/boards/$BOARD/data-exclude.txt"
if [ -f "$EXCL" ]; then
    while IFS= read -r rel || [ -n "$rel" ]; do
        case "$rel" in ''|'#'*) continue ;; esac
        case "$rel" in *..*|/*) echo "data-exclude: caminho invalido: $rel"; exit 1 ;; esac
        if [ ! -e "$STAGE/$rel" ]; then echo "data-exclude: nao existe: $rel"; exit 1; fi
        rm -rf "${STAGE:?}/$rel"
        echo "excluido: $rel"
    done < "$EXCL"
fi

IMG="$ROOT/build/littlefs-$(date +%s).img"
"$ROOT/tools/bin/mklittlefs.bin" -c "$STAGE" -s "$SIZE" "$IMG"
rm -rf "$STAGE"
python "$IDF_PATH/components/partition_table/parttool.py" \
    --port "$PORT" \
    write_partition --partition-name=littlefs --input "$IMG"
echo "OK: data/ gravado na particao littlefs ($BOARD, $SIZE bytes)"
rm -f "$IMG"
