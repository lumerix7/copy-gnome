# 04 - Storage

## Direction: daily inline JSONL history snapshots, no blobs

Target storage should be simple and Shell-safe:

- No `manifest.json`.
- No separate snapshot files.
- No blob directory.
- No fixed current/index file that gets rewritten.
- No moving/copying old clip files during normal startup.
- No filesystem lock in v1; the Shell extension is the only normal writer.
- One daily clips file stores append-only JSON lines.
- Each line is one complete, sorted history snapshot.
- Text/HTML are inline strings.
- File copies are stored only as URI/path references, never inline file bytes.
- Non-file image/binary payloads may be inline base64, with strict size caps.
- Normal writes are append-only, async, and best-effort; losing the newest few records is
  acceptable.

Current code uses this append-only clips JSONL layout.


## Layout

```
$COPY_GNOME_HOME/data/
  clips-20260628.jsonl
  clips-20260629.jsonl
  tmp/
```

If the `/opt/copy-gnome/$USER` default is not writable and no explicit
`COPY_GNOME_HOME` is set, the fallback data directory is
`$XDG_DATA_HOME/copy-gnome/` directly.

Use daily files by default. That keeps individual append-only files bounded without suffix
rollover logic.


## Snapshot Line

`clips-YYYYMMDD.jsonl` is append-only. Each line is one full history snapshot:

```json
{"type":"history","version":1,"writtenAt":1782610200000000,"items":[{"id":"6b6e...uuid","kind":"text","mime":"text/plain;charset=utf-8","encoding":"utf8","text":"hello","data":null,"uri":null,"bytes":5,"preview":"hello","createdAt":1782610000000000,"usedAt":1782610100000000}]}
```

Binary/image example:

```json
{"type":"history","version":1,"writtenAt":1782610200000000,"items":[{"id":"a12b...uuid","kind":"image","mime":"image/png","encoding":"base64","text":null,"data":"iVBORw0KGgo...","uri":null,"bytes":12345,"preview":"image/png 12345 bytes","createdAt":1782610000000000,"usedAt":1782610000000000}]}
```

Rules:

- `id` is the stable record identity for UI/CLI actions (a uuid). There is no content
  hash field; the self-write guard matches the clipboard content directly.
- A line is valid only if it parses as JSON, matches schema, and stays under configured
  size caps.
- Invalid or truncated final lines make normal startup begin with empty history.
- Normal startup reads a bounded tail and loads only the newest non-empty snapshot line.
- Do not scan or replay the whole file during Shell startup.
- If the current day has no clips file, normal startup may read the newest older
  `clips-*.jsonl` tail into memory, but it must not copy that data forward. Future appends
  go only to the current day file.
- If loading any candidate file fails, do not repair or move files; start with empty
  history and append future clips to the current day file.

Why this shape:

- No cross-file consistency problem.
- No blob allocation or blob GC.
- No operation replay for item updates.
- No move/copy/rename of old data on the normal path.
- Append-only writes are simple; a torn write loses only the last line.
- A corrupted final line is acceptable; startup begins empty and it can be repaired later.
- Memory is the source of truth during the session.


## In-Memory Model

The running extension keeps the actual history in memory:

- `history.maxItems` caps visible history.
- Only the latest unsaved full-history snapshot is kept pending; a newer snapshot
  supersedes older unsaved ones.
- Search and popup operate only from memory.

Persisted JSONL is an append-only sequence of full-history snapshots. The latest non-empty
line is the only durable history view after restart; if it is invalid, startup begins empty.


## Startup

1. Pick the current daily clips file by name, e.g. `clips-20260628.jsonl`.
2. If it does not exist, find the newest older `clips-*.jsonl`.
3. Read only enough tail bytes to contain one internal maximum snapshot line.
4. Parse the newest non-empty line only.
5. Sort by effective recency, newest first.
6. Start with empty history if the file is missing, unreadable, or the newest line is invalid.
7. Never move, copy, rewrite, or truncate old clip files during startup.
8. Opening/creating the current day file is allowed only so future writes can append.
9. Do not repair a bad final line during startup.


## Day Switching

Day switching is just filename selection for future appends:

- Each history change appends a full snapshot to the current day's file.
- When the wall clock moves into a new day, new snapshots naturally target
  `clips-YYYYMMDD.jsonl` for the new day.
- No old file is moved, copied, truncated, or rewritten during the switch.
- There is no size-based suffix rollover in v1. If a daily file grows too large, `doctor`
  can report it; the Shell extension still only appends.


## Payload Storage

Text and HTML:

- Store inline as `text` with `encoding:"utf8"`.
- Enforce `storage.textMaxBytes`.
- Skip oversized text with a warning.

Files:

- Store `uri` / `text/uri-list` references.
- Never inline file bytes.
- This includes image files and every other copied disk file, regardless of size.
- A copied `image.png` file is a file reference, not an image payload.
- File size does not matter: 1 KiB and 10 GiB files are both stored as paths only.
- Optionally record file metadata such as size/mtime for stale-file warnings.

Images and binary:

- This section only applies to non-file clipboard payloads, such as screenshot bitmap bytes
  or application-provided image data.
- Store inline as base64 in `data` with `encoding:"base64"`.
- Enforce `storage.binaryMaxBytes` on raw bytes before base64, default 16 KiB.
- Skip oversized binary/image payloads with a warning.
- Image/binary capture is risky inside GNOME Shell; keep strict caps and disable it in
  config if instability returns.

Base64 tradeoff:

- Base64 is larger than raw bytes, but avoids blob files, blob cleanup, and multi-file
  consistency.
- This is acceptable only with strict size caps.


## Write Path

