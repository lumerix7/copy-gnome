# 06 - History model

This document describes the data that is actually kept in memory and written to
`clips-YYYYMMDD.jsonl`. Runtime-only capture state, queue fields, and debug fields are
not part of the history model.


## In-memory model

`history.js` keeps one ordered array of records. The array is the running source of truth
for the UI and for persistence.

```js
records: [ rec0 /* MRU */, rec1, rec2, ... ]
```

- Ordering is `usedAt` descending.
- A successful capture creates a new record and keeps it as the latest/MRU entry.
- Restoring/selecting an existing record updates its `usedAt` and moves it to the front.
- On insertion, history computes the new head's content key:
  `kind + contentBytes + contentSha256`. The digest covers the primary `mime`, total byte
  count, payload count, and every ordered payload field (`mime`, `encoding`, `bytes`, `value`)
  using length-framed UTF-8 bytes. The index selects only matching candidates; every digest
  match is still compared field-by-field, so a theoretical SHA-256 collision cannot delete a
  different record. Exact older matches are removed in one batch before `maxItems` eviction.
  Older records are never compared with each other; filtering removed object references is at
  most one O(N) pass, not an all-pairs content comparison.
- `contentBytes` and `contentSha256` are required persisted record fields. They are loaded
  directly without hashing the payload again; a missing or malformed identity invalidates the
  snapshot. The in-memory bucket index itself is rebuilt on load/store trim and is not exposed
  through IPC. Fingerprint failure skips dedup for that record rather than blocking capture;
  slow per-record and full-index builds are logged without content.
- The monitor may suppress a consecutive identical clipboard payload before it reaches
  history; if the current top record has the same payload, its `usedAt` is refreshed and the
  normal async snapshot path persists that update. This is runtime replay filtering, not
  insertion-time history cleanup.
- Insertion cleanup is in-memory history maintenance only. It does not write the system
  clipboard. The latest pending snapshot reflects the compacted history, but older lines in
  append-only JSONL files are not rewritten.


## Snapshot JSONL

Storage is append-only JSONL. Each line is a complete sorted history snapshot, not a
single item append.

```json
{
  "type": "history",
  "writtenAt": 1782734910723763,
  "items": []
}
```

| field       | meaning                                      |
|-------------|----------------------------------------------|
| `type`      | snapshot type, currently always `history`    |
| `writtenAt` | write time from `GLib.get_real_time()`       |
| `items`     | sorted record array, newest/MRU first        |

The store appends the newest pending snapshot once per `storage.flushIntervalSec`
(default 3600s); there is no per-mutation write. If a snapshot line would exceed the
internal 64 MiB cap, the store keeps the most-recent prefix that fits and syncs the
running history to that persisted subset.


## Record Schema

The in-memory record shape and persisted record shape should match. All actual clipboard
payload values live in `payloads`; top-level fields are metadata only.

```json
{
  "id": "18334709-577d-4973-9a82-0d867d2216bf",
  "kind": "text",
  "mime": "text/plain;charset=utf-8",
  "bytes": 19,
  "contentBytes": 93,
  "contentSha256": "9fc53d370d64f5b691a76c479cf38543440fc34e5ca293c46a8dea1c605aaf0e",
  "createdAt": 1782734910223125,
  "usedAt": 1782734910223125,
  "payloads": [
    {
      "mime": "text/plain;charset=utf-8",
      "encoding": "utf8",
      "value": "06-history-model.md",
      "bytes": 19
    }
  ]
}
```

| field       | persisted | meaning                                                  |
|-------------|-----------|----------------------------------------------------------|
| `id`        | yes       | record uuid; monitor capture id is reused when available |
| `kind`      | yes       | `text`, `rich`, `file`, `image`, or `binary`             |
| `mime`      | yes       | primary MIME; normally `payloads[0].mime`                |
| `bytes`     | yes       | sum of persisted payload raw byte counts                 |
| `contentBytes` | yes       | byte length of length-framed canonical content |
| `contentSha256` | yes       | lowercase SHA-256 of that canonical content       |
| `createdAt` | yes       | first insert time from `GLib.get_real_time()`            |
| `usedAt`    | yes       | MRU time from `GLib.get_real_time()`                     |
| `payloads`  | yes       | one or more payload entries; primary payload first       |

