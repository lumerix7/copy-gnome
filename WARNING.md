# WARNING

copy-gnome is GNOME Shell extension code. Treat the current build as scoped to Ubuntu
24.04 / GNOME Shell 46 / Wayland until it has been re-tested elsewhere.

## Why this matters

The runtime runs inside `gnome-shell`, the compositor/session process. Fail closed:
clipboard features may warn, skip an entry, or stop working, but they must not leave modal
grabs, timers, signals, virtual key modifiers, or native/GI objects in a state that can
crash or hang the Shell.

## Current scope

The tested default runtime currently includes:

- Text clipboard capture.
- `general.captureFiles: true` stores copied-file URI/path references only.
- `general.captureImages: true` reads screenshot/image clipboard bytes. The current path
  has size caps, read timeouts, JS-owned byte copies, and session-local failure disable.
- No near-caret anchoring. GNOME/Wayland caret reporting was unreliable across apps and
  repeated popup opens.
- No delayed focus-loss watcher. The popup closes on outside click, `Esc`, or item
  activation instead.
- `disable()` must stay lightweight and best-effort; do not do large synchronous store,
  thumbnail, blob, or compaction work while Shell is tearing down the extension.

Image capture has been stable in current local testing, but it still touches clipboard
native/GI paths. Keep the recovery commands handy when changing that code.

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

Consider turning image capture off after the upgrade until re-tested.

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
