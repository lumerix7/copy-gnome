# 03 - Clipboard: monitor, capture, write-back, paste, persistence, privacy

## Monitoring (Wayland-correct)

Do **not** poll. Use Mutter's selection API, available from inside the Shell:

```js
const selection = global.display.get_selection();   // Meta.Selection
this._ownerChangedId = selection.connect('owner-changed',
    (sel, selType, source) => {
        if (selType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;  // ignore PRIMARY/DND unless enabled
        this._onOwnerChanged(source);
    });
```

`owner-changed` fires whenever any client takes ownership of a selection. We then read
the new contents asynchronously.

### Reading contents

Two viable read paths:

- **`St.Clipboard`** (simplest): `get_text()`, and `get_content(mimetype, cb)` /
  `get_content()` returning `GLib.Bytes` for arbitrary mimes. Enumerate offered mimes
  via the `Meta.Selection` source (`source.get_mimetypes()`).
- **`Meta.Selection.get_async()`** for lower-level control (stream-based).

Recommended: query `source.get_mimetypes()` to decide the type, then read the *best*
representation with `St.Clipboard.get_content()`.

### Mime priority

Pick the canonical type to store, while **preserving all offered mimes for faithful
write-back** when feasible:

1. `text/uri-list` / `x-special/gnome-copied-files` → **file copy** only when `general.captureFiles` is enabled (store URI/path reference, never file bytes; see [04](04-storage.md)).
2. `image/png` (or other `image/*`) → non-file image payload only when `general.captureImages` is enabled.
3. `text/html` (+ keep a `text/plain` fallback).
4. `text/plain;charset=utf-8` / `text/plain` → text entry.
5. Anything else → opaque binary payload only if enabled and under the storage cap.

> Re-offering every original mime on write-back is ideal but heavy. MVP: store the
> canonical representation + the plain-text fallback; restore those two. Full multi-mime
> round-trip is a post-MVP nicety.

## Capture pipeline

`owner-changed` → read mimes → classify → **privacy filter** → build a candidate entry
→ **dedup** (hash) → either move-to-front (existing) or insert-at-front (new) in
`history.js` → mark store dirty.

Non-text clipboard capture is enabled by default in the current test build. On GNOME
Shell 46 Wayland, screenshot tools can place transient image data on the clipboard, and
reading those bytes from inside Shell has been observed to crash GNOME Shell (`signal 11`)
in this extension. File capture stores URI/path references only; image capture reads
bounded bytes and should be disabled in config if instability returns.

### Avoiding self-induced loops

When *we* set the clipboard (write-back), that triggers `owner-changed` again. Guard
with a short-lived flag / expected-hash so our own writes aren't re-captured as new
entries.

## Write-back

Selecting an entry restores it:

```js
const cb = St.Clipboard.get_default();
cb.set_content(St.ClipboardType.CLIPBOARD, mimetype, bytes);   // or set_text() for plain text
```

For file entries, set `text/uri-list` (+ `x-special/gnome-copied-files` with the
`copy\n<uri>` payload so file managers accept a paste).

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
- **Terminals** paste with **Ctrl+Shift+V** - matched by `wm_class` against
  `ui.terminalApps`.
- `ui.pasteOverrides` (checked first) maps a `wm_class` substring to a combo
  (`ctrl-v` | `ctrl-shift-v` | `shift-insert` | `none`) for apps with non-standard
  shortcuts; `none` skips injection.

The **clipboard is always set** regardless of auto-paste, so even a wrong/`none` combo
just means the user pastes manually with their own shortcut - nothing is lost. Auto-paste
is enabled by default (`ui.autoPaste: true`) but is best-effort convenience on top of the
guaranteed clipboard write.

## Clipboard persistence (survive source app exit)

On Wayland, when the owning client exits, the selection is dropped. Because the Shell
can own selections, copy-gnome can **re-assert ownership** of the most recent entry so
paste keeps working after the source closes. Implement by setting the clipboard to the
top entry when the previous owner disappears (config flag, default on for text and small
captured payloads; oversized binary payloads are skipped).

## Privacy & exclusions

Skip capturing when any of:

- The source advertises a **concealed/secret** hint mime. Honor common ones:
  `x-kde-passwordManagerHint` (value `secret`), and GNOME's password-entry concealed
  selections. Maintain a configurable `secretMimes` list.
- **Pause / incognito** mode is active (keybinding/CLI; no panel-menu pause item).
- Source app matches an **exclude list** (by app id / wm_class when resolvable).
- Content matches an **exclude regex** (e.g. looks like a TOTP, credit-card pattern) -
  configurable, off by default.
- Item exceeds `maxItemBytes` (configurable; oversized → skip or truncate-note).

All exclusion rules are config-driven; see [05](05-config.md).
