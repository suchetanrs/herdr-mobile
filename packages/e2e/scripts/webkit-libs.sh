#!/usr/bin/env bash
# Playwright's WebKit needs libavif16 (and libgav1/libyuv), which this host lacks and `playwright install-deps`
# would need sudo for. Fetch the Ubuntu packages with `apt-get download` (no sudo) and unpack them into
# <repo>/.test-tmp/webkit-libs; playwright.config.ts preloads them into WebKit only. Idempotent.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
DIR="$REPO/.test-tmp/webkit-libs"
LIB="$DIR/root/usr/lib/x86_64-linux-gnu"
if ldconfig -p 2>/dev/null | grep -q 'libavif.so.16 '; then echo "system has libavif16"; exit 0; fi
if [[ -f "$LIB/libavif.so.16" ]]; then echo "already in $LIB"; exit 0; fi
mkdir -p "$DIR/debs" "$DIR/root"
cd "$DIR/debs"
apt-get download libavif16 libgav1-1 libyuv0
for d in *.deb; do dpkg-deb -x "$d" "$DIR/root"; done
echo "unpacked into $LIB"
