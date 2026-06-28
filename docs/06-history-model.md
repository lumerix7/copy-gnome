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
- A new capture always creates a new record.
- Restoring/selecting an existing record updates its `usedAt` and moves it to the front.
- There is no content hash and no deduplication. Re-copying the same visible content can
  produce another record if the monitor captures another real copy.
- The monitor may suppress a consecutive identical clipboard payload before it reaches
  history; if the current top record has the same payload, its `usedAt` is refreshed and the
  normal async snapshot path persists that update. This is runtime replay filtering, not
  history-level deduplication.


## Snapshot JSONL

Storage is append-only JSONL. Each line is a complete sorted history snapshot, not a
single item append.

```json
{
  "type": "history",
  "version": 1,
  "writtenAt": 1782734910723763,
  "items": []
}
```

| field       | meaning                                      |
|-------------|----------------------------------------------|
| `type`      | snapshot type, currently always `history`    |
| `version`   | snapshot schema version, currently `1`       |
| `writtenAt` | write time from `GLib.get_real_time()`       |
| `items`     | sorted record array, newest/MRU first        |

The store writes the newest pending snapshot after the configured debounce. If a snapshot
line would exceed the internal 64 MiB cap, the store keeps the most-recent prefix that
fits and syncs the running history to that persisted subset.


## Record schema

Every persisted record is normalized to this shape:

```json
{
  "id": "18334709-577d-4973-9a82-0d867d2216bf",
  "kind": "text",
  "mime": "text/plain;charset=utf-8",
  "encoding": "utf8",
  "text": "06-history-model.md",
  "data": null,
  "uri": null,
  "bytes": 19,
  "preview": "06-history-model.md",
  "createdAt": 1782734910223125,
  "usedAt": 1782734910223125
}
```

| field       | persisted | meaning |
|-------------|-----------|---------|
| `id`        | yes       | record uuid; monitor capture id is reused when available |
| `kind`      | yes       | `text`, `file`, `image`, and loader-tolerated `html` / `binary` |
| `mime`      | yes       | MIME used for restore/readback |
| `encoding`  | yes       | `utf8`, `base64`, or `uri` |
| `text`      | yes       | text payload, otherwise `null` |
| `data`      | yes       | base64 payload for image/binary, otherwise `null` |
| `uri`       | yes       | uri-list payload for copied files, otherwise `null` |
| `bytes`     | yes       | payload size used for caps and display |
| `preview`   | yes       | UI/search preview string |
| `createdAt` | yes       | first insert time from `GLib.get_real_time()` |
| `usedAt`    | yes       | MRU time from `GLib.get_real_time()` |

These fields are not persisted:

- queue/debug fields: `seq`, `sourceKind`, `sourceLabel`, `mimes`
- old file-twin process fields: `fileTwinUriList`, `synthesizedFilePath`
- monitor state: `_lastContent`
- content identity fields: hash, digest, dedup key


## Kind payloads

| kind     | payload field | encoding | restore behavior |
|----------|---------------|----------|------------------|
| `text`   | `text`        | `utf8`   | `Clipboard.setText(text)` |
| `file`   | `uri`         | `uri`    | `Clipboard.setContent('text/uri-list', uri bytes)` |
| `image`  | `data`        | `base64` | base64 decode, then `Clipboard.setContent(mime, bytes)` |
| `binary` | `data`        | `base64` | base64 decode, then `Clipboard.setContent(mime, bytes)` |
| `html`   | `text`        | `utf8`   | loader accepts it; current capture path stores plain text |

File records store URI/path references only. They do not store file bytes.


## File records

A copied file is represented as one ordinary record:

- `kind=file`: the `text/uri-list` payload in `uri`

No path twin record is created. On restore, the extension either writes the original
`text/uri-list` or decodes the URI list to path text, depending on target app config. See
[file-twin-design](features/clipboard-capture/file-twin-design.md).


## Eviction and caps

- `history.maxItemBytes` is checked before insertion for text/image payloads.
- `storage.textMaxBytes` and `storage.binaryMaxBytes` prevent oversized payloads from being
  stored.
- `history.maxAgeDays` drops old records during insertion when enabled.
- `history.maxItems` bounds the in-memory array.
- The store has an additional 64 MiB hard cap per snapshot line.


## Load behavior

Startup reads the newest available `clips-YYYYMMDD.jsonl` file and parses only the final
snapshot line. If the line is missing, corrupt, invalid, or oversized, history starts empty.
Older lines are left on disk for future repair tooling; the Shell extension does not scan
backwards to repair during startup.
