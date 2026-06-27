# 12 - CLI & DBus (answers "要 cli 不")

## Current implementation: Node recovery CLI

The current checked-in CLI lives in `cli/` as a normal npm package:

```json
{
  "name": "@clipboard/copy-gnome",
  "bin": {
    "copy-gnome": "./bin/copy-gnome.js"
  }
}
```

Install locally:

```sh
./scripts/install-cli.sh
```

Current commands:

```text
copy-gnome status
copy-gnome doctor [--json] [--since 30m] [--require-active]
copy-gnome logs [--since 30m] [-n 100] [-f] [--json]
copy-gnome enable | disable | restart
copy-gnome extension-status
copy-gnome paths [--json]
copy-gnome repair [--file PATH] [--yes] [--json]
copy-gnome --completion bash
```

Design boundary: this CLI does **not** import GJS, GNOME Shell modules, or extension
runtime code. It uses Node plus stable external commands (`gnome-extensions`,
`gsettings`, `journalctl`) and filesystem checks, so the rescue commands remain useful
when the Shell extension is disabled, absent, or broken. Future in-memory history actions
(`list`, `use`, `popup`) still need an IPC service; those are covered by the DBus/socket
design below.

`scripts/install-cli.sh` installs bash completion to
`${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/copy-gnome` by running
`copy-gnome --completion bash`. Completion covers top-level commands, command options, and
file completion for `repair --file`.

Known GNOME Shell log noise, including Ubuntu Dock keybinding warnings, is documented in
[13-troubleshooting](13-troubleshooting.md).

## IPC choice: DBus vs unix socket (decide-later)

The CLI can't read history directly (it lives inside `gnome-shell`), so it needs an IPC
channel into the extension. Two viable options - this is **not locked in**:

| | **DBus** (proposed default) | **Unix socket** |
|---|---|---|
| Setup | register a bus name in `enable()` | Future runtime socket path TBD; do not create `$BASE/state` in the Shell path |
| Tooling | `gdbus`/`busctl` work for free; introspectable | none free - custom line/JSON protocol |
| Deps | session bus | none; fully self-contained |
| Cost | bus name + boilerplate | manual message framing |

> Note on "输入法没用 DBus 了": modern IMEs moved to the **Wayland `text-input`
> protocol** for *input events* - a different plane from *control IPC*. (IBus/Fcitx5
> still use DBus for their control surfaces.) So that shift doesn't argue against DBus for
> our control channel; both DBus and a unix socket remain fine here.

### Decision: DBus default, behind a swappable `IpcTransport`

DBus is **not** at risk of going away in GNOME - the Shell itself is built on it
(notifications, settings, the extensions API, search providers). The concern worth
honoring isn't "DBus will be deprecated" but "don't hard-commit to one transport." So:

- The extension logic talks to a thin **`IpcTransport`** interface (`start(handlers)`,
  `stop()`, `emit(signal, payload)`); the method surface below is the contract.
- The default implementation is **`DBusTransport`** - `Gio.DBusExportedObject.wrapJSObject(xml, impl)`
  is ~10 lines and you get `gdbus call` / `busctl` for free while developing.
- A **`SocketTransport`** (Gio.SocketService, path TBD) can drop in
  later with zero change to the logic or the CLI surface - an afternoon's work if DBus
  ever becomes inconvenient.

Why DBus first, not socket: the socket's only real edge is "no session-bus dependency,"
which is moot inside a GNOME session, while it *adds* code and failure modes (stale `.sock`
after a crash, `EADDRINUSE`, manual message framing, you must hand-write the client). DBus
is less code and self-documenting. Swappability - not transport choice - is what keeps us
safe if requirements change. CLI is post-MVP, so this blocks nothing now.

## Recommendation: yes - a thin CLI over the control channel

A CLI is genuinely useful for a clipboard manager (CopyQ ships `copyq` for exactly this:
scripting, `xdotool`-style automation, piping). But the history lives **inside
`gnome-shell`**, so a CLI can't read it directly - it must talk to the extension.

**Design: the extension exposes a private DBus service; `copy-gnome` (CLI) is a thin
client that calls it.** This keeps one source of truth (the in-Shell `history.js`) and
adds zero new storage path.

- Bus: **session bus**, well-known name `org.gnome.Shell.Extensions.CopyGnome`,
  object path `/org/gnome/Shell/Extensions/CopyGnome`.
- The extension registers the service in `enable()` (via `Gio.DBusExportedObject`) and
  unexports in `disable()`. When the extension is disabled, the CLI gets a clear
  "service not available - is the extension enabled?" error.
