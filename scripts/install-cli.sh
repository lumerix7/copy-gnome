#!/usr/bin/env bash
# Install the copy-gnome Node CLI globally.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"
PACKAGE_NAME="@clipboard/copy-gnome"
BIN_NAME="copy-gnome"
YES=0
SKIP_CHECK=0
SKIP_TESTS=0
SKIP_COMPLETION=0

usage() {
  printf '%s\n' 'Usage: install-cli.sh [options]' '' \
    'Install the copy-gnome CLI globally.' '' 'Options:' \
    '  -y, --yes          Run without confirmation' \
    '  --skip-check       Skip format and CLI syntax checks' \
    '  --skip-tests       Skip CLI unit tests' \
    '  --skip-completion  Skip Bash completion installation' \
    '  -h, --help         Show this help'
}

for option; do
  case "$option" in
    -y | --yes) YES=1 ;;
    --skip-check) SKIP_CHECK=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-completion) SKIP_COMPLETION=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $option" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$CLI_DIR" ]]; then
  echo "CLI directory not found: $CLI_DIR" >&2
  exit 1
fi

printf -v deps_command 'cd %q && npm install' "$CLI_DIR"
printf -v check_command '%q install-format && npm run check' "$REPO_ROOT/scripts/check.sh"
steps=(
  "$deps_command"
  "$check_command"
  'npm test'
  "npm uninstall -g $PACKAGE_NAME >/dev/null 2>&1 || true"
  "package_tarball=\"\$(npm pack --quiet | tail -n1)\""
  "npm install -g \"./\$package_tarball\""
  "$BIN_NAME --completion bash"
  "$BIN_NAME --version >/dev/null && $BIN_NAME paths >/dev/null"
)
if ((SKIP_CHECK)); then steps[1]+=' (skipped)'; fi
if ((SKIP_TESTS)); then steps[2]+=' (skipped)'; fi
if ((SKIP_COMPLETION)); then
  steps[6]+=' (skipped)'
else
  completion_dir="${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"
  completion_target="$completion_dir/$BIN_NAME"
  printf -v 'steps[6]' 'mkdir -p %q && %q --completion bash >%q 2>/dev/null' \
    "$completion_dir" "$BIN_NAME" "$completion_target"
fi

step() {
  printf '\n[%02d/%02d] %s\n' "$1" "${#steps[@]}" "${steps[$1 - 1]}"
}

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
cd "$CLI_DIR"
npm install

step 2
if ((!SKIP_CHECK)); then
  "$REPO_ROOT/scripts/check.sh" install-format
  npm run check
fi

step 3
if ((!SKIP_TESTS)); then
  npm test
fi

step 4
npm uninstall -g "$PACKAGE_NAME" >/dev/null 2>&1 || true

step 5
package_tarball="$(npm pack --quiet | tail -n1)"
trap 'rm -f "$CLI_DIR/$package_tarball"' EXIT

printf -v 'steps[5]' 'npm install -g %q' "./$package_tarball"
step 6
npm install -g "./$package_tarball"

step 7
completion_file=""
if ((!SKIP_COMPLETION)); then
  mkdir -p "$completion_dir"
  if "$BIN_NAME" --completion bash >"$completion_target" 2>/dev/null; then
    completion_file="$completion_target"
    echo "wrote $completion_file"
  else
    rm -f "$completion_target"
    echo "note: skipped bash completion; enable later with: $BIN_NAME --completion bash > $completion_target" >&2
  fi
fi

step 8
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
EOF
if [[ -n "$completion_file" ]]; then
  printf '\nBash completion is installed. Open a new shell, or run:\n  source %q\n' "$completion_file"
fi
