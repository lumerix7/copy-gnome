# WARNING

copy-gnome is experimental GNOME Shell code. Treat the current build as scoped to
Ubuntu 24.04 / GNOME Shell 46 / Wayland until it has been re-tested elsewhere.

## Why this matters

This project runs inside `gnome-shell`, which is the compositor/session process. A normal
application bug can usually crash only that application; a Shell extension bug can break
the desktop session, leave grabs or timers behind, or force a logout/relogin recovery.

Fail closed: clipboard features may warn, skip an entry, or stop working, but they must
not risk taking down `gnome-shell`.

## Current safe scope

The default runtime is not fully conservative while screenshot/file testing is enabled:

- Text clipboard capture.
- `general.captureFiles: true` stores copied-file URI/path references only.
- `general.captureImages: true` reads screenshot/image clipboard bytes and is the
  riskiest capture path on GNOME Shell 46.
- No near-caret anchoring. GNOME/Wayland caret reporting was unreliable across apps and
  repeated popup opens.
- No delayed focus-loss watcher. The popup closes on outside click, `Esc`, or item
  activation instead.
- `disable()` must stay lightweight and best-effort; do not do large synchronous store,
  thumbnail, blob, or compaction work while Shell is tearing down the extension.

## Known instability

On GNOME Shell 46 Wayland, screenshot/image clipboard paths have already crashed
`gnome-shell` once with `signal 11` in the old image capture implementation. The current
test build enables image capture by default for validation, so keep recovery commands
ready and disable it in config if instability returns.

File and image capture are not production-safe yet. Image capture must copy `GLib.Bytes`
or other GI/native boxed data into JS-owned memory immediately inside the clipboard
callback, catch all read/write errors, and be ready to disable the extension from a
terminal.

Current image safeguards are deliberately narrow: only `image/png` clipboard payloads are
read, raw bytes are capped by `storage.inlineBinaryMaxBytes`, reads time out, bytes are
copied into `Uint8Array` inside the callback, and repeated image read failures disable
image capture for the current Shell session. These JS-level guards do not protect against
a native `gnome-shell` signal crash inside Mutter/St/GI before control returns to JS.

There was also a login black-screen/login-transition incident on this machine. The logs
looked more like GDM/Xwayland/login transition trouble than a copy-gnome failure, but the
desktop environment should be treated as unstable until repeated login/logout testing is
clean.

## Recovery commands

If the desktop starts acting wrong, disable the extension first:

```sh
gnome-extensions disable copy-gnome@clipboard
gnome-extensions info copy-gnome@clipboard
```

Useful log filters:

```sh
journalctl --user -b 0 | rg -i 'copy-gnome|gnome-shell|signal 11|JS ERROR|Xwayland'
journalctl -b 0 | rg -i 'gnome-shell|gdm|gnome-session|logind|xwayland|signal 11'
```

After changing extension code, reinstall and relogin:

```sh
./scripts/install.sh
```

Do not rely on `Alt+F2`, `r` to restart Shell on Wayland.

## GNOME 50 / Ubuntu 26.04

Do not assume the GNOME 46 extension is compatible with GNOME 50 or Ubuntu 26.04.
Re-test from scratch before enabling it on the upgraded machine.

Areas likely to drift:

- `MetaSelection` / clipboard ownership behavior.
- `St.Clipboard` async content APIs.
- `Clutter` virtual keyboard event injection.
- `St` / `Clutter` modal grabs and focus handling.
- GNOME extension lifecycle and prefs APIs.
- Keybinding registration and conflict behavior.

Consider turning risky features off after the upgrade until re-tested, especially image
capture and any focus/caret anchoring logic.

## Architecture direction

A pure CopyQ-style standalone Wayland client cannot fully replace the extension, because
normal Wayland apps cannot reliably monitor the global clipboard, own global hotkeys, or
inject paste into other apps without compositor cooperation.

The safer long-term direction is a hybrid design:

- Standalone GTK/GJS app or daemon for history UI, storage, preferences, and CLI.
- Minimal GNOME Shell bridge for clipboard monitoring, global shortcut, and paste
  injection.
- CLI commands for `enable`, `disable`, `restart`, and status that work even when the
  in-Shell service is broken.
