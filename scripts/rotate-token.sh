#!/usr/bin/env bash
# Replaces the bridge's sign-in token. The old token stops working at once (the bridge re-reads the file);
# devices that are already signed in stay signed in, unless --all: then every device has to sign in again.
#   scripts/rotate-token.sh          new token, signed-in devices keep working
#   scripts/rotate-token.sh --all    new token and every device signed out
# The new token is written to ~/.config/herdr-mobile/token (0600) and never printed.
set -euo pipefail
dir="${XDG_CONFIG_HOME:-$HOME/.config}/herdr-mobile"
unit="${HERDR_MOBILE_UNIT:-herdr-mobile.service}"
all=0
case "${1:-}" in
  --all) all=1 ;;
  "") ;;
  *) echo "usage: $0 [--all]" >&2; exit 2 ;;
esac

umask 077
mkdir -p "$dir"
chmod 700 "$dir"
active=0
systemctl --user is-active --quiet "$unit" 2>/dev/null && active=1
# --all: stop the bridge first, so it can't write the sessions it holds in memory back.
(( all && active )) && systemctl --user stop "$unit"

tmp="$(mktemp "$dir/.token.XXXXXX")"
# 256 bits, base64url (43 characters), like the bridge makes it.
head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' >"$tmp"
echo >>"$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$dir/token"
(( all )) && rm -f "$dir/sessions.json"

if (( all && active )); then
  systemctl --user start "$unit"
  for _ in $(seq 1 50); do curl -fsS -o /dev/null "http://127.0.0.1:${HERDR_MOBILE_PORT:-8787}/api/health" 2>/dev/null && break; sleep 0.2; done
fi

echo "new token written to $dir/token (the old one no longer signs in)"
if (( all )); then echo "every device was signed out"; else echo "signed-in devices stay signed in (scripts/rotate-token.sh --all signs them out too)"; fi
echo "sign-in link: http://<tailscale-ip>:8787/#token=<contents of $dir/token>"
