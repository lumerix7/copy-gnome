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
copy-gnome list [--limit N] [--json]
copy-gnome search <query> [--limit N] [--json]
copy-gnome get <id> [--raw] [--json]
copy-gnome use <id> [--mode rich|plain] [--json]
copy-gnome copy [text | -] [--json]
copy-gnome paste [--json]
copy-gnome rm <id> [--json]
copy-gnome clear --yes [--json]
copy-gnome popup [--json]
copy-gnome config path|validate|show|get|set|edit
copy-gnome repair [--file PATH] [--yes] [--json]
copy-gnome --completion bash
```

Design boundary: this CLI does **not** import GJS, GNOME Shell modules, or extension
runtime code. It uses Node plus stable external commands (`gnome-extensions`,
`gsettings`, `journalctl`, `busctl`) and filesystem checks, so the rescue commands remain
useful when the Shell extension is disabled, absent, or broken. The in-memory history
commands (`list`, `get`, `use`, `copy`, `paste`, `search`, `rm`, `clear`, `popup`) talk
to the extension's DBus control service - **implemented, see [14-ipc](14-ipc/README.md)**
- and fail with exit code 3 while that service is unavailable. `status` additionally
shows a live Service section from the same channel, degrading gracefully; `doctor` stays
fully offline by design.

`scripts/install-cli.sh` installs bash completion to
`${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/copy-gnome` by running
`copy-gnome --completion bash`. Completion covers top-level commands, command options,
`config` subcommands, config keys for `config get` / `config set`, and file completion for
`repair --file`.

Implemented config commands:

```sh
copy-gnome config path
copy-gnome config validate
copy-gnome config show [--json] [--meta]
copy-gnome config get general.captureImages [--json]
copy-gnome config set general.captureImages false [--json]
copy-gnome config edit [--editor 'code --wait']
```

`path`, `validate`, `show`, and `get` are read-only. `set` validates the key and value
(booleans, integers, numeric ranges, and `storage.backend` / `logging.level` enums are
checked, and an out-of-range or otherwise invalid value is rejected), then rewrites only
that key in the existing `config.yaml` through a temporary file and rename, preserving
comments, key order, and any keys this CLI does not recognize. If the current `config.yaml` cannot be
parsed, `set` refuses rather than clobbering settings it could not read - fix it or use
`edit`. `edit` opens a temporary copy with `--editor`, `$VISUAL`, `$EDITOR`, or the system
`editor` command, validates YAML syntax, then replaces `config.yaml`; invalid YAML leaves
the old file untouched. If only `config.json` exists, `set` / `edit` create `config.yaml`,
which then takes precedence. These commands do not import extension runtime code or ask
GNOME Shell to reload settings.

Known GNOME Shell log noise, including Ubuntu Dock keybinding warnings, is documented in
[99-troubleshooting](99-troubleshooting.md).


## IPC choice: DBus default, swappable transport

The CLI can't read history directly (it lives inside `gnome-shell`), so it needs an IPC
channel into the extension. The implemented transport is DBus; the extension-side logic
still goes through a small `IpcTransport` boundary so the transport can be replaced later
without changing the handler semantics or CLI-visible envelope.

| | **DBus** (current default) | **Unix socket** |
|---|---|---|
| Setup | register a bus name after runtime start | Future runtime socket path TBD; do not create `$BASE/state` in the Shell path |
| Tooling | `gdbus`/`busctl` work for free; introspectable | none free - custom line/JSON protocol |
| Deps | session bus | none; fully self-contained |
| Cost | bus name + boilerplate | manual message framing |

> Note on "输入法没用 DBus 了": modern IMEs moved to the **Wayland `text-input`
> protocol** for *input events* - a different plane from *control IPC*. (IBus/Fcitx5
> still use DBus for their control surfaces.) So that shift doesn't argue against DBus for
> our control channel; both DBus and a unix socket remain fine here.


### Decision

DBus is **not** at risk of going away in GNOME - the Shell itself is built on it
(notifications, settings, the extensions API, search providers). The concern worth
honoring isn't "DBus will be deprecated" but "keep the transport boundary small." So:

- The extension logic talks to a thin **`IpcTransport`** interface (`start(handlers)`,
  `stop()`, `emit(signal, payload)`); the JSON envelope is the stable contract.
- The default implementation is **`DBusTransport`** - `Gio.DBusExportedObject.wrapJSObject(xml, impl)`
  is ~10 lines and you get `gdbus call` / `busctl` for free while developing.
- A **`SocketTransport`** (Gio.SocketService, path TBD) can drop in
  later with zero change to the logic or the CLI surface - an afternoon's work if DBus
  ever becomes inconvenient.

Why DBus first, not socket: the socket's only real edge is "no session-bus dependency,"
which is moot inside a GNOME session, while it *adds* code and failure modes (stale `.sock`
after a crash, `EADDRINUSE`, manual message framing, you must hand-write the client). DBus
is less code and self-documenting. Swappability - not transport choice - is what keeps us
safe if requirements change.

> **Status: implemented.** `DBusTransport` lives in `core/ipc.js`; the exported method
> surface, JSON envelope, error codes, and lifecycle are specified in
> [14-ipc](14-ipc/README.md). Signals (`emit`) are not implemented yet - nothing
> consumes them.


## Recommendation: yes - a thin CLI over the control channel

A CLI is genuinely useful for a clipboard manager (CopyQ ships `copyq` for exactly this:
scripting, `xdotool`-style automation, piping). But the history lives **inside
`gnome-shell`**, so a CLI can't read it directly - it must talk to the extension.

**Design: the extension exposes a private DBus service; `copy-gnome` (CLI) is a thin
client that calls it.** This keeps one source of truth (the in-Shell `history.js`) and
adds zero new storage path.

- Bus: **session bus**, well-known name `org.gnome.Shell.Extensions.CopyGnome`,
  object path `/org/gnome/Shell/Extensions/CopyGnome`.
- The extension registers the service at the end of runtime start (after history load;
  via `Gio.DBusExportedObject`) and unexports in `disable()`. When the extension is
  disabled, the CLI gets a clear "service not available - is the extension enabled?"
  error.
- No new daemon: the service lives and dies with the extension.


## CLI surface (implemented)

```
copy-gnome list [--limit N] [--json]        # recent entries (number, kind, size, id, preview)
copy-gnome get <id> [--raw]                 # print one entry's content to stdout
copy-gnome copy [text | -]                  # set clipboard from arg or stdin  → new entry
copy-gnome paste                            # print current clipboard text to stdout
copy-gnome use <id> [--mode rich|plain]     # restore entry to clipboard (move-to-front, no auto-paste)
copy-gnome search <query> [--limit N] [--json]
copy-gnome rm <id> | copy-gnome clear --yes
copy-gnome status                           # extension state + live service section
copy-gnome enable | disable | restart       # enable/disable the Shell extension itself
copy-gnome extension-status                 # wrapper around gnome-extensions info
copy-gnome doctor [--json] [--since DURATION]
copy-gnome popup                            # toggle the history popup (same as the hotkey)
```

`<id>` is the record uuid shown by `list`; a unique prefix of 4+ chars is accepted
(`list` prints the first 8 chars). Method surface, envelope, and error codes:
[14-ipc](14-ipc/README.md).

Useful config examples:

```bash
copy-gnome config set ui.skipClipboardWriteForRecentTopSec 3
copy-gnome config set ui.skipClipboardWriteForRecentTopSec 0  # disable row-1 write skip
copy-gnome config set ui.popupTheme auto                      # auto | dark | light
copy-gnome config set ui.popupOpacity 0.92                    # less transparent popup
copy-gnome config set storage.flushIntervalSec 1800           # 30m periodic history flush
copy-gnome config set storage.textMaxBytes 1048576            # 1 MiB text cap
copy-gnome config set storage.binaryMaxBytes 1048576          # 1 MiB raw image/binary cap
```

- Storage caps are still bounded by `history.maxItemBytes`.
- Binary kinds: `get <id> --raw` decodes the clip's inline base64 data when available;
  `list` shows a label.
- `--json` everywhere for scripting; default output is human-readable.
- Exit codes: `0` ok, `1` unhealthy checks, `2` bad args, `3` service unavailable,
  `4` not found.
- `disable` unloads the extension through GNOME Shell, useful when a Shell-side bug needs a
  quick terminal escape hatch.
- `doctor` stays offline so it still works when the extension's own DBus service is
  unavailable.


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

- Detect `gnome-shell --version`; warn if it is not one of the tested majors for the
  checked-out builds (currently GNOME 46 and 50).
- Detect session type from `$XDG_SESSION_TYPE`; warn that Wayland requires logout/login
  after JS changes and cannot use `Alt+F2`, `r` restart.
- Verify the extension install directory exists and contains `metadata.json`,
  `extension.js`, `schemas/gschemas.compiled`, `core/`, `ui/`, and `vendor/`
  (implemented as the `extension.files` check; a missing required file is `fail`).
- Warn when the `toggle-popup` keybinding is empty (`@as []`), since the popup
  cannot be opened without one (implemented as part of `gsettings.toggle-popup`).
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
  screenshot shortcuts, and the extension's `toggle-popup` keys (planned; only the empty-keybinding case above is implemented yet).

Live service checks are intentionally outside `doctor`:

- `copy-gnome status` adds a Service section by calling the DBus `Status` method when the
  service is reachable, and degrades gracefully when it is not.
- `copy-gnome list --limit 1 --json` is the non-destructive smoke test for in-memory
  history access.
- `copy-gnome popup` is explicit and may grab focus; diagnostics do not call it
  implicitly.


### Severity

Each check returns one of:

| Severity | Meaning                                               |
|----------|-------------------------------------------------------|
| `ok`     | Expected state.                                       |
| `info`   | Useful context, not a problem.                        |
| `warn`   | Suspicious or risky, but not known broken.            |
| `fail`   | Known broken or unsafe enough that the CLI exits `1`. |

Rules of thumb:

- Disabled extension is `warn` unless the user passed `--require-active`, then `fail`.
- Missing install dir is `fail`.
- Unsupported GNOME major is `fail` for install/run commands, `warn` for pure log review.
- `captureImages: true` or `captureFiles: true` is `warn` because non-text capture is
  opt-in and riskier inside GNOME Shell.
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
```

Focused log and environment commands are separate top-level commands:

```text
copy-gnome logs --since 2h
copy-gnome status
copy-gnome paths
```

Keep `doctor` read-only. Any future repair action must be explicit, e.g.
`copy-gnome repair disable-risky-capture` or `copy-gnome disable`.


## DBus contract and implementation notes

- The implemented method surface, DBus signatures, JSON envelope, error codes, and manual
  `busctl` / `gdbus` debugging commands live in [14-ipc](14-ipc/README.md). Do not keep a
  second XML sketch here.
- The Node CLI talks to the service through `busctl --user --json=short`; it does not
  import GJS or extension runtime code.
- Extension lifecycle commands (`enable`, `disable`, `restart`, `extension-status`) do
  **not** depend on the extension's DBus service, because that service is unavailable when
  the extension is disabled or broken. They remain a terminal recovery path even when the
  in-Shell IPC layer is down.
- Session bus is a per-user boundary. The service deliberately exposes no config mutation
  or command execution methods; privacy skips happen at capture time before items can
  appear in `List` / `Get`.