- No new daemon: the service lives and dies with the extension.

## CLI surface (proposed)

```
copy-gnome list [--limit N] [--json]        # recent entries (id, kind, preview)
copy-gnome get <id> [--raw]                 # print one entry's content to stdout
copy-gnome copy [text | -]                  # set clipboard from arg or stdin  → new entry
copy-gnome paste                            # print current clipboard text to stdout
copy-gnome use <id>                         # restore entry to clipboard (move-to-front)
copy-gnome search <query> [--json]
copy-gnome rm <id> | copy-gnome clear [--yes]
copy-gnome status                           # extension state (count, paths, config)
copy-gnome enable | disable | restart       # enable/disable the Shell extension itself
copy-gnome extension-status                 # wrapper around gnome-extensions info
copy-gnome doctor [--json] [--since DURATION]
copy-gnome popup                            # open the history popup (same as the hotkey)
```

- Binary kinds: `get <id> --raw` decodes the clip's inline base64 data when available;
  `list` shows a label.
- `--json` everywhere for scripting; default output is human-readable.
- Exit codes: `0` ok, `1` unhealthy checks, `2` bad args, `3` service unavailable,
  `4` not found.
- `disable` unloads the extension through GNOME Shell, useful when a Shell-side bug needs a
  quick terminal escape hatch.
- `doctor` is the first recovery/debug command to implement because it must still work
  when the extension's own DBus service is unavailable.

## Doctor command

`copy-gnome doctor` is a local diagnostic command, not a repair tool by default. It should
print a short human-readable report and exit non-zero if any high-confidence problem is
found. `--json` emits the same checks as structured data for bug reports and scripts.

Design rule: **offline checks must not call the extension DBus service**. A broken Shell
extension often means the DBus service is absent, so `doctor` must still be useful from a
terminal.

### Example output

```text
copy-gnome doctor

System
  GNOME Shell: 46.2 (supported: yes)
  Session: wayland
  Extension dir: ~/.local/share/gnome-shell/extensions/copy-gnome@clipboard

Extension
  Installed: yes
  Enabled: yes
  State: ACTIVE
  Installed version: 0.1.0

Config
  Data home: /opt/copy-gnome/<USER>
  Config file: not found, using defaults
  captureImages: true
  captureFiles: true

Logs (--since 30m)
  copy-gnome warnings/errors: 0
  gnome-shell JS errors mentioning copy-gnome: 0
  gnome-shell signal 11: 0

Result: ok
```

### Checks

Offline checks, always available:

- Detect `gnome-shell --version`; warn if not GNOME 46 for the current build. GNOME 50
  must be treated as untested until the versioned build is validated.
- Detect session type from `$XDG_SESSION_TYPE`; warn that Wayland requires logout/login
  after JS changes and cannot use `Alt+F2`, `r` restart.
- Verify the extension install directory exists and contains `metadata.json`,
  `extension.js`, `schemas/gschemas.compiled`, `core/`, and `ui/`.
- Run `gnome-extensions info copy-gnome@clipboard` and parse enabled/state/path/version.
- Verify `COPY_GNOME_HOME` if set; otherwise check whether `/opt/copy-gnome` exists and is
  usable, and report the expected fallback to `$XDG_DATA_HOME/copy-gnome` if not.
- Parse `config.yaml` / `config.json` enough to flag dangerous settings:
  `general.captureImages: true`, `general.captureFiles: true`, huge `maxItemBytes`,
  `logging.level: debug` left on, or invalid YAML/JSON.
- Check recent logs with a conservative default window (`--since 30m`):
  `copy-gnome`, `JS ERROR`, `signal 11`, `popup show failed`, `modal release failed`,
  `clipboard read failed`, `Xwayland exited unexpectedly`.
- Check common keybinding hazards with `gsettings`, especially `org.gnome.settings-daemon.plugins.media-keys logout`,
  screenshot shortcuts, and the extension's `toggle-popup` keys.

Online checks, only when the extension service is reachable:

- DBus name registered and introspectable.
- `Status` method returns enabled state, history count, data home, config path,
  active UI settings, and last warning timestamp.
- `List --limit 1` works from the extension's in-memory history without scanning clips files.
- `ShowPopup` can be skipped by default; make it explicit with `doctor --interactive` so
  diagnostics do not unexpectedly grab the keyboard.

### Severity

Each check returns one of:

