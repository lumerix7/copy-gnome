#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

check_install_format() {
    local installers=(scripts/install-cli.sh scripts/install-extension.sh)
    local script
    for script in "${installers[@]}"; do
        bash -n "$script"
    done
    if command -v shfmt >/dev/null; then
        shfmt -i 2 -ci -d "${installers[@]}"
    else
        echo "warning: shfmt not found, skipping installer format check" >&2
    fi
}

check_extension() {
    ./scripts/check-sync.sh
    local version
    for version in 46 50; do
        node --check "copy-gnome-$version/extension.js"
        node --check "copy-gnome-$version/core/history.js"
        node --check "copy-gnome-$version/core/store.js"
        node --check "copy-gnome-$version/ui/popup.js"
    done
}

test_extension() {
    node --experimental-loader ./tests/fixtures/popup-shell-loader.mjs --test tests/popup-teardown.test.mjs
    timeout 20s gjs -m tests/history-dedup.test.js
    timeout 10s gjs -m tests/safety.gjs.js
    GIO_USE_VFS=local timeout 10s gjs -m tests/runtime-io.gjs.js
    COPY_GNOME_PRIVATE_TEST_BUS=1 GIO_USE_VFS=local timeout 15s dbus-run-session -- gjs -m tests/dbus-lifecycle.gjs.js

    # The monitor test needs the typelibs shipped with the installed Shell/Mutter.
    # Override the two paths on systems using a different package layout.
    if [[ -z ${COPY_GNOME_SHELL_LIB_DIR:-} || -z ${COPY_GNOME_MUTTER_LIB_DIR:-} ]]; then
        shopt -s nullglob
        shell_typelibs=(/usr/lib/gnome-shell/St-*.typelib)
        if (( ${#shell_typelibs[@]} > 0 )); then
            mutter_version=${shell_typelibs[0]##*/St-}
            mutter_version=${mutter_version%.typelib}
            mutter_typelibs=(/usr/lib/*/mutter-"$mutter_version"/Meta-"$mutter_version".typelib)
            if (( ${#mutter_typelibs[@]} > 0 )); then
                COPY_GNOME_SHELL_LIB_DIR=${shell_typelibs[0]%/*}
                COPY_GNOME_MUTTER_LIB_DIR=${mutter_typelibs[0]%/*}
            fi
        fi
    fi
    if [[ -n ${COPY_GNOME_SHELL_LIB_DIR:-} && -n ${COPY_GNOME_MUTTER_LIB_DIR:-} ]]; then
        test_libs="$COPY_GNOME_SHELL_LIB_DIR:$COPY_GNOME_MUTTER_LIB_DIR"
        monitor_output=$(
            GI_TYPELIB_PATH="$test_libs${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}" \
                LD_LIBRARY_PATH="$test_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
                GIO_USE_VFS=local timeout 10s gjs -m tests/clipboard-monitor.gjs.js 2>&1
        ) || { printf '%s\n' "$monitor_output"; exit 1; }
        printf '%s\n' "$monitor_output"
        if [[ $monitor_output == *"Unhandled promise rejection"* ]]; then
            exit 1
        fi
    else
        echo "clipboard monitor GJS: skipped (Shell/Mutter typelibs unavailable)"
    fi
}

case "${1:-all}" in
    install-format) check_install_format ;;
    extension)
        check_install_format
        check_extension
        ;;
    extension-tests) test_extension ;;
    all)
        check_install_format
        check_extension
        test_extension
        npm --prefix cli run check
        npm --prefix cli test
        git diff --check
        echo "repository checks passed"
        ;;
    *)
        echo "Usage: check.sh [all|install-format|extension|extension-tests]" >&2
        exit 2
        ;;
esac
