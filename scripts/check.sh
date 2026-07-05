#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

./scripts/check-sync.sh
gjs -m tests/history-dedup.test.js
node --check copy-gnome-50/extension.js
node --check copy-gnome-46/extension.js
node --check copy-gnome-50/core/history.js
node --check copy-gnome-46/core/history.js
node --check copy-gnome-50/core/store.js
node --check copy-gnome-46/core/store.js
node --check copy-gnome-50/ui/popup.js
node --check copy-gnome-46/ui/popup.js
npm --prefix cli run check
npm --prefix cli test
git diff --check

echo "repository checks passed"
