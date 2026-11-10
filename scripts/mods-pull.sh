#!/usr/bin/env bash
# Copies the Herdr desktop mods and layout from ~/.config/herdr-app into herdr-mods/ (to capture edits before committing).
# Files Herdr generates into every mod (gpui-kit.d.ts, herdr.d.ts, jsconfig.json, *.error) are left out.
set -euo pipefail
src="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dst="$(cd "$(dirname "$0")/.." && pwd)/herdr-mods"
excl=(--exclude gpui-kit.d.ts --exclude herdr.d.ts --exclude jsconfig.json --exclude '*.error')
for m in "$dst"/mods/*/; do
  name="$(basename "$m")"
  rsync -a "${excl[@]}" "$src/mods/$name/" "$m"
done
for l in "$dst"/layouts/*.json; do
  cp -p "$src/layouts/$(basename "$l")" "$l"
done
echo "pulled from $src into $dst"