| Severity | Meaning |
|---|---|
| `ok` | Expected state. |
| `info` | Useful context, not a problem. |
| `warn` | Suspicious or risky, but not known broken. |
| `fail` | Known broken or unsafe enough that the CLI exits `1`. |

Rules of thumb:

- Disabled extension is `warn` unless the user passed `--require-active`, then `fail`.
- Missing install dir is `fail`.
- Unsupported GNOME major is `fail` for install/run commands, `warn` for pure log review.
- `captureImages: true` or `captureFiles: true` is `warn` because non-text capture is
  opt-in and risky on GNOME 46.
- Recent `signal 11` in `gnome-shell` is `fail` if logs mention copy-gnome, otherwise
  `warn` with surrounding context.

### JSON shape

```json
{
  "ok": true,
  "summary": "ok",
  "checks": [
    {
      "id": "extension.state",
      "severity": "ok",
      "message": "Enabled and ACTIVE",
      "details": {"enabled": true, "state": "ACTIVE"}
    }
  ],
  "recovery": [
    "gnome-extensions disable copy-gnome@clipboard",
    "journalctl --user -b 0 | rg -i 'copy-gnome|gnome-shell|signal 11|JS ERROR'"
  ]
}
```

### Subcommands and options

```text
copy-gnome doctor
copy-gnome doctor --json
copy-gnome doctor --since 2h
copy-gnome doctor --require-active
copy-gnome doctor --interactive          # may open popup or perform harmless DBus calls
copy-gnome doctor logs [--since 2h]      # focused log extract for bug reports
copy-gnome doctor env                    # versions, paths, keybindings, config summary
```

Keep `doctor` read-only. Any future repair action must be explicit, e.g.
`copy-gnome repair disable-risky-capture` or `copy-gnome disable`.

## DBus method sketch

```xml
<interface name="org.gnome.Shell.Extensions.CopyGnome">
  <method name="List">
    <arg type="i" name="limit" direction="in"/>
    <arg type="s" name="json"  direction="out"/>   <!-- array of {id,kind,preview,bytes,usedAt} -->
  </method>
  <method name="Get">       <arg type="s" name="id" direction="in"/>
                            <arg type="ay" name="bytes" direction="in"/>   <!-- raw -->
                            <arg type="s"  name="mime"  direction="out"/></method>
  <method name="Copy">      <arg type="ay" name="bytes" direction="in"/>
                            <arg type="s"  name="mime"  direction="in"/></method>
  <method name="Use">       <arg type="s" name="id" direction="in"/></method>
  <method name="Search">    <arg type="s" name="q" direction="in"/>
                            <arg type="s" name="json" direction="out"/></method>
  <method name="Remove">    <arg type="s" name="id" direction="in"/></method>
  <method name="Clear">     </method>
  <method name="Status">    <arg type="s" name="json" direction="out"/></method>
  <method name="ShowPopup"> </method>
  <signal name="HistoryChanged"> <arg type="s" name="topId"/> </signal>
</interface>
```

## Implementation notes

- The CLI itself can be a **small GJS script** (uses `Gio.DBusProxy`, no extra deps) or a
  POSIX `sh` wrapper around `gdbus call`. Prefer the GJS script for clean JSON + binary
  handling; ship it in `scripts/` and symlink to `~/.local/bin/copy-gnome` at install.
- For binary content over DBus, pass `ay` (byte array) decoded from the clip's capped
  inline base64 payload. Oversized non-file binary payloads are not persisted in v1.
- Security: session bus is per-user already; no extra auth needed. Don't expose anything
  that bypasses the privacy rules (`Copy` still goes through the normal capture
  pipeline so excludes apply).
- `Status` must be cheap and safe: no clips-file scans, no compaction, no thumbnails, no
  popup creation. It returns only in-memory counters, config summary, data paths, and
  recent warning/error metadata.
- Extension lifecycle commands (`enable`, `disable`, `restart`, `extension-status`) should
  **not** depend on the extension's DBus service, because that service is unavailable when
  the extension is disabled or broken. Implement them as a thin wrapper around:

  ```sh
  gnome-extensions enable copy-gnome@clipboard
  gnome-extensions disable copy-gnome@clipboard
  gnome-extensions info copy-gnome@clipboard
  ```

  This gives a reliable terminal recovery path even when the in-Shell IPC layer is down.

## Scope

CLI is **post-MVP** (suggest milestone M5 alongside the prefs GUI). The DBus service is
small enough that exporting `List/Use/ShowPopup` early is cheap and also lets
other tools (e.g. custom keybindings, `ydotool` scripts) drive copy-gnome.
