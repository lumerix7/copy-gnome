# 01 - Overview

## Goal

A fast, Wayland-native clipboard manager for GNOME, with a CopyQ-like feature set but
implemented as a Shell extension so it works where standalone clipboard managers can't.

## Target platform

- GNOME Shell **46** and **50** (both are post-GNOME-45, i.e. ESM + `Extension` class era).
- Wayland primary; X11 should keep working (the `MetaSelection`/`St.Clipboard` paths work on both).
- GJS ≥ 1.80 (ships with Shell 46).

## Core features (MVP)

- **Clipboard monitoring** of `CLIPBOARD` selection (PRIMARY optional, off by default).
- **History** with most-recently-used ordering; re-copying moves an item to the top.
- **Dedup** by content hash.
- **Centered popup** opened by a global shortcut: searchable, keyboard-navigable list.
- **Write-back**: choosing an entry restores it to the clipboard; optional auto-paste.
- **Persistence** across login sessions, written asynchronously off the compositor's hot path.
- **Clipboard persistence**: keep content alive after the source app exits.
- **Privacy**: skip password-manager / concealed entries; pause toggle; per-app & regex excludes.
- **Config** in YAML (JSON accepted), with sensible defaults; optional prefs GUI.

## Feature set (post-MVP / planned)

- Optional image thumbnails. Current runtime keeps image entries as text previews because
  decoding thumbnails inside `gnome-shell` is higher risk on Shell 46.
- Item actions: delete, edit-text, "copy as plain text".
- Multiple named tabs/stacks (CopyQ-style), low priority.
- Export / import of history.
- Optional at-rest encryption of the on-disk store.
- Snippets (static saved entries).

## Non-goals

- Cross-desktop support (KDE, wlroots): out of scope - this targets GNOME Shell only.
- Cloud sync.
- Editing rich content (HTML/RTF) beyond storing & restoring it verbatim.
- Reading another app's **text caret** position. GNOME/Wayland caret reporting proved
  unstable across apps and repeated modal grabs, so the popup is centered instead.

## Reference projects (for inspiration / prior art)

- **CopyQ** - feature reference (history, search, scripting, edit).
- **Pano** (GNOME extension) - uses `MetaSelection` + a native libgda SQLite store and
  on-disk image cache. We borrow the selection-monitoring approach but avoid the native
  dependency (see [04-storage](04-storage.md)).
- **Clipboard Indicator** (GNOME extension) - simple GSettings-backed history; shows the
  limits of storing everything in GSettings (we don't).
