# Storage Lifecycle

## In-Memory Model

The running extension keeps the actual history in memory:

- `history.maxItems` caps visible history.
- Only the latest unsaved full-history snapshot is kept pending; a newer snapshot
  supersedes older unsaved ones.
- Search and popup operate only from memory.

Persisted JSONL is an append-only sequence of full-history snapshots. Startup loads the
newest valid snapshot within its recovery budget. A valid empty snapshot represents a clear.


## Startup

1. Scan today's file backwards from the tail. If no valid snapshot is found, try the newest
   other daily file within the same budget.
2. Check at most 10 lines and read about 128 MiB in total, with a 64 MiB cap per line. Stop
   on the first valid snapshot, including an empty one, and sort by recency.
3. If files exist but recovery is unavailable, use memory-only history for the session.
   Keep the on-disk files for offline repair.
4. Protect a recovered older file from retention until a newer snapshot is saved. If that
   file has already reached `history.maxAgeDays`, attempt to append the recovered snapshot
   to today's file before the first sweep. Only the sweep waits for this append.

Startup and retention use separate cancellable requests with a five-second deadline each.
Directory entries are read in batches of 64, capped at 16,384 entries per request.
Disabling the extension cancels these requests. See
[cleanup-and-limits](cleanup-and-limits.md#cleanup).


## Day Switching

Day switching is just filename selection for future appends, with one startup exception -
step 4 above re-homes a fallback file immediately, without waiting for a flush, once that
file has reached `history.maxAgeDays`:

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
5. Replace the pending batch with the latest full-history snapshot.
6. Leave it pending; the periodic timer appends it once per `storage.flushIntervalSec`.

Flush policy:

- The latest pending snapshot is appended once per `storage.flushIntervalSec` (default
  3600s) by a periodic timer. There is no per-mutation debounce: copies only overwrite the
  pending snapshot in memory, so each daily JSONL is written at most once per interval.
- Periodic flush is append-only. It must not modify existing bytes, rewrite prior lines,
  move files, or compact old data.
- On `disable()`, hand the latest pending snapshot to the background writer if
  persistence is available. Shell teardown returns without waiting for file I/O.
- A write after an incomplete line appends a newline before writing the new snapshot.
- Never compact or scan old files from `disable()`.
- If an append fails, warn and drop that pending batch. Do not retry forever from
  `gnome-shell`; future captures may append again if the store becomes writable.

An unfinished snapshot may be lost if Shell exits during logout, crashes, or loses power.


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
- Each history path has one writer slot shared across extension instances in the same
  Shell. The slot stays occupied until the stream closes. Regular flushes leave the
  latest snapshot pending when busy. A retiring instance can reserve one final batch.
- Startup waits up to two seconds for the writer of the selected history file. If the
  writer remains active, the extension uses memory-only history for that session.
- CLI and `doctor` are read-only by default.
- A future CLI write should go through the extension service instead of writing files
  directly.
- The Shell writer may delete whole expired daily files by retention policy
  (`history.maxAgeDays` sweep) without a lock, since it is the sole writer.
- Any other repair/cleanup that rewrites or truncates file contents must require the
  extension to be disabled, or coordinate through an explicit service command.

If a future direct multi-process writer is added, introduce a bounded `/tmp` runtime lock
then. Do not add that complexity to the current Shell writer.
