#!/usr/bin/env bash
# Remove the installed extension. Pass --purge to also delete the data home.
set -euo pipefail

UUID="copy-gnome@clipboard"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$DEST"
echo "removed $DEST"

if [[ "${1:-}" = "--purge" ]]; then
  BASE="${COPY_GNOME_HOME:-/opt/copy-gnome/$USER}"
  echo "purging data home: $BASE"
  rm -rf "$BASE"
fi
echo "done. Log out / back in to fully unload on Wayland."
