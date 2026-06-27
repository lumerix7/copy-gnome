# 06 - History model (MRU, dedup, eviction)

## In-memory model

`history.js` keeps an ordered array of records, **newest/most-recently-used first**.
This array is the source of truth; UI and store mirror it.

```
records: [ rec0 (top/MRU), rec1, rec2, ... ]
index:   Map<hash, rec>                          // O(1) dedup lookup
```

## MRU ordering (answers brief #2)

- **New copy** → insert at front, set `usedAt = now`.
- **Re-copy of existing content** (same hash) → **move existing record to front**,
  update `usedAt`, do not duplicate. This is the "used history floats to the top" rule.
- **Selecting an entry from the popup** (write-back) also counts as use → move to front,
  update `usedAt`. So picking an old entry promotes it.

Ordering key: `usedAt` desc.

## Dedup

- Key = `sha256` over the **canonical bytes** (for text: utf-8 bytes; for file refs: the
  normalized URI; for images: raw image bytes).
- `dedup: true` (default) merges identical content. If a near-identical text differs by
  trailing whitespace, it's still a different hash - acceptable for v1.
- With `dedup: false`, re-copying the same content keeps a new entry each time.
- A file copy is intentionally **not** merged with its later `text/plain` path twin (their
  hashes differ): both entries are kept, and the file entry is promoted back above the twin
  within a 3 s window. See [03](03-clipboard.md#capture-pipeline).

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
