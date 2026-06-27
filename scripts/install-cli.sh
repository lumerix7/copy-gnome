#!/usr/bin/env bash
# Install the copy-gnome Node CLI globally.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"
PACKAGE_NAME="@clipboard/copy-gnome"
BIN_NAME="copy-gnome"
YES=0

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Install the copy-gnome CLI globally.

Options:
  -y, --yes     Execute after showing the preview, without prompting
  -h, --help    Show this help

The CLI is a Node package at ./cli. It installs the global '$BIN_NAME' command.
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

if [[ ! -d "$CLI_DIR" ]]; then
  echo "CLI directory not found: $CLI_DIR" >&2
  exit 1
fi

cat <<EOF
copy-gnome CLI install preview

Package:     $PACKAGE_NAME
Command:     $BIN_NAME
Source:      $CLI_DIR

Actions:
  1. Run npm install in ./cli.
  2. Run npm run check.
  3. Remove any existing global $PACKAGE_NAME install.
  4. Pack ./cli and install the tarball globally.
  5. Install bash completion to \${XDG_DATA_HOME:-\$HOME/.local/share}/bash-completion/completions.
  6. Smoke-test '$BIN_NAME --version' and '$BIN_NAME paths'.

EOF

if [[ "$YES" != 1 ]]; then
  read -r -n 1 -p "Proceed with CLI install? [y/N] " answer || {
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

cd "$CLI_DIR"

echo "installing npm dependencies"
npm install

echo "running CLI checks"
npm run check

echo "removing any existing global $PACKAGE_NAME"
npm uninstall -g "$PACKAGE_NAME" >/dev/null 2>&1 || true

echo "packing $PACKAGE_NAME"
package_tarball="$(npm pack --quiet | tail -n1)"
trap 'rm -f "$CLI_DIR/$package_tarball"' EXIT

echo "installing global $BIN_NAME"
npm install -g "./$package_tarball"

echo "installing bash completion"
completion_dir="${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"
mkdir -p "$completion_dir"
if "$BIN_NAME" --completion bash > "$completion_dir/$BIN_NAME" 2>/dev/null; then
  echo "wrote $completion_dir/$BIN_NAME"
else
  rm -f "$completion_dir/$BIN_NAME"
  echo "note: skipped bash completion; enable later with: $BIN_NAME --completion bash > $completion_dir/$BIN_NAME" >&2
fi

echo "smoke testing installed command"
"$BIN_NAME" --version >/dev/null
"$BIN_NAME" paths >/dev/null

cat <<EOF

CLI install complete.

Try:
  $BIN_NAME status
  $BIN_NAME doctor
  $BIN_NAME logs --since 30m
  $BIN_NAME config validate
  $BIN_NAME disable

Bash completion is installed. Open a new shell, or run:
  source "$completion_dir/$BIN_NAME"
EOF
