#!/usr/bin/env bash
# One-time setup of the durable home base (/opt/home/$USER).
# The extension creates .config/copy-gnome and .local/state/copy-gnome itself.
set -euo pipefail

BASE="${1:-/opt/home}"
USER_HOME="$BASE/$USER"

echo "creating $USER_HOME (private durable home)"
install -d -m 0755 "$BASE"
install -d -m 0700 "$USER_HOME"
echo "done. Config will live in $USER_HOME/.config/copy-gnome"
echo "done. State will live in $USER_HOME/.local/state/copy-gnome"
