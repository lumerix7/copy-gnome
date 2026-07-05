# 11 - Open questions, risks, decisions

## Decided (per user)

- **Durable home paths**: config/state prefer `/opt/home/$USER/.config/copy-gnome` and
  `/opt/home/$USER/.local/state/copy-gnome`, deliberately **off real `$HOME`**. If
  `/opt/home/$USER` is unavailable, both fall back together to real-home XDG config/state
  dirs.
  See [05](05-config.md), [10](10-packaging.md).
- **Config**: YAML first, JSON accepted; keybindings in GSettings.
- **Storage target**: daily append-only `clips-YYYYMMDD.jsonl` full-history snapshot
  lines with bounded inline text, optional capped base64, and file URI references.
- **Content identity**: history dedup uses persisted
  `kind + contentBytes + contentSha256` candidate identity and exact collision verification.
  Both fields are required in storage and are not exposed over IPC. The monitor self-write
  guard still compares the immediately previous clipboard content directly. Record `id` is a
  uuid.
- **UUID**: `copy-gnome@clipboard`.
- **Multi-version**: two committed, full extension trees (`copy-gnome-46/` and
  `copy-gnome-50/`) are maintained in parallel. There is no build step; shared code drift
  is checked by `scripts/check-sync.sh`. See [09](09-multi-version.md).
- **CLI history commands**: shipped over the DBus control service (`core/ipc.js`, behind
  the swappable `IpcTransport`); `list/get/use/copy/paste/search/rm/clear/popup` are in
  the CLI. See [14-ipc](14-ipc/README.md).
- **Prefs GUI**: shipped as an Adw/Gtk4 preferences window for keybindings, history,
  storage, UI, general capture/logging, and about/config path inspection.
- **Auto-paste default**: on by default (`ui.autoPaste: true`) with a configurable delay
  and app-specific paste-key overrides.
- **Context menu**: row item menu is shipped with Paste/Remove, Save as for non-file
  records, and Show in Files for copied-file records.


## Risks / things to verify

| #   | Risk                                                                                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|-----|------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R1  | `/opt/home/$USER` needs one-time setup; users may skip it                                                  | `setup-home.sh` + clear fallback to XDG with a logged warning                                                                                                                                                                                                                                                                                                                                                                                                               |
| R2  | Blocking IO in `gnome-shell` freezes the desktop                                                           | All IO async via Gio; `disable()` only attempts a tiny best-effort flush and skips risky work                                                                                                                                                                                                                                                                                                                                                                               |
| R3  | Vendored YAML parser bugs on exotic YAML                                                                   | Keep config schema simple/flat; validate + fall back to defaults; JSON always available                                                                                                                                                                                                                                                                                                                                                                                     |
| R4  | Write-back re-captured as a new entry (loop)                                                               | Monitor `_lastContent(origin=restore)` guard around our own `set_content`                                                                                                                                                                                                                                                                                                                                                                                                   |
| R5  | Auto-paste unreliable (focus/timing) on Wayland                                                            | Enabled by default for testing; restore focus before injecting; document                                                                                                                                                                                                                                                                                                                                                                                                    |
| R6  | Secrets captured before app sets concealed hint                                                            | Honor secret mimes + excludes; optional regex; document at-rest plaintext                                                                                                                                                                                                                                                                                                                                                                                                   |
| R7  | Wayland owner re-announces can replay the same payload as memory or non-memory                             | The monitor compares against the single `_lastContent` slot and drops consecutive identical `type` + `value` payloads. Repeated identical consecutive copies collapse to one visible entry. A successful non-consecutive capture is inserted as the new head; the persisted content-identity index selects candidates and exact verification removes older kind/MIME/payload matches. Older entries are not compared pairwise. Restore echoes use `_lastContent(origin=restore)`, with a small concurrency window if another app changes the clipboard during popup restore. |
| R8  | GNOME 50 API drift breaks build                                                                            | Compat shim layer; verify against 50 release notes when available                                                                                                                                                                                                                                                                                                                                                                                                           |
| R9  | Large image histories bloat disk                                                                           | Strict inline/base64 caps; oversized image/binary payloads are skipped                                                                                                                                                                                                                                                                                                                                                                                                      |
| R10 | Lock-screen enable/disable churn causes leaks                                                              | Strict timer/signal teardown; flush on every `disable()`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R11 | `<Super>v` keybinding conflict                                                                             | Configurable; detect failed registration and warn                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R12 | Wrapper-based capture samples current clipboard state, not the exact queued `Meta.SelectionSource` payload | Accepted for stability after `Meta.SelectionSource.read_async()` crashed `gnome-shell`; empty or failed reads skip. Read-once is implemented: each payload is one wrapper read into JS-owned memory, validated/dropped from that copy, never re-read (plain text is read once per job and shared between the rich fallback and text branches). Remaining gap: owner changes between a job's reads (stale-owner / owner-epoch consistency) - a separate future optimization. |


## Closed user decisions

1. Keep `metadata.json` `uuid` as `copy-gnome@clipboard`.
2. Keep default config/state under `/opt/home/$USER` using XDG-style `.config` and
   `.local/state` subdirs; fallback to real-home XDG paths.
3. Keep auto-paste enabled by default for the current test build.
4. Commit and install from the two versioned extension trees directly.
5. Ship the prefs GUI now; export/import can remain post-MVP.
6. Keep the row context-menu surface narrow: Paste, Remove, Save as, and Show in Files.


## Post-MVP candidates

- Faithful multi-MIME restore for rich text beyond the current primary rich MIME plus
  plain fallback model.
- Export/import workflows from the prefs GUI or CLI.
- True config file monitoring via `Gio.FileMonitor`; the current model reloads config on
  popup open and on prefs save.
- Thumbnail UI for image records. Current image rows stay text-oriented and bounded.
- Revisit a single-source build only if a third GNOME Shell version or much larger
  version-specific surface makes two-tree sync too costly.
- Stale-owner / owner-epoch consistency for wrapper-based capture: detect an owner change
  between a job's reads and skip only that capture (avoid mixing rich/plain/image data from
  two owners). Must stay narrow - no global dequeue skip and no skip on the file branch
  (file-copy / memory-twin semantics depend on the file job running), and it needs separate
  manual testing of file copy, restore echo, and memory stale replay. Keep the invariants:
  payload bytes are read at most once and never via `Meta.SelectionSource.read_async()`.


## Milestone state

- **M1**: done - monitor, capture, in-memory history, local store, panel menu.
- **M2**: done - popup, search, restore/write-back, keybinding, keyboard navigation.
- **M3**: done for bounded image/blob persistence; thumbnails remain post-MVP.
- **M4**: done for privacy skips and popup-time config reload; file-watch hot-reload is
  post-MVP.
- **M5**: done for prefs GUI and GNOME 50 build hardening; export/import remains
  post-MVP.
