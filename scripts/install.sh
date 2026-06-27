#!/usr/bin/env bash
# Install copy-gnome for the running GNOME Shell version.
# Local install only (not published). Log out / back in afterwards on Wayland.
set -euo pipefail

UUID="copy-gnome@clipboard"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
[[ -z "$VER" ]] && { echo "could not detect GNOME Shell version" >&2; exit 1; }

SRC="$REPO_ROOT/copy-gnome-$VER"
if [[ ! -d "$SRC" ]]; then
  echo "no build for GNOME $VER at $SRC (currently only 46 is supported)" >&2
  exit 1
fi

DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "installing $SRC -> $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"

if [[ -d "$DEST/schemas" ]]; then
  echo "compiling GSettings schema"
  glib-compile-schemas "$DEST/schemas/"
fi

echo "done."
echo "Enable with:   gnome-extensions enable $UUID"
echo "On Wayland you must LOG OUT and back in for the shell to load it."
