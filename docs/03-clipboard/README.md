# 03 - Clipboard: monitor, capture, write-back, paste, persistence, privacy

## Reading Order

| Doc                                     | Topic                                                      |
|-----------------------------------------|------------------------------------------------------------|
| [README](README.md)                     | Monitoring, MIME priority, write-back, auto-paste, privacy |
| [capture-pipeline](capture-pipeline.md) | Restore/enqueue/drain model, `_lastContent`, drop reasons  |
| [file-twin-design](file-twin-design.md) | GNOME 50 file-copy capture/restore and memory path twins   |

## Monitoring (Wayland-correct)

Do **not** poll. Use Mutter's selection API, available from inside the Shell:

```js
const selection = global.display.get_selection();   // Meta.Selection
this._ownerChangedId = selection.connect('owner-changed',
    (sel, selType, source) => {
        if (selType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;  // only the CLIPBOARD selection
        this._onOwnerChanged(source);
    });
```

`owner-changed` fires whenever any client takes ownership of a selection. We then read
the new contents asynchronously.


### Reading contents

`owner-changed` still provides the source metadata used for `sourceKind`, MIME
classification, queue context, and logs. Payload bytes are read through the Shell clipboard
wrapper path instead of `Meta.SelectionSource.read_async()`.

Do not call `Meta.SelectionSource.read_async()` for capture payloads. On GNOME 50 that
native path has been observed to crash `gnome-shell` when a transient external owner is
read. Empty or failed clipboard reads are skipped fail-closed.


### Mime priority

Pick the canonical type to store, while **preserving all offered mimes for faithful
write-back** when feasible:

1. `text/uri-list` / `x-special/gnome-copied-files` → **file copy** only when `general.captureFiles` is enabled (store one URI-list reference record, never file bytes; see [04](../04-storage/README.md)).
2. `image/png` (or other `image/*`) → non-file image payload only when `general.captureImages` is enabled.
3. `text/html` (+ keep a `text/plain` fallback).
4. `text/plain;charset=utf-8` / `text/plain` → text entry.
5. Anything else → opaque binary payload only if enabled and under the storage cap.

> Re-offering every original mime on write-back is ideal but heavy. MVP: store the
> canonical representation + the plain-text fallback; restore those two. Full multi-mime
> round-trip is a post-MVP nicety.


## Capture pipeline

`owner-changed` → read mimes → classify → **privacy filter** → build a candidate entry
→ **insert at front** of `history.js` as a new record (every capture is kept)
→ mark store dirty.

Monitor queue processing is read-only: it never writes back to the system clipboard and
never computes/stores a content hash. It only suppresses consecutive identical clipboard
payloads via the monitor's single `_lastContent` slot; it does not search or merge older
history records. Clipboard writes happen only when the user activates an existing history
entry.

File capture creates exactly one **file** entry from `text/uri-list`/`x-special`. It does
not wait for, synthesize, or promote a separate `text/plain` path entry. The file entry keeps
the URI-list reference only; when the user restores it, the target app config decides whether
to write GNOME's file-copy MIME (`x-special/gnome-copied-files`) or decoded path text.
If a later `Meta.SelectionSourceMemory` event exposes the previous file path as
`text/plain`, the monitor drops it only when it exactly matches the decoded current file
URI-list path; other memory text remains capturable. See
[file-twin-design](file-twin-design.md).

URI-list input accepts both standard `file:///absolute/path` and authority-less
`file:/absolute/path` file URIs; copy-gnome stores and restores URI-list output as
standard `file:///absolute/path`.

When `x-special/gnome-copied-files` is offered, the first payload line may be `copy` or
`cut`. The monitor logs this as `fileAction=copy|cut|unknown` and stores only the normalized
URI list. Current restore treats the entry as a file reference, not as a destructive move.
Plain text cut/copy generally exposes the same text clipboard payload, with no separate
standard action field to preserve.

Non-text clipboard capture is enabled by default in the current test build. On GNOME
Shell 46 Wayland, screenshot tools can place transient image data on the clipboard, and
reading those bytes from inside Shell has been observed to crash GNOME Shell (`signal 11`)
in this extension. File capture stores URI/path references only; image capture reads
bounded bytes and should be disabled in config if instability returns.


### Avoiding self-induced loops

When *we* set the clipboard (write-back), that triggers `owner-changed` again. Guard by
remembering the exact content we just wrote in the monitor's single `_lastContent` slot
(`origin=restore`, no TTL). Any next queued read whose `type` + `value` matches that slot is
skipped before it reaches history, so our own writes and Wayland owner re-announces are not
re-captured as new entries. Consecutive user copies of the exact same payload also collapse
to one visible entry; older matching history records are never searched or promoted.


## Write-back

