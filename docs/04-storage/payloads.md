# Payload Storage

`payloads` is the only place where actual clipboard payload values live. Top-level record
fields are metadata only.

## Payload Entry Shape

Every entry in `record.payloads` has this shape:

| Field | Required | Type | Allowed / Meaning |
|-------|----------|------|-------------------|
| `mime` | yes | string | MIME name for this representation, for example `text/plain;charset=utf-8`, `text/html`, `text/rtf`, `text/uri-list`, or `image/png`. |
| `encoding` | yes | string | One of `utf8`, `uri-list`, or `base64`. |
| `value` | yes | string | Stored payload. For `utf8` and `uri-list`, this is the decoded text value. For `base64`, this is base64 text. |
| `bytes` | yes | number | Raw payload byte count before JSON escaping. For `base64`, count raw bytes before base64 expansion. |

Record-level `mime` must match `payloads[0].mime`. Record-level `bytes` is the sum of
stored payload raw byte counts.

## Kind Payload Matrix

| `kind` | Required payloads | Optional payloads | Primary payload | Restore default |
|--------|-------------------|-------------------|-----------------|-----------------|
| `text` | one plain text payload | none currently | `text/plain;charset=utf-8` preferred; `text/plain` accepted | write plain text |
| `rich` | one primary rich text payload plus one plain fallback | rich companion text formats | first rich MIME payload | target policy chooses rich or plain |
| `file` | one `text/uri-list` payload | none currently | `text/uri-list` | file targets get file MIME; other targets get path text |
| `image` | one image MIME payload | none currently | image MIME, currently `image/png` capture only | decode base64 and write image MIME |
| `binary` | one binary MIME payload | none currently | captured binary MIME | decode base64 and write primary MIME |

Do not add top-level `text`, `data`, `uri`, or `encoding`.

## Text

| Payload index | MIME | Encoding | Value |
|---------------|------|----------|-------|
| `0` | `text/plain;charset=utf-8` preferred; `text/plain` accepted | `utf8` | copied text |

- Enforce `storage.textMaxBytes`.
- Skip oversized text with a warning.


## Files

| Payload index | MIME | Encoding | Value |
|---------------|------|----------|-------|
| `0` | `text/uri-list` | `uri-list` | newline-joined file URIs |

- Never inline file bytes.
- This includes image files and every other copied disk file, regardless of size.
- A copied `image.png` file is a file reference, not an image payload.
- File size does not matter: 1 KiB and 10 GiB files are both stored as paths only.
- Optional file metadata such as size/mtime may be added later for stale-file warnings.


## Images And Binary

This section applies only to non-file clipboard payloads, such as screenshot bitmap bytes
or application-provided image data.

| Payload index | MIME | Encoding | Value |
|---------------|------|----------|-------|
| `0` | image/binary MIME; currently image capture only accepts `image/png` | `base64` | base64 of raw bytes |

- Enforce `storage.binaryMaxBytes` on raw bytes before base64, default 1 MiB.
- Skip oversized binary/image payloads with a warning.
- Image/binary capture is risky inside GNOME Shell; keep strict caps and disable it in
  config if instability returns.

Base64 is larger than raw bytes, but avoids blob files, blob cleanup, and multi-file
consistency. This is acceptable only with strict size caps.


## Rich Text

Rich text uses the same `payloads` model: the primary rich MIME (`text/html`, `text/rtf`,
`text/richtext`, or `text/markdown`) is `payloads[0]`, and
`text/plain;charset=utf-8` is the fallback/search payload. Do not store the plain fallback
twice, and do not overload top-level `data` with rich text. Office-like companion text
formats may be stored as additional payloads when they fit the combined text cap. See
[13-rich-text](../13-rich-text/README.md) for capture and paste policy.

| Payload index | MIME | Required | Encoding | Value / Role |
|---------------|------|----------|----------|--------------|
| `0` | first offered rich MIME in priority order: `text/html`, `text/rtf`, `text/richtext`, `text/markdown` | yes | `utf8` | primary rich representation used by rich restore |
| `1` | `text/plain;charset=utf-8` | yes | `utf8` | plain fallback, preview source, search text, plain restore |
| `2+` | remaining offered rich companion MIME values from `text/html`, `text/rtf`, `text/richtext`, `text/markdown` | no | `utf8` | preserved companion formats for future multi-MIME restore |

Rich text payload ordering is semantic:

| Order | Rule |
|-------|------|
| Primary rich first | `payloads[0].mime` must equal record-level `mime`. |
| Plain fallback second | The plain fallback should be stored once and should not be duplicated elsewhere. |
| Companions after fallback | Companion rich formats may be preserved after the required fallback if the combined text cap still has room. |

Do not persist Firefox private/context MIME values or OpenOffice internal embed/source XML
by default.


## Runtime Model

The in-memory record should match the persisted target shape:

- `payloads` is the only place where payload values live.
- Top-level `preview` is derived, not a full duplicate payload.
- Search should read the best plain-text payload from `payloads`, falling back to `preview`.
- Restore should choose payloads by MIME/encoding.
- Old single-payload JSONL records are not a compatibility target. After implementing this
  design, old data can be discarded or cleaned by offline tooling.