Both content-identity fields are required. `kind` is kept outside the digest and is the first
part of the candidate key. `contentBytes` is the size of the canonical framed identity input,
not the raw clipboard payload size (`bytes`). A candidate match still requires exact equality
of `kind`, primary `mime`, top-level `bytes`, and every ordered payload's `mime`, `encoding`,
`bytes`, and `value`.

These fields are not persisted:

- queue/debug fields: `seq`, `sourceKind`, `sourceLabel`, `mimes`
- derived display fields: `preview`
- old file-twin process fields: `fileTwinUriList`, `synthesizedFilePath`
- monitor state: `_lastContent`
- runtime-only dedup index buckets and cached composite keys
- old single-payload fields: `text`, `data`, `uri`, `encoding`
- restore bookkeeping: `lastPasteMode` (`kind=rich` only; tracks which mode was last
  actually written so the [recent top restore shortcut](03-clipboard/README.md#recent-top-restore-shortcut)
  only skips a write when the requested mode is unchanged)


## Kind payloads

| kind     | primary payload                                                                                                         | restore behavior                                                                                                                           |
|----------|-------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `text`   | `text/plain;charset=utf-8`, `encoding=utf8`                                                                             | `Clipboard.setText(value)`                                                                                                                 |
| `rich`   | primary rich text MIME (`text/html`, `text/rtf`, `text/richtext`, or `text/markdown`), plus plain text fallback payload | plain mode writes fallback text; rich mode currently writes the primary rich MIME as one MIME, with multi-MIME restore left as a follow-up |
| `file`   | `text/uri-list`, `encoding=uri-list`                                                                                    | file targets receive `x-special/gnome-copied-files`; other targets receive decoded path text                                               |
| `image`  | image MIME, `encoding=base64`                                                                                           | base64 decode, then `Clipboard.setContent(mime, bytes)`                                                                                    |
| `binary` | binary MIME, `encoding=base64`                                                                                          | base64 decode, then `Clipboard.setContent(mime, bytes)`                                                                                    |

File records store URI/path references only. They do not store file bytes.


## File records

A copied file is represented as one ordinary record:

- `kind=file`: the `text/uri-list` payload in `payloads[0].value`

No path twin record is created. On restore, the extension either writes GNOME's file-copy
MIME (`x-special/gnome-copied-files`) or decodes the URI list to path text, depending on
target app config. See
[file-twin-design](03-clipboard/file-twin-design.md).


## Eviction and caps

- `history.maxItemBytes` is checked before insertion for text/image payloads.
- `storage.textMaxBytes` and `storage.binaryMaxBytes` prevent oversized payloads from being
  stored.
- `history.maxItems` is the only in-memory cap; it bounds the array shown in the popup.
- `history.maxAgeDays` is a disk-retention policy, not an in-memory eviction: a startup,
  periodic, and new-daily-file sweep deletes daily `clips-*.jsonl` files older than N days
  (default 3, 0 = disabled). It never touches the in-memory model - an old record stays in
  the popup as long as it remains within `maxItems`. See
  [04-storage](04-storage/cleanup-and-limits.md#cleanup).
- The store has an additional 64 MiB hard cap per snapshot line.


## Load behavior

Startup reads the newest available `clips-YYYYMMDD.jsonl` file and parses only the final
snapshot line. If the line is missing, corrupt, invalid, oversized, or does not match the
current schema, history starts empty. Older lines are left on disk for future repair tooling;
the Shell extension does not scan backwards to repair or migrate during startup.