Hot path:

1. Capture clipboard.
2. Convert content into one self-contained in-memory record.
3. If conversion or size validation fails, skip the record and warn.
4. Update in-memory history.
5. Replace the pending serialized JSON line with the latest full-history snapshot.
6. Leave it pending; the periodic timer appends it once per `storage.flushIntervalSec`.

Flush policy:

- The latest pending snapshot is appended **once per `storage.flushIntervalSec`** (default
  60s) by a periodic timer. There is no per-mutation debounce: copies only overwrite the
  pending snapshot in memory, so each daily jsonl is written at most once per interval.
- Periodic flush is append-only. It must not modify existing bytes, rewrite prior lines,
  move files, or compact old data.
- On `disable()`, only do a tiny best-effort final append. If pending data is too large,
  the store is busy, or IO is degraded, skip final append rather than blocking Shell
  teardown.
- Never compact or scan old files from `disable()`.
- If an append fails, warn and drop that pending batch. Do not retry forever from
  `gnome-shell`; future captures may append again if the store becomes writable.

This means the newest pending snapshot may be lost on a hard crash or power loss (logout /
`disable()` does a best-effort final flush). That is acceptable for this design.


## Actions and Durability

For v1, persisted storage is state-oriented:

- New copy: append a full sorted history snapshot.
- Re-copy or restore: append a full sorted history snapshot with updated `usedAt`.
- Delete/clear/edit append a full sorted history snapshot.

This avoids turning the store back into an operation log.


## Writer Ownership

This extension should have only one normal writer: the running `gnome-shell` process.

Rules:

- No filesystem lock is needed in v1.
- Use an in-process append queue/mutex to serialize flushes inside the extension.
- CLI and `doctor` are read-only by default.
- A future CLI write should go through the extension service instead of writing files
  directly.
- The Shell writer may delete whole expired daily files by retention policy
  (`history.maxAgeDays` sweep) without a lock, since it is the sole writer. Any other
  repair/cleanup that rewrites or truncates file contents must require the extension to be
  disabled, or coordinate through an explicit service command.

If a future direct multi-process writer is added, introduce a bounded `/tmp` runtime lock
then. Do not add that complexity to the v1 Shell writer.


## Cleanup

There is no blob GC because there are no blobs.

Expired-file retention runs on the normal Shell path as a bounded, fail-closed periodic
sweep (see `store.sweepOldFiles`, wired in `extension.js`):

- `history.maxAgeDays` (default 3, 0 = disabled): delete whole daily `clips-*.jsonl` files
  whose filename date is strictly older than N days.
- `history.cleanupIntervalSec` (default 86400, range 15..864000): sweep interval.
- The sweep starts only after `store.open()` + history load; it never runs from
  `disable()`/teardown. Memory is the session source of truth, so deleting even the
  just-loaded old file is safe - the next copy re-homes the full snapshot to today's file.
- It deletes whole files by filename date only. It never parses, rewrites, truncates,
  compacts, or renames file *contents*, and never touches the in-memory history model.
- Each delete logs `info`; per-file failures log `warn`; a sweep-level throw logs `error`.

Out of scope for the runtime sweep (still belongs in `doctor cleanup`/repair):

- Inspecting oversized clips files and reporting them.
- Truncating a clips file to remove a corrupted final line, but only after validating the
  byte offset of the last complete JSONL line.
- That repair work must require the extension to be disabled or coordinate through the
  extension service, and must not run during Shell teardown.

Normal storage code:

- Appends only; creates a new daily file only when needed for future appends.
- Deletes whole expired daily files only via the bounded retention sweep above.
- Never rewrites, truncates, compacts, or renames file contents.
- Never truncates a bad final line; that is `doctor repair` work.
- Never runs the sweep or scans old files during Shell teardown.

After `doctor repair` changes a clips file, it can ask the running extension to reload
history through the extension service, or tell the user to disable/enable the extension.
The Shell extension itself should not watch old clips files and live-repair them.


## Hard Caps

- `storage.textMaxBytes`: text/HTML raw bytes, default around 64 KiB.
- `storage.binaryMaxBytes`: non-file image/binary raw bytes before base64, default
  16 KiB.
- Snapshot lines have an internal 64 MiB hard cap. If a snapshot would exceed it, oldest
  entries are trimmed until it fits; actual retained count may be lower than `maxItems`.
- `history.maxItems`: visible in-memory history cap, default 30, max 100.
- `history.maxItemBytes`: per-item cap, default 4 MiB, max 16 MiB.


## What Not To Do

- Do not create blobs for v1.
- Do not persist file bytes, even for small files or image files.
- Do not write on every key event; append at most once per `storage.flushIntervalSec`.
- Do not rewrite a fixed current/index file.
- Do not move/copy old clip files on the normal path.
- Do not compact, rename, or truncate clips files, or rewrite old clip files, from the Shell
  extension. (Exception: the bounded retention sweep may delete whole expired daily files by
  filename date - see Cleanup. It never touches file contents.)
- Do not repair bad final lines from the Shell extension; ignore them and leave repair to
  `doctor repair`.
- Do not scan the whole clips file on Shell startup.
- Do not block `gnome-shell` teardown for persistence.
- Do not add a filesystem lock for the single Shell writer.
- Do not keep `GLib.Bytes` or other GI/native objects across async boundaries.


## Old Layout Cleanup

Older experimental builds wrote `manifest.json`, `snapshots/`, `oplogs/`, sharded
`blobs/`, and later `share/copy-gnome/`. The current Shell extension does not migrate or
delete those paths. Clean them manually after confirming they are no longer needed, or add
that to a future offline `doctor cleanup` command.
