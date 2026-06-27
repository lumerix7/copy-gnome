#!/usr/bin/env bash
# Install copy-gnome for the running GNOME Shell version.
# Local install only (not published). Log out / back in afterwards on Wayland.
set -euo pipefail

UUID="copy-gnome@clipboard"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YES=0

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Install copy-gnome for the running GNOME Shell version.

Options:
  -y, --yes     Execute after showing the preview, without prompting
  -h, --help    Show this help

Without --yes, the script shows a preview and asks before removing/replacing
the local extension install directory.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)
      YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
[[ -z "$VER" ]] && { echo "could not detect GNOME Shell version" >&2; exit 1; }

SRC="$REPO_ROOT/copy-gnome-$VER"
if [[ ! -d "$SRC" ]]; then
  echo "no build for GNOME $VER at $SRC (currently only 46 is supported)" >&2
  exit 1
fi

DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

cat <<EOF
copy-gnome install preview

GNOME Shell version: $VER
Source:              $SRC
Destination:         $DEST

Actions:
  1. Remove the destination directory if it exists.
  2. Copy the GNOME $VER extension build into the destination.
  3. Compile GSettings schemas if the build contains schemas/.

EOF

if [[ "$YES" != 1 ]]; then
  read -r -n 1 -p "Proceed with install? [y/N] " answer || {
    echo
    echo "aborted."
    exit 1
  }
  echo
  case "$answer" in
    y|Y)
      ;;
    *)
      echo "aborted."
      exit 1
      ;;
  esac
fi

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
