# copy-gnome - Design Docs

A clipboard manager implemented as a **GNOME Shell extension** (GJS), inspired by
[CopyQ](https://github.com/hluk/CopyQ) but designed to work natively on **Wayland**.


## Why a GNOME Shell extension (and not a normal app)

On Wayland a normal application **cannot** monitor the clipboard in the background:
only the focused client may read the selection, and when the source client exits the
selection offer is destroyed. A GNOME Shell extension runs **inside the compositor
process** (`gnome-shell`), so it can:

- observe every selection-owner change via Mutter's `MetaSelection` API,
- read clipboard contents at any time (it *is* part of the compositor),
- **take ownership** of the selection so content survives the source app closing
  ("clipboard persistence"),
- synthesize paste input through a Clutter virtual device,
- draw a popup near the focused input/window with a real keyboard grab.

This is the single biggest reason to build this as an extension rather than a
DBus-service + GTK app.


## Reading order

| #  | Doc                                      | Topic                                                              |
|----|------------------------------------------|--------------------------------------------------------------------|
| 01 | [overview](01-overview.md)               | Goals, scope, feature list, non-goals                              |
| 02 | [architecture](02-architecture.md)       | Module layout, data flow, lifecycle                                |
| 03 | [clipboard](03-clipboard/README.md)      | Monitoring, mime handling, write-back, paste, persistence, privacy |
| 04 | [storage](04-storage/README.md)          | Append-only clips JSONL, persistence strategy, SQLite alternative  |
| 05 | [config](05-config.md)                   | YAML/JSON config, GSettings, `COPY_GNOME_HOME` paths               |
| 06 | [history-model](06-history-model.md)     | MRU ordering, eviction                                             |
| 07 | [ui](07-ui.md)                           | Caret/window popup, panel indicator, search, prefs window          |
| 08 | [keybindings](08-keybindings.md)         | Global shortcuts, GSettings constraint                             |
| 09 | [multi-version](09-multi-version.md)     | Single source vs per-version dirs, 46↔50 compat                    |
| 10 | [packaging](10-packaging.md)             | Build, pack, install, schema compile, Wayland reload               |
| 11 | [open-questions](11-open-questions.md)   | Decisions to confirm, risks                                        |
| 12 | [cli](12-cli.md)                         | CLI + DBus interface + doctor diagnostics                          |
| 13 | [rich-text](13-rich-text/README.md)      | Rich text capture, payloads, target app paste policy               |
| 14 | [ipc](14-ipc/README.md)                  | DBus control service, JSON envelope, CLI history commands          |
| 99 | [troubleshooting](99-troubleshooting.md) | Known log noise and diagnosis notes                                |


## Quick answers to the brief

| Question                | Decision                                                                                                                                                                      | Doc                                                     |
|-------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------|
| 1. Config format        | **YAML first**, JSON also accepted; keybindings live in GSettings (Shell requirement). Optional prefs GUI.                                                                    | [05](05-config.md)                                      |
| 2. History MRU          | In-memory ordered list; re-using an entry moves it to front. Every copy is kept as its own entry.                                                                             | [06](06-history-model.md)                               |
| 3. Inline vs path       | Target storage keeps bounded text **inline**; copied disk files, including image files, store only **URI/path references**; only non-file image/binary may use capped base64. | [04](04-storage/README.md)                              |
| 4. SQLite vs JSONL      | **Daily append-only `clips-YYYYMMDD.jsonl` full-history snapshot lines** in pure GJS - zero native deps.                                                                      | [04](04-storage/README.md)                              |
| 5. Keybindings + popup  | Global keybinding opens a centered `St` popup over the focused window's monitor, with modal keyboard grab.                                                                    | [07](07-ui.md), [08](08-keybindings.md)                 |
| 6. Monitor + write-back | `MetaSelection::owner-changed` → capture; selecting an entry sets the clipboard and optionally auto-pastes.                                                                   | [03](03-clipboard/README.md)                            |
| 7. Other                | Privacy/password skipping, caps, export/import, migration - see below.                                                                                                        | [03](03-clipboard/README.md), [06](06-history-model.md) |

> Path note: data home defaults to **`/opt/copy-gnome/$USER`**, deliberately **off
> `$HOME`** (home gets cluttered and is often reset when fixing GNOME login problems, which
> would wipe history under `~/.local/share`). `/opt/copy-gnome` needs a one-time privileged
> setup; `COPY_GNOME_HOME` overrides; XDG is the last-resort fallback. See [05](05-config.md)
> and [10](10-packaging.md).
