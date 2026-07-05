# Snapshot Line

`clips-YYYYMMDD.jsonl` is append-only. Each line is one full history snapshot.

## Snapshot Object

```json
{
  "type": "history",
  "writtenAt": 1782610200000000,
  "items": []
}
```

| Field       | Required | Type   | Meaning                                    |
|-------------|----------|--------|--------------------------------------------|
| `type`      | yes      | string | Snapshot type, currently always `history`. |
| `writtenAt` | yes      | number | Local write time in GLib microseconds.     |
| `items`     | yes      | array  | Sorted history records, newest first.      |

Rules:

- A line is valid only if it parses as JSON, matches the current schema, and stays
  under internal size caps.
- Normal startup reads a bounded tail and loads only the newest non-empty snapshot line.
- If loading any candidate file fails, do not repair or move files; start with empty history
  and append future clips to the current day file.


## Item Shape

Use `payloads`, not `formats`, for the multi-MIME data list. "Format" is often a MIME
name only; each entry here carries the actual clipboard payload. `payloads` also avoids
confusion with visual text formatting.

Record fields:

| Field       | Required | Type   | Meaning                                                           |
|-------------|----------|--------|-------------------------------------------------------------------|
| `id`        | yes      | string | Stable record identity for UI/CLI actions.                        |
| `kind`      | yes      | string | Logical item kind: `text`, `rich`, `file`, `image`, `binary`.     |
| `mime`      | yes      | string | Primary MIME. This should match `payloads[0].mime`.               |
| `bytes`     | yes      | number | Sum of raw bytes for persisted payload entries.                   |
| `contentBytes` | yes      | number | Byte length of length-framed canonical content. |
| `contentSha256` | yes      | string | Lowercase SHA-256 of canonical content.       |
| `createdAt` | yes      | number | First capture time in GLib microseconds.                          |
| `usedAt`    | yes      | number | Last restore/touch time in GLib microseconds.                     |
| `payloads`  | yes      | array  | One or more MIME payload entries. Primary payload first.          |

Payload entry fields:

| Field      | Required | Type   | Meaning                                             |
|------------|----------|--------|-----------------------------------------------------|
| `mime`     | yes      | string | MIME offered/read for this representation.          |
| `encoding` | yes      | string | `utf8`, `uri-list`, or `base64`.                    |
| `value`    | yes      | string | Payload value. For `base64`, this is base64 text.   |
| `bytes`    | yes      | number | Raw bytes before JSON escaping or base64 expansion. |

Do not write top-level `text`, `data`, `uri`, or `encoding`. All actual clipboard payload
values live in `payloads`; top-level fields are metadata only.

History uses `kind + contentBytes + contentSha256` only as a candidate index, then compares
the underlying record fields exactly before deleting anything. Both identity fields are
required; a missing or malformed field invalidates the snapshot. The monitor self-write guard
independently matches the immediately previous clipboard content directly.

The payload examples below omit these two derived identity fields for readability; actual new
snapshot writes include them.

Proposed rich-text record:

```json
{
  "id": "5121837b-29ca-487b-9b5f-2f322109dfdd",
  "kind": "rich",
  "mime": "text/html",
  "bytes": 4620,
  "createdAt": 1782924219704377,
  "usedAt": 1782924219704377,
  "payloads": [
    {
      "mime": "text/html",
      "encoding": "utf8",
      "value": "<html-fragment>...</html-fragment>",
      "bytes": 3473
    },
    {
      "mime": "text/plain;charset=utf-8",
      "encoding": "utf8",
      "value": "plain fallback for search and preview",
      "bytes": 1147
    }
  ]
}
```

`bytes` at the item level is the sum of stored payload raw byte counts.

Other target examples:

```json
{
  "id": "txt...uuid",
  "kind": "text",
  "mime": "text/plain;charset=utf-8",
  "bytes": 5,
  "createdAt": 1782610000000000,
  "usedAt": 1782610000000000,
  "payloads": [
    {"mime":"text/plain;charset=utf-8","encoding":"utf8","value":"hello","bytes":5}
  ]
}
```

```json
{
  "id": "file...uuid",
  "kind": "file",
  "mime": "text/uri-list",
  "bytes": 23,
  "createdAt": 1782610000000000,
  "usedAt": 1782610000000000,
  "payloads": [
    {"mime":"text/uri-list","encoding":"uri-list","value":"file:///home/user/a.txt","bytes":23}
  ]
}
```

Firefox-specific formats such as `text/_moz_htmlinfo`, `text/_moz_htmlcontext`, and
`text/x-moz-url-priv` should be logged first and only persisted later behind an explicit
allow-list. A rich-text record should store the primary rich MIME plus
`text/plain;charset=utf-8`; Office-like companion text formats may be stored after those.


## Version Policy

Do not maintain a runtime compatibility path for old v1 `text` / `data` / `uri` records.
After this schema is implemented, old clips files may be ignored, deleted by the user, or
cleaned by offline tooling. The Shell extension should not migrate them inside
`gnome-shell`.
