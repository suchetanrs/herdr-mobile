#!/usr/bin/env bash
# Stops, disables and removes the herdr-mobile systemd --user service. Idempotent. Keeps the token
# (~/.config/herdr-mobile) and leaves linger as it is.
set -euo pipefail
UNIT_NAME=herdr-mobile.service
target="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"
systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
if [[ -f "$target" ]]; then
  rm -f "$target"
  echo "removed $target"
else
  echo "not installed"
fi
systemctl --user daemon-reload
systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
