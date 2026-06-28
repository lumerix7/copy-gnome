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

Without --yes, the script shows a preview and asks before installing/replacing
the local extension bundle.
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
  echo "no build for GNOME $VER at $SRC (available builds: copy-gnome-*)" >&2
  exit 1
fi

DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
PACK_DIR="$(mktemp -d)"
BUNDLE="$PACK_DIR/$UUID.shell-extension.zip"

cleanup() {
  rm -rf "$PACK_DIR"
}
trap cleanup EXIT

cat <<EOF
copy-gnome install preview

GNOME Shell version: $VER
Source:              $SRC
Destination:         $DEST
Bundle:              $BUNDLE

Steps:
  1. gnome-extensions pack "$SRC" \\
       --extra-source=core \\
       --extra-source=ui \\
       --extra-source=vendor \\
       --schema=schemas/org.gnome.shell.extensions.copy-gnome.gschema.xml \\
       --force \\
       --out-dir="$PACK_DIR"
  2. gnome-extensions install --force --print-uuid "$BUNDLE"
  3. gnome-extensions enable "$UUID"   # after logout/login on Wayland

Note: this script performs steps 1 and 2. Do not reload GNOME Shell in place on Wayland;
      log out and back in before step 3 if the current Shell cannot see the UUID.

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

echo "packing $SRC"
gnome-extensions pack "$SRC" \
  --extra-source=core \
  --extra-source=ui \
  --extra-source=vendor \
  --schema=schemas/org.gnome.shell.extensions.copy-gnome.gschema.xml \
  --force \
  --out-dir="$PACK_DIR"

BUNDLE="$PACK_DIR/$UUID.shell-extension.zip"
if [[ ! -f "$BUNDLE" ]]; then
  echo "expected bundle not found: $BUNDLE" >&2
  exit 1
fi

echo "installing bundle with gnome-extensions install --force"
installed_uuid="$(gnome-extensions install --force --print-uuid "$BUNDLE")"
if [[ "$installed_uuid" != "$UUID" ]]; then
  echo "installed unexpected extension UUID: $installed_uuid (expected $UUID)" >&2
  exit 1
fi

echo "done."
echo "Installed to:  $DEST"
echo "Wayland next:  LOG OUT and back in, then run:"
echo "               gnome-extensions enable $UUID"
echo "Note: current GNOME Shell may not list a newly installed local extension until relogin."
