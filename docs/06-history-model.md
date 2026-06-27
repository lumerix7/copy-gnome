# 06 - History model (MRU, eviction)

## In-memory model

`history.js` keeps an ordered array of records, **newest/most-recently-used first**.
This array is the source of truth; UI and store mirror it.

```
records: [ rec0 (top/MRU), rec1, rec2, ... ]
```

There is no hash index and no content hashing. Every capture is appended as its own
record; the only content lookup (file-twin promotion) scans the array by uri-list, which
is bounded by `maxItems`. Each record's `id` is a `GLib.uuid_string_random()` v4 uuid -
an opaque per-record identity for the UI/store, independent of content.


## MRU ordering (answers brief #2)

- **New copy** → insert at front, set `usedAt = now`.
- **Re-copy of identical content** → still a **new record** at the front. Content is
  not merged, so the history faithfully reflects every copy action the user performed.
- **Selecting an entry from the popup** (write-back) counts as use → move that record to
  front, update `usedAt`. So picking an old entry promotes it.

Ordering key: `usedAt` desc.


## No content hash

- Every copy is kept as its own record: copying the same thing twice yields two records.
  This keeps the model simple and the history true to the user's actions; no content
  identity digest is computed or stored.
- The **self-write guard** (so the extension's own write-back is not recaptured as a new
  entry) and the **file-twin promotion** both match on the raw clipboard content directly
  - the text / uri-list, or the base64 payload for images. See [03](03-clipboard.md).
- A file copy and its later `text/plain` path twin are kept as two entries; within a 3 s
  window the file entry is promoted back above the twin (`history.touchByUri`). If no path
  twin and no other clipboard event arrives before the window expires, the monitor adds a
  synthetic path text entry and applies the same promotion. See
  [03](03-clipboard.md#capture-pipeline).


## Eviction

Triggered after each insert and on a periodic check:

1. Drop entries older than `maxAgeDays` (if > 0).
2. While `count > maxItems`: remove lowest `usedAt`.
3. `maxItemBytes` is enforced before insertion, so oversized items never enter history.

Every history change appends a full sorted snapshot line, so delete/clear state survives
restart as long as the latest valid snapshot line is readable (see [04](04-storage.md)).
If the snapshot reaches the internal 64 MiB store cap, oldest entries are trimmed and the
running history is synced to the persisted subset.


## Item actions

- delete (single), clear-all (with confirm), edit-text (creates a new record), "copy as
  plain text" (strips html/rich).


## Search

- Substring/fuzzy over `preview`/`text`; case-insensitive; ranks by match quality then
  `usedAt`. File entries match on path. Images match on a synthetic label such as
  `[image 3 KB]`. See [07](07-ui.md).
