# 14 - IPC: DBus control service

Implements the control channel decided in [12-cli](../12-cli.md): the extension exports a
private session-bus service; the `copy-gnome` CLI is a thin client. History stays inside
`gnome-shell` as the single source of truth - no new daemon, no new storage path.

- Bus: **session bus**, well-known name `org.gnome.Shell.Extensions.CopyGnome`.
- Object path: `/org/gnome/Shell/Extensions/CopyGnome`, interface name = bus name.
- Extension side: [`core/ipc.js`](../../copy-gnome-50/core/ipc.js) (`DBusTransport`) plus
  the `_ipc*` handlers in `extension.js`.
- CLI side: [`cli/src/lib/ipc.js`](../../cli/src/lib/ipc.js), calling
  `busctl --user --json=short` (Node + a stable external command, per the CLI's no-GJS
  design boundary).


## Lifecycle

The service is started at the end of `_startRuntime()` - i.e. only after `store.open()` +
`history.load()` have populated the in-memory model - and stopped in `disable()`
(unexport + unown, before the store closes). While the extension is disabled, loading, or
broken, the bus name simply has no owner and the CLI reports "service not available"
with exit code 3.

Fail-closed rules (see also [CLAUDE.md](../../CLAUDE.md)):

- A failed name-own or export is logged (`[ipc]:` prefix) and leaves the service off; the
  extension keeps running without CLI history commands.
- Handlers never throw into the Shell: the transport wraps every call, and a handler
  error becomes an `{ ok: false, code: "internal-error" }` reply.
- Handlers reply asynchronously (GJS `<Method>Async` dispatch), so a slow clipboard read
  never blocks the compositor loop.


## Method surface

Every method returns a single string: a JSON **envelope**. Success is
`{ "ok": true, ... }`; failure is `{ "ok": false, "code": "...", "error": "..." }`.

| Method             | In args              | Success payload                                    |
|--------------------|----------------------|----------------------------------------------------|
| `List`             | `u limit` (0 = all)  | `{ total, items: [item] }`                         |
| `Get`              | `s id`               | `{ item }` with `payloads` included                |
| `Use`              | `s id, s mode`       | `{ id, kind }` - restore + MRU touch, **no auto-paste**; `mode` `""`/`rich`/`plain` |
| `CopyText`         | `s text`             | `{ id, bytes }` - new text entry + clipboard write |
| `GetClipboardText` | -                    | `{ hasText, text }`                                |
| `Search`           | `s query, u limit`   | `{ total, items }` - case-insensitive substring over text/uri payloads |
| `Remove`           | `s id`               | `{ id }`                                           |
| `Clear`            | -                    | `{ cleared }`                                      |
| `Popup`            | -                    | `{}` - toggles the popup, same as the keybinding   |
| `Status`           | -                    | `{ uuid, version, ready, count }`                  |

`item` shape: `{ id, kind, mime, bytes, preview, createdAt, usedAt }`; `preview` is
derived from payloads for list/search output and is not stored. Timestamps are
`GLib.get_real_time()` microseconds, as stored. `Get` adds
`payloads: [{ mime, encoding, bytes, value }]` - base64 payloads stay base64-encoded
strings, already bounded by the storage caps ([04-storage](../04-storage/README.md)).

Error codes: `not-ready`, `bad-args`, `not-found`, `ambiguous`, `too-large`,
`clipboard-write-failed`, `restore-failed`, `not-implemented`, `internal-error`. The CLI
adds transport-level codes (`service-unavailable`, `no-busctl`, `timeout`, `bad-reply`,
`call-failed`) in the same envelope shape and maps everything to the
[12-cli](../12-cli.md) exit codes: `0` ok, `1` failed, `2` bad args (incl. `ambiguous`),
`3` service unavailable (incl. `not-ready`), `4` not found.

**Id prefixes:** `Get` / `Use` / `Remove` accept the full record uuid or a unique prefix
of at least 4 chars (`ambiguous` if several match). `copy-gnome list` prints the 8-char
prefix for this reason.


## Semantics worth knowing

- **`Use` never auto-pastes.** A CLI restore has no sensible paste target (the focused
  window is the terminal), so the handler passes `autoPaste: false` into `_restore()`;
  everything else (recent-top skip, rich mode resolution, MRU touch, self-write marker)
  behaves exactly like a popup restore.
- **`CopyText` does the same self-write dance as restore** (docs
  [03-clipboard/capture-pipeline](../03-clipboard/capture-pipeline.md)): mark
  `_lastContent(origin=restore, source=(cli-copy))`, write the clipboard, roll the marker
  back on failure. The history entry is added directly, so the monitor's echo drop cannot
  lose it, and text caps (`history.maxItemBytes`, `storage.textMaxBytes`) are enforced
  before anything is written.
- **`Status` is the one unguarded method** - it answers even while other handlers would
  return `not-ready`, so `copy-gnome status` can show service health during load.


## Transport swappability

Extension logic only sees the `IpcTransport` surface (`start(handlers)` / `stop()`).
`DBusTransport` is the default; a `SocketTransport` could replace it without touching the
handlers or the CLI-visible contract (the envelope). Signals/`emit()` are deliberately
not implemented yet - nothing consumes them.


## Debugging without the CLI

```sh
busctl --user introspect org.gnome.Shell.Extensions.CopyGnome \
    /org/gnome/Shell/Extensions/CopyGnome

busctl --user --json=short call org.gnome.Shell.Extensions.CopyGnome \
    /org/gnome/Shell/Extensions/CopyGnome org.gnome.Shell.Extensions.CopyGnome \
    List u 5

gdbus call --session --dest org.gnome.Shell.Extensions.CopyGnome \
    --object-path /org/gnome/Shell/Extensions/CopyGnome \
    --method org.gnome.Shell.Extensions.CopyGnome.Status
```

Service logs use the `[ipc]:` prefix: `journalctl --user -f | grep -i copy-gnome`.


## Security notes

Any process on the user's session bus can call these methods - the same trust boundary
as the user's own session (a local process could equally run `wl-paste` or inject input).
No secrets are exposed beyond what the history already stores; privacy skips
([03-clipboard](../03-clipboard/README.md)) happen at capture time, so skipped selections
never reach `List`/`Get`. There is deliberately no method that changes config or executes
anything.
