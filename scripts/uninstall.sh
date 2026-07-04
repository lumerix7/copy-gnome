#!/usr/bin/env bash
# Remove the installed extension. Pass --purge to also delete copy-gnome config/state.
set -euo pipefail

UUID="copy-gnome@clipboard"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$DEST"
echo "removed $DEST"

if [[ "${1:-}" = "--purge" ]]; then
  USER_HOME="/opt/home/$USER"
  PREFERRED_CONFIG="$USER_HOME/.config/copy-gnome"
  PREFERRED_STATE="$USER_HOME/.local/state/copy-gnome"

  can_use_dir_or_parent() {
    local dir="$1"
    while [[ "$dir" != "/" && -n "$dir" ]]; do
      if [[ -d "$dir" ]]; then
        [[ -w "$dir" ]]
        return
      elif [[ -e "$dir" ]]; then
        return 1
      fi
      dir="$(dirname "$dir")"
    done
    return 1
  }

  if [[ -d "$USER_HOME" && -w "$USER_HOME" ]] &&
      can_use_dir_or_parent "$PREFERRED_CONFIG" &&
      can_use_dir_or_parent "$PREFERRED_STATE"; then
    CONFIG_DIR="$PREFERRED_CONFIG"
    STATE_DIR="$PREFERRED_STATE"
  else
    CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/copy-gnome"
    STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/copy-gnome"
  fi
  echo "purging config: $CONFIG_DIR"
  echo "purging state: $STATE_DIR"
  rm -rf "$CONFIG_DIR" "$STATE_DIR"
fi
echo "done. Log out / back in to fully unload on Wayland."
