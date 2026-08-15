#!/usr/bin/env bash
# Install copy-gnome for a GNOME Shell version.
# Local install only (not published). Log out / back in afterwards on Wayland.
set -euo pipefail

UUID="copy-gnome@clipboard"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YES=0
SKIP_CHECK=0
SKIP_TESTS=0
VER=""

usage() {
  printf '%s\n' 'Usage: install-extension.sh [options]' '' \
    'Install the copy-gnome Shell extension locally.' '' 'Options:' \
    '  --gnome version  Select GNOME 46 or 50 (default: auto-detect)' \
    '  -y, --yes        Run without confirmation' \
    '  --skip-check     Skip format, version sync and syntax checks' \
    '  --skip-tests     Skip extension tests' \
    '  -h, --help       Show this help'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gnome)
      [[ $# -ge 2 ]] || {
        echo "--gnome requires a version" >&2
        exit 2
      }
      VER="$2"
      shift 2
      ;;
    -y | --yes)
      YES=1
      shift
      ;;
    --skip-check)
      SKIP_CHECK=1
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    -h | --help)
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

if [[ -z "$VER" ]]; then
  VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
  [[ -z "$VER" ]] && {
    echo "could not detect GNOME Shell version" >&2
    exit 1
  }
fi

if [[ ! "$VER" =~ ^[0-9]+$ ]]; then
  echo "invalid GNOME Shell version: $VER" >&2
  exit 2
fi

command -v gnome-extensions >/dev/null 2>&1 || {
  echo "gnome-extensions command not found" >&2
  exit 1
}

INSTALL_ARGS=(install --force)
install_help="$(gnome-extensions install --help 2>&1 || true)"
if grep -q -- "--print-uuid" <<<"$install_help"; then
  INSTALL_ARGS+=(--print-uuid)
fi
SRC="$REPO_ROOT/copy-gnome-$VER"
if [[ ! -d "$SRC" ]]; then
  echo "no build for GNOME $VER at $SRC (available builds: copy-gnome-*)" >&2
  exit 1
fi

DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
PACK_DIR="$(mktemp -d)"
BUNDLE="$PACK_DIR/$UUID.shell-extension.zip"
PACK_ARGS=(
  pack "$SRC"
  --extra-source=core
  --extra-source=ui
  --extra-source=vendor
  --schema=schemas/org.gnome.shell.extensions.copy-gnome.gschema.xml
  --force
  --out-dir="$PACK_DIR"
)

printf -v check_script '%q' "$REPO_ROOT/scripts/check.sh"
printf -v pack_command ' %q' "${PACK_ARGS[@]}"
printf -v install_command ' %q' "${INSTALL_ARGS[@]}" "$BUNDLE"
steps=(
  "$check_script extension"
  "$check_script extension-tests"
  "gnome-extensions$pack_command"
  "gnome-extensions$install_command"
)
if ((SKIP_CHECK)); then steps[0]+=' (skipped)'; fi
if ((SKIP_TESTS)); then steps[1]+=' (skipped)'; fi

step() {
  printf '\n[%02d/%02d] %s\n' "$1" "${#steps[@]}" "${steps[$1 - 1]}"
}

cleanup() {
  rm -rf "$PACK_DIR"
}
trap cleanup EXIT

for index in "${!steps[@]}"; do
  printf '[%02d] %s\n' "$((index + 1))" "${steps[index]}"
done

if [[ "$YES" != 1 ]]; then
  read -r -s -n 1 -p 'Continue? [y/N] ' answer || answer=
  if [[ -t 0 ]]; then
    printf '\n' >&2
  fi
  case "$answer" in
    y | Y) ;;
    *)
      echo "Cancelled."
      exit 1
      ;;
  esac
fi

step 1
if ((!SKIP_CHECK)); then
  "$REPO_ROOT/scripts/check.sh" extension
fi

step 2
if ((!SKIP_TESTS)); then
  "$REPO_ROOT/scripts/check.sh" extension-tests
fi

step 3
gnome-extensions "${PACK_ARGS[@]}"
if [[ ! -f "$BUNDLE" ]]; then
  echo "expected bundle not found: $BUNDLE" >&2
  exit 1
fi

step 4
install_output="$(gnome-extensions "${INSTALL_ARGS[@]}" "$BUNDLE")"
installed_uuid="$(printf '%s\n' "$install_output" | tail -n 1)"
if [[ -n "$installed_uuid" && "$installed_uuid" != "$UUID" ]]; then
  echo "installed unexpected extension UUID: $installed_uuid (expected $UUID)" >&2
  exit 1
fi

echo "done."
echo "Installed to:  $DEST"
echo "Wayland next:  LOG OUT and back in, then run:"
echo "               gnome-extensions enable $UUID"
echo "Note: current GNOME Shell may not list a newly installed local extension until relogin."
