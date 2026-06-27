# 05 - Configuration & paths

## Formats: YAML first, JSON accepted (answers brief #1)

- Primary config: **`config.yaml`**. If absent, **`config.json`** is used.
- GJS has native `JSON` but **no YAML**; there is no GI yaml typelib (confirmed absent
  locally). So YAML is parsed by a **vendored minimal pure-JS loader**
  (`src/vendor/yaml.js`) supporting the subset we need (maps, lists, scalars, comments,
  `#` lines). We do **not** pull in heavy npm deps - a small vendored parser keeps the
  extension self-contained.
- A JSON Schema (documented here) validates the merged config; unknown keys warn, bad
  values fall back to defaults (never crash the Shell).
- Config file is **watched** (`Gio.FileMonitor`); edits hot-reload (debounced). Some
  changes apply live (caps, excludes); keybindings require re-register (handled).


### Why keybindings are the exception (live in GSettings)

The Shell's `Main.wm.addKeybinding()` reads accelerators from a **GSettings** key of
type `as`. So shortcuts must be defined in a compiled GSettings schema, not (only) in
YAML. Design: keybindings are authoritative in GSettings; the YAML may *mirror* them for
documentation, but the prefs GUI writes GSettings. See [08](08-keybindings.md).

GSettings also stores the handful of values the Shell/prefs need before YAML is loaded
(e.g. `storage.backend`, `enabled`) - kept minimal. Everything else lives in YAML.

## Paths: `COPY_GNOME_HOME` (answers brief #4 path part)

Resolve in `core/paths.js`:

```
COPY_GNOME_HOME (env)  ─┐  if set & writable → use it
                        ├─▶ else default: /opt/copy-gnome/$USER   (deliberately off $HOME)
                        │   else (unwritable) → XDG fallback: $XDG_DATA_HOME/copy-gnome
                        ┘

Default base: /opt/copy-gnome/$USER
Subdirs:
  $BASE/config/   → config.yaml (+ config.json)
  $BASE/data/     → store: clips-YYYYMMDD.jsonl (+ tmp/, see 04)

Fallback layout:
  $XDG_DATA_HOME/copy-gnome/  → store directly: clips-YYYYMMDD.jsonl (+ tmp/)
  $XDG_DATA_HOME/copy-gnome/config/ → config.yaml (+ config.json)
```

**Why not `$HOME`/XDG by default** (per user): `$HOME` accumulates too much state, and
when fixing GNOME login problems the home dir often gets reset/cleaned - which would
wipe clipboard history living under `~/.local/share`. Putting data under
`/opt/copy-gnome/$USER` keeps it independent of `$HOME` churn. The `$USER` subdir keeps it
per-user and isolated.

Setup & permissions: `/opt` is root-owned, so `/opt/copy-gnome` needs a one-time
privileged creation (sticky `1777`, or owned by the user) - handled by
`scripts/setup-home.sh` (see [10](10-packaging.md)). The extension then creates
`/opt/copy-gnome/$USER` mode `0700` on first enable.

If `COPY_GNOME_HOME` is unset/empty, `$USER` is resolved via `GLib.get_user_name()`. If
`/opt/copy-gnome/$USER` is not writable and no override is set, log a clear error and fall
back to `$XDG_DATA_HOME/copy-gnome` so the desktop never breaks (data location is logged
on startup so it's never ambiguous).


## Config schema (defaults shown)

```yaml
# config.yaml
general:
  enabled: true
  watchPrimarySelection: false      # PRIMARY (middle-click) capture
  captureFiles: true                # copied files are stored as URI/path references only
  captureImages: true               # screenshot/image capture; risky on GNOME Shell 46
  clipboardPersistence: true        # re-own selection after source app exits

history:
  maxItems: 30                      # visible history count, max 100
  maxTotalBytes: 268435456          # 256 MiB
  maxItemBytes: 16777216            # 16 MiB; larger items skipped
  maxAgeDays: 0                     # 0 = no age eviction
  dedup: true

storage:
  backend: jsonl                    # jsonl | gda
  inlineMaxBytes: 65536             # target: max persisted inline text bytes
  inlineBinaryMaxBytes: 16384       # 16 KiB; larger non-file image/binary payloads are skipped
  flushIntervalSec: 60              # guaranteed flush of buffered ops to disk
  debounceMs: 500                   # coalesce write bursts
  clipLineMaxBytes: 8388608         # target: refuse oversized JSONL snapshot lines
  maxLoadedLines: 100               # target: startup tail-load cap

privacy:
  pauseHotkeyToggles: true
  secretMimes: ["x-kde-passwordManagerHint"]
  excludeApps: []                   # wm_class / app-id substrings
  excludeRegex: []                  # patterns; matched content is not stored

ui:
  popupWidth: 640                   # px; auto-shrinks on small monitors
  popupMaxHeight: 800               # px; auto-shrinks on small monitors
  popupOffsetX: 0                   # final px adjustment from centered position
  popupOffsetY: 0
  popupEdgeMargin: 8                # min distance from monitor edge
  popupOpacity: 0.82                # whole panel opacity, 0.1..1
  popupMaxRows: 20
  numberPickTimeoutMs: 800          # wait for multi-digit row numbers, e.g. 1 vs 11
  showThumbnails: false             # reserved; current popup uses text-only image previews
  autoPaste: true                   # ALSO inject the paste keystroke after restore.
                                    # NOTE: restore always writes the system clipboard
                                    # regardless; autoPaste only adds the paste keystroke.
  autoPasteDelayMs: 220             # delay before injecting paste after popup closes
  pasteRestoresFocus: true
  terminalApps: [...]               # wm_class substrings that paste with Ctrl+Shift+V
  pasteOverrides: []                # [{match: <wm_class>, combo: ctrl-v|ctrl-shift-v|
                                    #   shift-insert|none}] checked before terminalApps

keybindings:                        # mirror only; authoritative copy is GSettings
  togglePopup: "<Super>v"
  togglePause: "<Super><Shift>v"

logging:
  level: info                       # error|warn|info|debug
```


## Precedence

`built-in defaults` ◀ `config.yaml`/`config.json` ◀ `GSettings` (for keybindings &
bootstrap keys) ◀ env (`COPY_GNOME_HOME`, `COPY_GNOME_LOG`).
