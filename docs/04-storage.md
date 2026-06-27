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
{"type":"history","version":1,"writtenAt":1782610200000000,"items":[{"id":"01J1EXAMPLE0000000000000000","hash":"f80b...","kind":"text","mime":"text/plain;charset=utf-8","encoding":"utf8","text":"hello","data":null,"uri":null,"bytes":5,"preview":"hello","createdAt":1782610000000000,"usedAt":1782610100000000}]}
```

Binary/image example:

```json
{"type":"history","version":1,"writtenAt":1782610200000000,"items":[{"id":"01J1EXAMPLE0000000000000001","hash":"a12b...","kind":"image","mime":"image/png","encoding":"base64","text":null,"data":"iVBORw0KGgo...","uri":null,"bytes":12345,"preview":"image/png 12345 bytes","createdAt":1782610000000000,"usedAt":1782610000000000}]}
```

Rules:

- `id` is the stable record identity for UI/CLI actions.
- `hash` is the content identity for in-memory dedup and diagnostics.
- A line is valid only if it parses as JSON, matches schema, and stays under configured
  size caps.
- Invalid or truncated final lines are ignored during normal startup.
- Normal startup reads a bounded tail and loads the newest valid snapshot line.
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
- A corrupted final line is acceptable; it is ignored normally and can be repaired later.
- Memory is the source of truth during the session.

## In-Memory Model

The running extension keeps the actual history in memory:

- `history.maxItems` caps visible history.
- `storage.maxLoadedLines` caps how many items from the newest valid snapshot are loaded
  into memory.
- Only the latest unsaved full-history snapshot is kept pending; a newer snapshot
  supersedes older unsaved ones.
- Search and popup operate only from memory.

Persisted JSONL is an append-only sequence of full-history snapshots. The latest valid
snapshot is the durable history view after restart.

## Startup

1. Pick the current daily clips file by name, e.g. `clips-20260628.jsonl`.
2. If it does not exist, find the newest older `clips-*.jsonl`.
3. Read only a bounded tail window.
4. Parse newest-to-oldest until the latest valid full-history snapshot is found or the
   tail budget is exhausted.
5. Dedup in memory by content hash if `history.dedup` is enabled.
6. Sort by effective recency, newest first.
7. Start with empty history if the file is missing, unreadable, or has no valid tail.
8. Never move, copy, rewrite, or truncate old clip files during startup.
9. Opening/creating the current day file is allowed only so future writes can append.
10. Do not repair a bad final line during startup; just ignore it and continue.

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
- Enforce `storage.inlineMaxBytes`.
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
- Enforce `storage.inlineBinaryMaxBytes` on raw bytes before base64, default 16 KiB.
- Skip oversized binary/image payloads with a warning.
- Image/binary capture is risky on GNOME Shell 46; keep strict caps and disable it in
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
6. Schedule an async append.

Flush policy:

- Append the latest pending snapshot asynchronously after debounce, e.g. 500-1500 ms.
- Periodic flush, e.g. every 60 seconds, if a pending snapshot exists.
- Periodic flush is append-only. It must not modify existing bytes, rewrite prior lines,
  move files, or compact old data.
- On `disable()`, only do a tiny best-effort final append. If pending data is too large,
  the store is busy, or IO is degraded, skip final append rather than blocking Shell
  teardown.
- Never compact or scan old files from `disable()`.
- If an append fails, warn and drop that pending batch. Do not retry forever from
  `gnome-shell`; future captures may append again if the store becomes writable.

This means newest pending lines may be lost on crash, logout, lock-screen teardown, disk
full, or Shell restart. That is acceptable for this design.

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
- Any future offline repair/cleanup command that deletes or rewrites files must require
  the extension to be disabled, or must coordinate through an explicit service command.

If a future direct multi-process writer is added, introduce a bounded `/tmp` runtime lock
then. Do not add that complexity to the v1 Shell writer.

## Cleanup

There is no blob GC because there are no blobs.

There is no old-file cleanup on the normal Shell path. Optional cleanup belongs in
`doctor cleanup` or a future standalone tool:

- It may delete old daily clips files after user confirmation or explicit retention
  policy, e.g. keep the newest N days.
- It may inspect oversized clips files and report them.
- It may truncate a clips file to remove a corrupted final line, but only after validating
  the byte offset of the last complete JSONL line.
- It must require the extension to be disabled or coordinate through the extension service.
- It must not run during Shell teardown.

Normal storage code:

- Appends only.
- Creates a new daily file only when needed for future appends.
- Never deletes, compacts, rewrites, or renames existing clips files.
- Never truncates a bad final line; that is `doctor repair` work.
- Never delete, compact, or scan old files during Shell teardown.

After `doctor repair` changes a clips file, it can ask the running extension to reload
history through the extension service, or tell the user to disable/enable the extension.
The Shell extension itself should not watch old clips files and live-repair them.

## Hard Caps

- `storage.inlineMaxBytes`: text/HTML raw bytes, default around 64 KiB.
- `storage.inlineBinaryMaxBytes`: non-file image/binary raw bytes before base64, default
  16 KiB.
- `storage.clipLineMaxBytes`: maximum serialized history snapshot line size.
- `storage.maxLoadedLines`: maximum items loaded from the newest valid snapshot line.
- `history.maxItems`: visible in-memory history cap, default 30, max 100.

## What Not To Do

- Do not create blobs for v1.
- Do not persist file bytes, even for small files or image files.
- Do not write on every key event; debounce appends.
- Do not rewrite a fixed current/index file.
- Do not move/copy old clip files on the normal path.
- Do not delete, compact, rename, or truncate clips files from the Shell extension.
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