Selecting an entry restores it:

```js
const cb = St.Clipboard.get_default();
cb.set_content(St.ClipboardType.CLIPBOARD, mimetype, bytes);   // or set_text() for plain text
```

For file entries, file-target apps receive **`x-special/gnome-copied-files`** with a
non-destructive `copy\n<uri-list>` payload. Other apps receive decoded `text/plain` path
text. Offering `x-special/gnome-copied-files`, `text/uri-list`, and `text/plain` together
requires a multi-mime `Meta.SelectionSource` (`St.Clipboard.set_content` sets only one mime
and replaces on each call). That remains a planned enhancement.


### Recent top restore shortcut

When the selected record is already row 1 and its `usedAt` timestamp is recent enough,
`ui.skipClipboardWriteForRecentTopSec` skips the clipboard write and continues with the
normal restore flow: MRU touch, async store flush scheduling, and optional auto-paste still
run. The default is 3 seconds; `0` disables the shortcut, and the accepted range is
0..900 seconds.

This mainly avoids repeatedly rewriting the system clipboard during short bursts of row-1
paste/restore. It also keeps file cut/paste flows closer to the compositor's current
selection and reduces self-write clipboard queue noise during repeated row-1 paste.

For `kind=rich` records the shortcut additionally requires the resolved paste mode
(`rich`/`plain`, see [13-rich-text](../13-rich-text/README.md#paste-policy)) to match the
mode actually written last time (`rec.lastPasteMode`, in-memory only, not persisted). The
write is single-MIME, so skipping it when the mode changed would leave the clipboard
offering the wrong (or no) target for the new mode. The very first restore of a rich record
always writes for real, even inside the window, since no prior mode is confirmed yet; only a
later restore of the same row in the same mode can skip.


## Auto-paste (optional)

After write-back, optionally inject Ctrl+V. From inside the compositor this is allowed
on Wayland via a Clutter virtual device:

```js
const seat = Clutter.get_default_backend().get_default_seat();
const vdev = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
// press Ctrl, press V, release V, release Ctrl  (vdev.notify_keyval)
```

Caveats: timing (set clipboard *before* injecting; the `notify_keyval` time arg is in
**microseconds** - `Clutter.get_current_event_time() * 1000`), and the previously-focused
window must regain focus after the popup closes (we inject after `ui.autoPasteDelayMs`,
default 220 ms).

**There is no semantic "paste" on Wayland** - paste is always the app reading the
clipboard via *its own* shortcut, so auto-paste must inject the app-appropriate keystroke:

- Default **Ctrl+V**.
- `ui.defaultPasteKeys` is the fallback key list, default `[ctrl, v]`.
- `ui.pasteKeybindings` is checked first, in order. Each entry is
  `{ keys: [...], apps: [...] }`; `apps` are lower-cased `wm_class` substrings, and
  `keys` are case-insensitive key tokens such as `ctrl`, `shift`, `alt`, `super`,
  `insert`, `enter`, `tab`, `space`, `f1`, or single letters/digits. The default terminal
  rule is `{ keys: [ctrl, shift, v], apps: [terminal] }`.
- `keys` is a low-level key list: order and duplicates are preserved, and unusual lists
  such as `[p]` or `[ctrl, a, e]` are accepted. Invalid key tokens are warned and dropped; if a
  non-empty app rule has no valid keys left, that rule is ignored. `keys: []` restores the
  clipboard without injecting a paste keystroke.

Restore normally writes the clipboard before auto-paste. The only configured exception is
the recent row-1 shortcut above, which skips only that system clipboard write. Auto-paste
is enabled by default (`ui.autoPaste: true`) but remains best-effort convenience on top of
restore.


## Clipboard persistence (survive source app exit)

On Wayland, when the owning client exits, the selection is dropped. Because the Shell
can own selections, copy-gnome can **re-assert ownership** of the most recent entry so
paste keeps working after the source closes. Implement by setting the clipboard to the
top entry when the previous owner disappears (config flag, default on for text and small
captured payloads; oversized binary payloads are skipped).


## Privacy & exclusions

Skip capturing when any of:

- The source advertises a **concealed/secret** hint mime and the user configured it in
  `privacy.secretMimes`. Common optional entries include `x-kde-passwordManagerHint`
  (value `secret`) and GNOME's password-entry concealed selections. The default list is
  empty so password/token copies remain pasteable from history unless the user opts out.
- Source app matches an **exclude list** (by app id / wm_class when resolvable).
- Content matches an **exclude regex** (e.g. looks like a TOTP, credit-card pattern) -
  configurable, off by default.
- Item exceeds `maxItemBytes` (configurable; oversized → skip or truncate-note).

All exclusion rules are config-driven; see [05](../05-config.md).
