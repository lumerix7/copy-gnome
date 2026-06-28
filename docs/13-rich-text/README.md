# 13 - Rich Text

Rich text is one logical clipboard item (`kind=rich`) with multiple MIME payloads, usually
`text/html` plus a plain text fallback. The data model is defined in
[04-storage snapshot-line](../04-storage/snapshot-line.md#item-shape); this document covers
capture, paste policy, UI actions, and config.


## Capture

When a queued source advertises a rich text MIME (`text/html`, `text/rtf`,
`text/richtext`, or `text/markdown`):

1. Read the preferred rich MIME with the effective text cap. Preference order is
   `text/html`, then `text/rtf`, then `text/richtext`, then `text/markdown`.
2. Read the preferred plain text MIME (`text/plain;charset=utf-8`, then `text/plain`).
3. If the rich MIME read fails but plain text succeeds, capture as `kind=text`.
4. If both succeed, capture as `kind=rich` with `payloads[0]` as the primary rich MIME and
   a plain payload after it.
5. If the same source also advertises rich companion text formats, read them while the
   combined text cap still has room:
   - `text/rtf`
   - `text/richtext`
   - `text/markdown`
6. Use the plain payload to derive `preview`, row labels, and search text.
7. For `_lastContent`, compare `type=rich` using a value derived from the primary rich
   payload plus the plain fallback, not from plain text alone.

Firefox-specific MIME values such as `text/_moz_htmlinfo`, `text/_moz_htmlcontext`, and
`text/x-moz-url-priv` should be logged first and only persisted later behind an explicit
allow-list.

LibreOffice / Word-like sources commonly provide `text/html`, `text/rtf`,
`text/richtext`, `text/markdown`, plus OpenOffice internal object descriptors. Store the
standard text formats listed above. Do not persist OpenOffice internal embed/source XML
payloads by default; they can be large and may carry document-internal data that is not
needed for normal paste.


## Paste Policy

Rich text restore has two possible modes:

| Mode    | Clipboard write                                                                                                                                                                                      | Use case                                                                                        |
|---------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `rich`  | Current GNOME 50 implementation writes the primary rich MIME with `set_content()`. The target design is a multi-MIME selection source that offers the rich payloads and the plain fallback together. | Office apps, rich editors, browser contenteditable fields.                                      |
| `plain` | Write the plain fallback with `set_text()`.                                                                                                                                                          | Terminals, code editors, plain text fields, or when the user explicitly wants unformatted text. |

Default row activation (`Enter`, number quick-paste, single click, and row-menu `Paste`)
chooses a mode from the focused target app:

1. If the user selected an explicit row-menu action, use that action.
2. If target `wm_class` matches `ui.plainTextApps`, use `plain`.
3. If target `wm_class` matches `ui.richTextApps`, use `rich`.
4. Otherwise use `plain`.

This mirrors `ui.fileApps`: only configured target apps receive the richer clipboard MIME
by default. Plain paste is always available.

`ui.skipClipboardWriteForRecentTopSec` (see
[03-clipboard recent top restore shortcut](../03-clipboard/README.md#recent-top-restore-shortcut))
only skips a rich record's clipboard write when the requested mode matches the mode last
actually written for that row; a mode switch always writes for real, since each mode is a
single-MIME write that would otherwise leave the wrong (or no) target on the clipboard.


## UI Actions

For `kind=rich` rows, the item context menu should include:

- `Paste` - automatic mode from the target app policy above.
- `Paste plain` - force plain text restore for this activation, even if the target app
  matches `ui.richTextApps`.
- `Remove` - delete the entry.

Single click, `Enter`, and number quick-paste should keep using `Paste` (automatic mode).
This keeps the fast path predictable while still allowing a plain-text override from the
context menu when the target technically supports rich text but the user wants unformatted
content.

If automatic rich restore fails, it should warn and fail closed. It may fall back to plain
only if that behavior is explicit in the log and configuration; silent fallback makes
verification confusing.


## Multi-MIME Restore Follow-Up

The storage shape already keeps both payloads, so adding a real multi-MIME selection
source later should not require another storage migration. The remaining implementation work
is Shell/Mutter-specific clipboard ownership: replacing the current single-MIME
`St.Clipboard.set_content(primaryMime, bytes)` write with a memory selection source that can
serve the primary rich MIME, the plain fallback, and any stored companion formats such as
`text/rtf` for one clipboard owner.


## Config

Add these UI config keys:

```yaml
ui:
  richTextApps:
    - libreoffice
    - soffice
  plainTextApps:
    - terminal
    - org.gnome.console
```

Rules:

- Values are lower-case `wm_class` substrings, same matching style as `fileApps`.
- `plainTextApps` wins over `richTextApps`.
- Apps not listed in either default to plain.
- `Paste plain` from the item menu bypasses both lists.

`plainTextApps` is optional but useful because some apps can technically accept HTML in
some focused widgets and should still default to plain in repeated workflows.
