# 03 - Clipboard: monitor, capture, write-back, paste, persistence, privacy

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

Two viable read paths:

- **`Meta.SelectionSource`**: each `owner-changed` event provides a source. The monitor
  enqueues that source and reads its content via `source.read_async(mimetype, ...)` /
  `read_finish()`, so FIFO queue order and clipboard content stay tied to the same event.
- **`Meta.Selection.get_async()`** for lower-level control (stream-based).

Recommended: query `source.get_mimetypes()` to decide the type, then read the *best*
representation from that same queued `source`.


### Mime priority

Pick the canonical type to store, while **preserving all offered mimes for faithful
write-back** when feasible:

1. `text/uri-list` / `x-special/gnome-copied-files` → **file copy** only when `general.captureFiles` is enabled (store one URI-list reference record, never file bytes; see [04](04-storage.md)).
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
to write `text/uri-list` or decoded path text.

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

For file entries, the current build sets **`text/uri-list` only** (Nautilus and many file
managers accept it for a paste). Offering `x-special/gnome-copied-files` (the
`copy\n<uri>` payload) and `text/plain` *together* - so every file manager pastes the file
and editors paste the path from the same entry - requires a multi-mime
`Meta.SelectionSource` (`St.Clipboard.set_content` sets only one mime and replaces on each
call). That is a planned enhancement, not yet implemented.


### Recent top restore shortcut

When the selected record is already row 1 and its `usedAt` timestamp is recent enough,
`ui.skipClipboardWriteForRecentTopSec` skips the clipboard write and continues with the
normal restore flow: MRU touch, async store flush scheduling, and optional auto-paste still
run. The default is 3 seconds; `0` disables the shortcut, and the accepted range is
0..900 seconds.

This mainly avoids repeatedly rewriting the system clipboard during short bursts of row-1
paste/restore. It also keeps file cut/paste flows closer to the compositor's current
selection and reduces self-write clipboard queue noise during repeated row-1 paste.


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
- **Terminals** paste with **Ctrl+Shift+V** - if the focused window has a
  `wm_class`, it is lower-cased and matched by substring against lower-cased
  `ui.terminalApps` entries. The default is `["terminal"]`.
- `ui.pasteOverrides` (checked first) maps a `wm_class` substring to a combo
  (`ctrl-v` | `ctrl-shift-v` | `shift-insert` | `none`) for apps with non-standard
  shortcuts; `none` skips injection.

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

All exclusion rules are config-driven; see [05](05-config.md).
