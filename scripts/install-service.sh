#!/usr/bin/env bash
# Installs (or updates) the herdr-mobile bridge as a systemd --user service. Idempotent: safe to re-run
# after pulling or editing deploy/herdr-mobile.service. No sudo.
#   scripts/install-service.sh            build if needed, install, enable, (re)start
#   scripts/install-service.sh --no-build  skip `npm run build`
#   NODE_BIN=/abs/node scripts/install-service.sh   use this Node instead of fnm's newest v22
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_NAME=herdr-mobile.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TEMPLATE="$REPO/deploy/$UNIT_NAME"
BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

# An absolute Node 22 (fnm installs live in ~/.local/share/fnm/node-versions/<v>/installation/bin/node).
find_node() {
  if [[ -n "${NODE_BIN:-}" ]]; then echo "$NODE_BIN"; return; fi
  local fnm_dir="${FNM_DIR:-$HOME/.local/share/fnm}"
  local found
  found="$(ls -d "$fnm_dir"/node-versions/v22.*/installation/bin/node 2>/dev/null | sort -V | tail -n1 || true)"
  if [[ -n "$found" ]]; then echo "$found"; return; fi
  command -v node || true
}
NODE="$(find_node)"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "No Node 22 found (install it with: fnm install 22), or set NODE_BIN=/abs/path/to/node" >&2
  exit 1
fi
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then
  echo "Node at $NODE is v$("$NODE" -v); need >= 22 (set NODE_BIN)" >&2
  exit 1
fi
echo "node: $NODE ($("$NODE" -v))"

if (( BUILD )); then
  echo "building..."
  (cd "$REPO" && PATH="$(dirname "$NODE"):$PATH" npm run build >/dev/null)
fi
[[ -f "$REPO/packages/server/dist/main.js" && -f "$REPO/packages/web/dist/index.html" ]] || {
  echo "No build found: run npm run build" >&2
  exit 1
}

mkdir -p "$UNIT_DIR"
rendered="$(sed -e "s|@NODE@|$NODE|g" -e "s|@REPO@|$REPO|g" "$TEMPLATE")"
target="$UNIT_DIR/$UNIT_NAME"
changed=0
if [[ ! -f "$target" ]] || [[ "$(cat "$target")" != "$rendered" ]]; then
  printf '%s\n' "$rendered" > "$target"
  changed=1
  echo "unit written: $target"
else
  echo "unit unchanged: $target"
fi

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1
if systemctl --user is-active --quiet "$UNIT_NAME"; then
  # Pick up a new build or unit (clients reconnect on their own).
  systemctl --user restart "$UNIT_NAME"
  echo "restarted"
else
  systemctl --user start "$UNIT_NAME"
  echo "started"
fi

# Start at boot without a login session (and survive logout). Works without sudo when polkit allows it.
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]]; then
  if loginctl enable-linger "$USER" 2>/dev/null; then
    echo "linger enabled: the service starts at boot"
  else
    echo "note: could not enable linger without sudo; the service runs while you are logged in."
    echo "      For start-at-boot: sudo loginctl enable-linger $USER"
  fi
fi

port="$(sed -n 's/^Environment=HERDR_MOBILE_PORT=//p' "$target" | tail -n1)"
port="${port:-8787}"
for i in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
echo "health: $(curl -fsS "http://127.0.0.1:$port/api/health" 2>/dev/null || echo 'not answering yet (journalctl --user -u herdr-mobile)')"
echo "status: systemctl --user status herdr-mobile    logs: journalctl --user -u herdr-mobile -f"
ts="$(ip -4 -o addr show tailscale0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
echo "sign in on the phone (Tailscale on): http://${ts:-<tailscale-ip>}:$port/#token=<contents of ~/.config/herdr-mobile/token>"
