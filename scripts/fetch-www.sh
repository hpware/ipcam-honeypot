#!/bin/bash
# Rebuilds assets/www from the OFFICIAL D-Link DCS-2130 1.20.00 firmware:
# downloads the encrypted image, decrypts it with hardwarefetish's
# decode_fw.c (vernam OTP scheme, public since 2012), carves the rootfs
# jffs2 (mtd6) and unpacks it with jefferson.
# Requirements: curl, unzip, gcc, python3, uv (provides jefferson).
set -euo pipefail
cd "$(dirname "$0")/.."
FW_URL="https://media.dlink.eu/support/products/dcs/dcs-2130/driver_software/dcs-2130_fw_reva1_1-20-00_all_en_20130530.zip"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
curl -fsSL -o "$T/fw.zip" "$FW_URL"
unzip -o -q "$T/fw.zip" -d "$T"
gcc -o "$T/decode_fw" scripts/decode_fw.c
BIN=$(find "$T" -name "*.bin" | head -1)
"$T/decode_fw" "$BIN" "$T/dec.bin"
python3 - "$T/dec.bin" << 'PY'
import sys
data = open(sys.argv[1], 'rb').read()
# section table @0x50 (3x64B headers), data @0x110; mtd6 jffs2 nodes start at 0x1d8910
open('/tmp/dcs2130_www.jffs2', 'wb').write(data[0x1d8910:0x1d8000 + 0x382800])
PY
rm -rf assets/www
uvx jefferson -f -d assets/www /tmp/dcs2130_www.jffs2
echo "assets/www rebuilt: $(find assets/www -type f | wc -l) files"
