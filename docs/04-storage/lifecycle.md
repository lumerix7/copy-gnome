# Storage Lifecycle

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
6. Start with empty history if the file is missing, unreadable, not schema `version:1`, or
   the newest line is invalid.
7. Never move, copy, rewrite, or truncate old clip files during startup.
8. Opening/creating the current day file is allowed only so future writes can append.
9. Do not repair or migrate old schema lines during startup.


## Day Switching

Day switching is just filename selection for future appends:

- Each flush appends a full snapshot to the current day's file.
- When the wall clock moves into a new day, new snapshots naturally target
  `clips-YYYYMMDD.jsonl` for the new day.
- No old file is moved, copied, truncated, or rewritten during the switch.
- There is no size-based suffix rollover. If a daily file grows too large, `doctor`
  can report it; the Shell extension still only appends.


## Write Path

Hot path:

1. Capture clipboard.
2. Convert content into one self-contained in-memory record.
3. If conversion or size validation fails, skip the record and warn.
4. Update in-memory history.
5. Replace the pending serialized JSON line with the latest full-history snapshot.
6. Leave it pending; the periodic timer appends it once per `storage.flushIntervalSec`.

Flush policy:

- The latest pending snapshot is appended once per `storage.flushIntervalSec` (default
  3600s) by a periodic timer. There is no per-mutation debounce: copies only overwrite the
  pending snapshot in memory, so each daily JSONL is written at most once per interval.
- Periodic flush is append-only. It must not modify existing bytes, rewrite prior lines,
  move files, or compact old data.
- On `disable()`, only do a tiny best-effort final append. If pending data is too large,
  the store is busy, or IO is degraded, skip final append rather than blocking Shell
  teardown.
- Never compact or scan old files from `disable()`.
- If an append fails, warn and drop that pending batch. Do not retry forever from
  `gnome-shell`; future captures may append again if the store becomes writable.

This means the newest pending snapshot may be lost on a hard crash or power loss. Logout /
`disable()` does a best-effort final flush. That is acceptable for this design.


## Actions And Durability

Persisted storage is state-oriented:

- New copy: append a full sorted history snapshot.
- Re-copy or restore: append a full sorted history snapshot with updated `usedAt`.
- Delete/clear/edit append a full sorted history snapshot.

This avoids turning the store back into an operation log.


## Writer Ownership

This extension should have only one normal writer: the running `gnome-shell` process.

Rules:

- No filesystem lock is needed for the single Shell writer.
- Use an in-process append queue/mutex to serialize flushes inside the extension.
- CLI and `doctor` are read-only by default.
- A future CLI write should go through the extension service instead of writing files
  directly.
- The Shell writer may delete whole expired daily files by retention policy
  (`history.maxAgeDays` sweep) without a lock, since it is the sole writer.
- Any other repair/cleanup that rewrites or truncates file contents must require the
  extension to be disabled, or coordinate through an explicit service command.

If a future direct multi-process writer is added, introduce a bounded `/tmp` runtime lock
then. Do not add that complexity to the current Shell writer.
