#!/usr/bin/env bash
# One-time privileged setup of the data home base (/opt/copy-gnome).
# The extension creates /opt/copy-gnome/$USER (0700) itself on first run.
# Override the whole location any time with COPY_GNOME_HOME=/some/writable/path.
set -euo pipefail

BASE="${1:-/opt/copy-gnome}"

echo "creating $BASE (sticky 1777, like /tmp: each user owns their own subdir)"
sudo install -d -m 1777 "$BASE"
echo "done. Data will live in $BASE/$USER"
