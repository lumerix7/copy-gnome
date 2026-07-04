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


## Paths: durable home + XDG config/state (answers brief #4 path part)

Resolve in `core/paths.js`:

```
/opt/home/$USER writable?
  yes → config: /opt/home/$USER/.config/copy-gnome/config.yaml (+ config.json)
        state:  /opt/home/$USER/.local/state/copy-gnome/clips-YYYYMMDD.jsonl (+ tmp/)
  no  → config: $XDG_CONFIG_HOME/copy-gnome/config.yaml (+ config.json)
        state:  $XDG_STATE_HOME/copy-gnome/clips-YYYYMMDD.jsonl (+ tmp/)

XDG defaults:
  $XDG_CONFIG_HOME unset → ~/.config
  $XDG_STATE_HOME unset  → ~/.local/state
```

**Why not real `$HOME`/XDG by default** (per user): `$HOME` accumulates too much state, and
when fixing GNOME login problems the home dir often gets reset/cleaned - which would
wipe clipboard history living under `~/.local/state`. `/opt/home/$USER` is a durable
alternate home on a retained `/opt` partition, while keeping standard per-user XDG
subpaths (`.config` and `.local/state`) inside it.

Setup & permissions: `/opt/home` is expected to be writable on the retained `/opt`
partition. `scripts/setup-home.sh` creates `/opt/home/$USER` mode `0700` as the current
user (see [10](10-packaging.md)). The extension then creates `.config/copy-gnome` and
`.local/state/copy-gnome` mode `0700` as needed.

If `/opt/home/$USER` or either app dir cannot be created, log a clear warning and fall
back as a whole to real-home XDG config/state dirs so config and history do not split
between roots.


## Config schema (defaults shown)

```yaml
# config.yaml
general:
  captureFiles: true                # copied files are stored as URI/path references only
  captureImages: true               # screenshot/image capture; risky inside GNOME Shell

history:
  maxItems: 200                     # visible history count, max 1000
  maxItemBytes: 4194304             # 4 MiB default; max 16 MiB
  maxAgeDays: 3                     # 0 = keep all daily files; N deletes clips-*.jsonl older than N days
  cleanupIntervalSec: 86400         # seconds; periodic expired-file sweep interval, 15..864000

storage:
  backend: jsonl                    # jsonl | gda
  textMaxBytes: 1048576             # 1 MiB default; max 15 MiB, also bounded by maxItemBytes
  binaryMaxBytes: 1048576           # 1 MiB default; max 10 MiB raw, also bounded by maxItemBytes
  flushIntervalSec: 1800            # append latest snapshot once per N seconds (the only writer)

privacy:
  # Optional skip list. Leave empty if password/token copies should remain in history.
  secretMimes: []
  # secretMimes: ["x-kde-passwordManagerHint"]

ui:
  popupWidth: 640                   # px, 240..8000; auto-shrinks to monitor
  popupMaxHeight: 800               # px, 120..8000; auto-shrinks to monitor
  popupOffsetX: 0                   # final px adjustment from centered position
  popupOffsetY: 0
  popupEdgeMargin: 8                # min distance from monitor edge
  popupOpacity: 0.92                # whole panel opacity, 0.1..1
  popupTheme: auto                  # auto|dark|light
  numberPickTimeoutMs: 500          # wait for multi-digit row numbers, e.g. 1 vs 11
  showThumbnails: false             # reserved; current popup uses text-only image previews
  autoPaste: true                   # ALSO inject the paste keystroke after restore.
  autoPasteDelayMs: 220             # delay before injecting paste after popup closes
  pasteRestoresFocus: true
  skipClipboardWriteForRecentTopSec: 3
                                    # 0 disables. If row 1 was updated within this many
                                    # seconds, restore/paste it without rewriting clipboard.
  fileApps: ["org.gnome.nautilus"]  # lower-case wm_class substrings that receive file
                                    # records as text/uri-list; all others receive path text
  richTextApps: [libreoffice, soffice]
                                    # lower-case wm_class substrings that receive rich MIME
                                    # for kind=rich records
  plainTextApps: [terminal]
                                    # wins over richTextApps; restores kind=rich as text/plain
  defaultPasteKeys: [ctrl, v]       # fallback paste injection keys; [] skips injection
  pasteKeybindings:                 # checked in order before defaultPasteKeys
    - keys: [ctrl, shift, v]        # case-insensitive; order/repeats preserved
      apps: [terminal]              # lower-case wm_class substrings

keybindings:                        # mirror only; authoritative copy is GSettings
  togglePopup: "<Super>v"

logging:
  level: info                       # error|warn|info|debug
```


## Precedence

`built-in defaults` ◀ `config.yaml`/`config.json` ◀ `GSettings` (for keybindings &
bootstrap keys) ◀ env (`COPY_GNOME_LOG`).
