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
- Config is loaded at `enable()`. Opening the popup re-reads the whole config file, so most
  edits (caps, privacy, capture toggles, `ui.*`) take effect on the next popup open with no
  restart. Keybindings are registered once at `enable()`, so changing them needs a
  disable/enable cycle. True file-watch (`Gio.FileMonitor`) hot-reload is **not** implemented
  (planned, see [11](11-open-questions.md) M4).


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
  captureFiles: true                # copied files are stored as URI/path references only
  captureImages: true               # screenshot/image capture; risky inside GNOME Shell
  denyAllMemorySources: true       # skip Shell/Mutter memory sources
  allowMemoryMimes: ["image/*"]     # exact MIME or type/* wildcard allowed when denied

history:
  maxItems: 30                      # visible history count, max 100
  maxItemBytes: 4194304             # 4 MiB default; max 16 MiB
  maxAgeDays: 0                     # 0 = no age eviction

storage:
  backend: jsonl                    # jsonl | gda
  textMaxBytes: 65536               # 64 KiB; larger text payloads are skipped
  binaryMaxBytes: 16384             # 16 KiB; larger non-file image/binary payloads are skipped
  flushIntervalSec: 60              # guaranteed flush of buffered ops to disk
  debounceMs: 500                   # coalesce write bursts

privacy:
  # Optional skip list. Leave empty if password/token copies should remain in history.
  secretMimes: []
  # secretMimes: ["x-kde-passwordManagerHint"]

ui:
  popupWidth: 640                   # px; auto-shrinks on small monitors
  popupMaxHeight: 800               # px; auto-shrinks on small monitors
  popupOffsetX: 0                   # final px adjustment from centered position
  popupOffsetY: 0
  popupEdgeMargin: 8                # min distance from monitor edge
  popupOpacity: 0.82                # whole panel opacity, 0.1..1
  numberPickTimeoutMs: 500          # wait for multi-digit row numbers, e.g. 1 vs 11
  showThumbnails: false             # reserved; current popup uses text-only image previews
  autoPaste: true                   # ALSO inject the paste keystroke after restore.
                                    # NOTE: restore always writes the system clipboard
                                    # regardless; autoPaste only adds the paste keystroke.
  autoPasteDelayMs: 220             # delay before injecting paste after popup closes
  pasteRestoresFocus: true
  fileApps: ["org.gnome.Nautilus"]  # wm_class substrings that receive file records as
                                    # text/uri-list; all others receive path text
  terminalApps: [...]               # wm_class substrings that paste with Ctrl+Shift+V
  pasteOverrides: []                # [{match: <wm_class>, combo: ctrl-v|ctrl-shift-v|
                                    #   shift-insert|none}] checked before terminalApps

keybindings:                        # mirror only; authoritative copy is GSettings
  togglePopup: "<Super>v"

logging:
  level: info                       # error|warn|info|debug
```


## Precedence

`built-in defaults` ◀ `config.yaml`/`config.json` ◀ `GSettings` (for keybindings &
bootstrap keys) ◀ env (`COPY_GNOME_HOME`, `COPY_GNOME_LOG`).
