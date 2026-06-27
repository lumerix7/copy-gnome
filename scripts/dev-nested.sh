#!/usr/bin/env bash
# Launch a nested GNOME Shell (Wayland) for development without logging out.
# Enable the extension inside the nested shell, then watch logs in another terminal:
#   journalctl --user -f | grep -i copy-gnome
set -euo pipefail

export MUTTER_DEBUG_DUMMY_MODE_SPECS="1280x800"
exec dbus-run-session -- gnome-shell --nested --wayland
