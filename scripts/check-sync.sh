#!/usr/bin/env bash
# Assert copy-gnome-46/ and copy-gnome-50/ stay in sync except for known files.
# Repo-level invariant only - the standalone CLI package does not ship or run this.
# See docs/09-multi-version.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
A="$ROOT/copy-gnome-46"
B="$ROOT/copy-gnome-50"
ALLOW_RE='^(metadata\.json|ui/popup\.js)$'

if [[ ! -d "$A" || ! -d "$B" ]]; then
  echo "check-sync: expected trees not present:" >&2
  echo "  $A" >&2
  echo "  $B" >&2
  exit 1
fi

# Union of relative file paths across both trees (node_modules excluded).
mapfile -t files < <(
  {
    cd "$A" && find . -type f -not -path './node_modules/*' | sed 's#^\./##';
    cd "$B" && find . -type f -not -path './node_modules/*' | sed 's#^\./##';
  } | sort -u
)

drift=0
for rel in "${files[@]}"; do
  if [[ "$rel" =~ $ALLOW_RE ]]; then
    continue
  fi
  fa="$A/$rel"
  fb="$B/$rel"
  if [[ ! -f "$fa" || ! -f "$fb" ]]; then
    echo "  $rel (missing in one tree)" >&2
    drift=1
    continue
  fi
  if ! cmp -s "$fa" "$fb"; then
    echo "  $rel (contents differ)" >&2
    drift=1
  fi
done

if (( drift )); then
  echo "multi-version tree drift: only metadata.json, ui/popup.js may differ" >&2
  echo "(see docs/09-multi-version.md)" >&2
  exit 1
fi

echo "multi-version sync ok (copy-gnome-46 == copy-gnome-50)"
