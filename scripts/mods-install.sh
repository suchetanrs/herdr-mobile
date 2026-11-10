#!/usr/bin/env bash
# Copies herdr-mods/ (mods and layouts) into ~/.config/herdr-app. Any mod folder or layout file it would replace is
# first copied to ~/.config/herdr-app/backups/herdr-mods-<timestamp>/. Nothing is deleted.
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/herdr-mods"
dst="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
backup="$dst/backups/herdr-mods-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$dst/mods" "$dst/layouts"
for m in "$src"/mods/*/; do
  name="$(basename "$m")"
  if [ -e "$dst/mods/$name" ]; then mkdir -p "$backup/mods" && cp -a "$dst/mods/$name" "$backup/mods/"; fi
  mkdir -p "$dst/mods/$name"
  cp -a "$m". "$dst/mods/$name/"
done
for l in "$src"/layouts/*.json; do
  name="$(basename "$l")"
  if [ -e "$dst/layouts/$name" ]; then mkdir -p "$backup/layouts" && cp -a "$dst/layouts/$name" "$backup/layouts/"; fi
  cp -p "$l" "$dst/layouts/$name"
done
[ -d "$backup" ] && echo "backed up the replaced files to $backup"
echo "installed into $dst"
