# Cleanup And Limits

## Cleanup

There is no blob GC because there are no blobs.

Expired-file retention runs on the normal Shell path as a bounded, fail-closed periodic
sweep (see `store.sweepOldFiles`, wired in `extension.js`):

- `history.maxAgeDays` (default 3, 0 = disabled): delete whole daily `clips-*.jsonl` files
  whose filename date is strictly older than N days.
- `history.cleanupIntervalSec` (default 86400, range 15..864000): sweep interval.
- The sweep starts only after `store.open()` + history load; it never runs from
  `disable()`/teardown. Memory is the session source of truth, so deleting even the
  just-loaded old file is safe; the next copy re-homes the full snapshot to today's file.
- It deletes whole files by filename date only. It never parses, rewrites, truncates,
  compacts, or renames file contents, and never touches the in-memory history model.
- Each delete logs `info`; per-file failures log `warn`; a sweep-level throw logs `error`.

Out of scope for the runtime sweep:

- Inspecting oversized clips files and reporting them.
- Truncating a clips file to remove a corrupted final line.
- Any repair work that rewrites file contents. This belongs in `doctor repair` or another
  offline command and must require the extension to be disabled or coordinate through the
  extension service.

After `doctor repair` changes a clips file, it can ask the running extension to reload
history through the extension service, or tell the user to disable/enable the extension.
The Shell extension itself should not watch old clips files and live-repair them.


## Hard Caps

- `storage.textMaxBytes`: text/HTML raw bytes, default 1 MiB, max 15 MiB.
- `storage.binaryMaxBytes`: non-file image/binary raw bytes before base64, default
  1 MiB, max 10 MiB.
- Effective per-kind retention is also bounded by `history.maxItemBytes`; use
  `min(storage.textMaxBytes, history.maxItemBytes)` for text/rich text and
  `min(storage.binaryMaxBytes, history.maxItemBytes)` for image/binary.
- Snapshot lines have an internal 64 MiB hard cap. If a snapshot would exceed it, oldest
  entries are trimmed until it fits; actual retained count may be lower than `maxItems`.
- `history.maxItems`: visible in-memory history cap, default 200, max 1000.
- `history.maxItemBytes`: per-item cap, default 4 MiB, max 16 MiB.

For rich text, count every stored representation against the record's effective cap.
For example, `text/html` plus `text/plain;charset=utf-8` must fit together.


## What Not To Do

- Do not create blobs for the current JSONL schema.
- Do not persist file bytes, even for small files or image files.
- Do not write on every key event; append at most once per `storage.flushIntervalSec`, except
  for explicit popup-local manual save (`Ctrl+S`).
- Do not rewrite a fixed current/index file.
- Do not move/copy old clip files on the normal path.
- Do not compact, rename, truncate, or rewrite old clip-file contents from the Shell
  extension. Exception: the bounded retention sweep may delete whole expired daily files by
  filename date. It never touches file contents.
- Do not repair bad final lines from the Shell extension; ignore them and leave repair to
  `doctor repair`.
- Do not scan the whole clips file on Shell startup.
- Do not block `gnome-shell` teardown for persistence.
- Do not add a filesystem lock for the single Shell writer.
- Do not keep `GLib.Bytes` or other GI/native objects across async boundaries.


## Old Layout Cleanup

Older experimental builds wrote `manifest.json`, `snapshots/`, `oplogs`, sharded `blobs/`,
and later `share/copy-gnome/`. The current Shell extension does not migrate or delete those
paths. Clean them manually after confirming they are no longer needed, or add that to a
future offline `doctor cleanup` command.

The same rule applies to old v1 `clips-*.jsonl` records that used top-level `text`,
`data`, or `uri`: they are not a runtime compatibility target for the payloads schema.
Clean or archive them offline; do not migrate them from inside `gnome-shell`.
