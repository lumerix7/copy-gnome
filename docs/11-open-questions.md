# 11 - Open questions, risks, decisions

## Decided (per user)

- **Data home**: default `COPY_GNOME_HOME=/opt/copy-gnome/$USER`, deliberately **off
  `$HOME`** (home gets cluttered and is wiped/reset when fixing login problems). XDG used
  only as a last-resort fallback if `/opt/copy-gnome` is unwritable. See [05](05-config.md),
  [10](10-packaging.md).
- **Config**: YAML first, JSON accepted; keybindings in GSettings.
- **Storage target**: daily append-only `clips-YYYYMMDD.jsonl` full-history snapshot
  lines with bounded inline text, optional capped base64, and file URI references.
- **Content identity**: none - no content hash is computed or stored; the self-write
  guard and file-twin promotion compare clipboard content directly. Record `id` is a uuid.
- **UUID**: `copy-gnome@clipboard`.
- **Multi-version**: one `src/`, built into `copy-gnome-46/` and `copy-gnome-50/`.


## Risks / things to verify

| #   | Risk                                                                 | Mitigation                                                                                    |
|-----|----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| R1  | `/opt/copy-gnome` needs privileged one-time setup; users may skip it | `setup-home.sh` + clear fallback to XDG with a logged warning                                 |
| R2  | Blocking IO in `gnome-shell` freezes the desktop                     | All IO async via Gio; `disable()` only attempts a tiny best-effort flush and skips risky work |
| R3  | Vendored YAML parser bugs on exotic YAML                             | Keep config schema simple/flat; validate + fall back to defaults; JSON always available       |
| R4  | Write-back re-captured as a new entry (loop)                         | Monitor `_lastContent(origin=restore)` guard around our own `set_content`                     |
| R5  | Auto-paste unreliable (focus/timing) on Wayland                      | Enabled by default for testing; restore focus before injecting; document                      |
| R6  | Secrets captured before app sets concealed hint                      | Honor secret mimes + excludes; optional regex; document at-rest plaintext                     |
| R7  | `Meta.SelectionSourceMemory` may be stale replay or a valid memory-only copy | Current behavior drops memory when followed by a non-memory source, or when memory content equals `_lastContent(origin=capture)`. This is intentional replay filtering, not general dedup; repeated identical memory-only copies collapse to one visible entry. Restore echoes use `_lastContent(origin=restore)`, with a small concurrency window if another app changes the clipboard during popup restore. |
| R8  | GNOME 50 API drift breaks build                                      | Compat shim layer; verify against 50 release notes when available                             |
| R9  | Large image histories bloat disk                                     | Strict inline/base64 caps; oversized image/binary payloads are skipped                        |
| R10 | Lock-screen enable/disable churn causes leaks                        | Strict timer/signal teardown; flush on every `disable()`                                      |
| R11 | `<Super>v` keybinding conflict                                       | Configurable; detect failed registration and warn                                             |


## To confirm with user

1. `metadata.json` `uuid` - set to `copy-gnome@clipboard` (no personal handle). OK, or prefer another namespace?
2. `/opt/copy-gnome` permission model - sticky `1777` (multi-user) vs `0755` owned by the
   single user? Proposed: `1777`, per-user `0700` subdir.
3. Auto-paste default - off (proposed) or on?
4. Commit the generated `copy-gnome-46/` `copy-gnome-50/` dirs, or gitignore and build
   on install? Proposed: commit, so install works without a build step.
5. Prefs GUI in MVP or defer (YAML-only first)? Proposed: defer GUI, ship YAML + the
   keybinding-capture page only.
6. CLI: ship it? Proposed **yes**, as a thin client (see [12](12-cli.md)), post-MVP (M5).
7. CLI transport - **DBus default, behind a swappable `IpcTransport`** so socket can drop
   in later with no logic/CLI change. (DBus isn't at risk in GNOME; abstraction, not
   transport choice, is what keeps us flexible.) See [12](12-cli.md).


## Suggested milestones

- **M1**: monitor + capture + in-memory history + local store + panel menu (no popup).
- **M2**: caret/window popup + search + write-back + keybinding.
- **M3**: images/blobs + thumbnails + caps/eviction + clipboard persistence.
- **M4**: privacy/excludes + config hot-reload.
- **M5**: prefs GUI, edit, export/import, DBus service + CLI, GNOME 50 build.
