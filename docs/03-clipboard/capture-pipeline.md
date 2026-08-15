# Clipboard capture - restore, enqueue, drain

> Target design for the capture pipeline (monitor + extension). Producer/consumer split: the
> `owner-changed` handler (**enqueue side**) checks privacy, copies the job's policy and
> owner metadata, and queues it. The **drain side** handles payloads
> (read content, compare-with-last, drop/capture). Agreed model: single `_lastContent`,
> **no TTL**, drop decided by consecutive content match (same `type` + same `value`),
> no monitor/enqueue history lookup or hash, no enqueue-time marking, no grace window; a
> successful `history.add()` separately uses persisted content identity plus exact verification;
> a uuid `id` is threaded through the whole
> lifecycle. File-copy capture/restore policy is documented separately in
> [file-twin-design](file-twin-design.md). Accepted tradeoffs are listed under
> [Known limitations](#known-limitations).


## Data model

### IDs

- **`id` (uuid)** - assigned by the enqueue side the moment an `owner-changed` is received.
  Globally unique. For a **captured** event it is reused as the history record's `id`
  (passed monitor → extension → `history.add`), so one uuid spans event → record → all logs.
  The unique identity to grep on.
- **`seq` (integer)** - a per-session ordinal for human-readable ordering in logs. Resets to
  1 on every extension restart, so it **repeats across restarts** - never an identity, only a
  within-session reading aid.

Per-job pipeline lines carry `id=<uuid> seq=<n>`. Loop/lifecycle lines (drain start/stop,
`setLastContent`, `restored`, monitor start/stop) carry `id` only or neither.


### `job` (one per owner-changed; built by the enqueue side)

```
job = { id, seq, clipboardVersion, sourceLabel, sourceKind, mimes,
        captureFiles, captureImages, maxItemBytes, maxTextBytes, maxBinaryBytes }
       sourceKind: 'memory' | 'non-memory' | 'unknown'   // memory = Shell-owned (our writes, screenshots, caches)
```

`sourceKind` + `mimes` are snapshotted **synchronously at receive** (the source may go stale
before the drain reaches it). The native `Meta.SelectionSource` object itself is **not**
retained on the job - payload reads go through the Shell clipboard wrapper, never the
source. Content (`value`) is **not** read here - that is async, done on the drain side. No
`staleReplayAfterSeq` - the drop decision needs no lookahead.


### `_lastContent` (single shared state, no TTL)

```
_lastContent = { id, origin, sourceKind, source, type, value }
```

| field        | meaning                                                  | set on restore                   | set on capture         |
| ------------ | -------------------------------------------------------- | -------------------------------- | ---------------------- |
| `id`         | trace uuid                                               | a fresh uuid for this self-write | the producing `job.id` |
| `origin`     | how it was set - splits log reason (echo vs replay)      | `'restore'`                      | `'capture'`            |
| `type`       | content kind: `text` / `file` / `image` - **rule field** | the restored kind                | the captured kind      |
| `value`      | content - **rule field**                                 | the written content              | the captured content   |
| `sourceKind` | memory / non-memory (log only)                           | `'memory'`                       | `job.sourceKind`       |
| `source`     | source label (log only)                                  | `'(self-restore)'`               | `job.sourceLabel`      |

The drop rule reads only **`type` + `value`**. `origin` and the current job's `sourceKind`
split the log reason. `id`/`sourceKind`/`source` are context/logging.

**Why `type` + `value`:** only the immediately previous clipboard payload is compared.
This catches restore echoes, stale memory replays, and Wayland/clipboard-manager owner
re-announces without involving history lookup. `type` guards against a text and a file/image
sharing a string. Accepted tradeoff: consecutive identical user copies collapse to one
visible entry. Non-consecutive exact matches are handled later by `history.add()`.


## Logging levels

Per-job pipeline lines carry `id=<uuid> seq=<n>` so one event can be grepped end to end
(lifecycle/state lines may carry only `id` or neither - see Data model > IDs). Level
convention across all four flows:

- **debug** - every routine step (the normal path). Enqueue: received, job built, pushed.
  Drain: dequeued, source read, compare result, **drop reason** (`echo` / `stale-replay` / `same-last`),
  capture, `setLastContent`. File restore: target app class and selected restore mode.
  Restore: backup/set/touch steps. History: normal index rebuild and visible-popup refresh.
  Also benign skips (concealed selection, empty content).
- **info** - a notch above routine: user-meaningful milestones at default level, e.g.
  `restored id=... kind=... bytes=...`, history loaded (`N entries`), exact older records
  removed (`headId`, `kind`, `bytes`, `removed`). Content and digests are not logged.
- **warn** - recoverable anomalies that skip work but never crash/hang the shell: clipboard
  or source read timeout/failure, oversized item skipped (exceeds payload cap), restore
  write failed/aborted, stale popup record activation, file read skipped, suppressed-repeat
  top mismatch, fingerprint failure, or slow fingerprint/index work.
- **error** - serious but still fail-closed: image capture disabled for the session after
  repeated read failures; config parse failure.


---

## Flow 1 - Restore (write-back)

```mermaid
flowchart TD
    A["1 check recent row-1 restore window"] --> B{"2 skip system clipboard write?"}
    B -- yes --> D["5 history.touch rec - MRU front, async persist"]
    B -- no --> C["3 backup + setLastContent + write system clipboard"]
    C --> W{"4 write ok"}
    W -- yes --> D
    W -- no --> E["setLastContentIfIs backup - rollback"]
    D --> F["6 autoPaste if enabled"]
```

1. Check whether the selected record was row 1 in the sorted history and its `usedAt` is
   inside `ui.skipClipboardWriteForRecentTopSec` (`0` disables).
2. If the recent row-1 shortcut applies, skip only the system clipboard write.
3. Otherwise **backup** the current `_lastContent`, **setLastContent** with
   `origin='restore'`, `type=`restored kind, `value=`written content, fresh `id`,
   `sourceKind='memory'`, `source='(self-restore)'`, then write the real system clipboard
   (`setText` / `setContent`).
4. On **write success** or **write skip**, `history.touch(rec)` - MRU front in memory,
   async persist. We do **not** wait for the echo, so the UI never flickers.
5. On **write failure**, `setLastContentIfIs(backup)` - roll back if `_lastContent` is still
   the restore marker.
6. If `ui.autoPaste`, schedule the paste keystroke.

When a write happened, the echo arrives later as a memory event with the same `type`+`value`
and is dropped on the drain side. Restore itself enqueues nothing.


## Flow 2 - Enqueue (producer; `owner-changed` handler)

```mermaid
flowchart TD
    A["CLIPBOARD owner change"] --> B{"Public offer with validated MIME metadata?"}
    B -- no --> Z["Discard queued and in-flight reads"]
    B -- yes --> C["Copy source metadata, capture flags and byte limits"]
    C --> D["Enqueue, dropping the oldest pending job if full"]
    D --> E["Schedule one read on the main loop"]
```

The signal handler checks the complete MIME list against `privacy.secretMimes` before
admission. Each list is limited to 256 MIME strings of up to 1,024 characters. A clear,
concealed selection, invalid metadata or a changed privacy list retires outstanding
reads and queued jobs. Only JS-owned metadata and scalar configuration enter the queue.

At most 32 jobs wait behind one active read. On overflow the newest jobs keep their FIFO
order. A warning marks saturation and a summary reports how many pending jobs were dropped.


## Flow 3 - Drain (consumer; the only place content is read and decided)

```mermaid
flowchart TD
    A["1 dequeue next job in FIFO order"] --> B["2 classify snapshot MIME types and read through the clipboard wrapper"]
    B --> C{"3 compare last: type==last.type AND value==last.value"}
    C -- "yes and restore, except an external file offer" --> X1["drop - log echo"]
    C -- "yes and sourceKind=memory" --> X2["drop - log stale-replay"]
    C -- "yes otherwise" --> X3["suppress repeat - log same-last"]
    C -- "no" --> D{"file path twin? memory text/plain equals decoded _lastContent file URI-list path"}
    D -- "yes" --> X4["drop - log file-path-twin"]
    D -- "no" --> E{"rich plain twin? memory text/plain equals previous rich plain fallback"}
    E -- "yes" --> X5["drop - log rich-plain-twin"]
    E -- "no" --> G["4 capture → history.add id=job.id → setLastContent type value origin=capture"]
    X1 --> H["5 schedule next idle dispatch"]
    X2 --> H
    X3 --> H
    X4 --> H
    X5 --> H
    G --> H
```

1. Each idle dispatch starts at most one job. The detached reader in `core/capture-reader.js`
   receives the job, its cancellation scope and the current image-degradation flag. Completion
   delivers JS-owned data through the live monitor registration. Stop retires that registration.
2. **Read** content: classify `job.mimes` (uri-list/x-special → file, image/png → image, text/plain → text),
   pick the mime, and read `C` + its `type` through the Shell clipboard wrapper path.
   `Meta.SelectionSource.read_async()` is avoided because it can crash `gnome-shell` on
   transient external owners. Each payload is read **at most once** per job: one wrapper
   read returns a JS-owned copy, and all later size/type/drop decisions run on that copy.
   The plain-text payload is read once per job and shared between the rich branch and its
   text fallback (a rich fallback never issues a second plain read). MIME fallback retries
   (e.g. `x-special/gnome-copied-files` → `text/uri-list`) are allowed only after a
   **failed** read. If the chosen text reads back empty, fall through to the image branch.
3. **Compare with `_lastContent`** - the drop test:
   `type == _last.type` **and** `value == _last.value`.
   `_lastContent` may be seeded from the history head at runtime start so memory twin
   filters can work across a logout/login boundary. A history seed does **not** suppress
   ordinary same-content copies; it is only input for the file/rich twin checks below.
   - A matching external file offer goes through `same-last` even after a restore. When
     its version is current and the history head matches, automatic paste can reuse
     the owner's original cut/copy action. Explicit modes use the new owner as unconfirmed.
   - Other matches with `_last.origin == 'restore'` → **drop**, log `echo`.
   - true and `job.sourceKind == 'memory'` → **drop**, log `stale-replay`.
   - true otherwise → **suppress repeat**, log `same-last` (consecutive same content /
     owner re-announce) and notify extension-side bookkeeping.
   - false → check twin filters, then capture if it is not a twin.
4. **File path twin check:** if `job.sourceKind == 'memory'`, the current payload is
   `text/plain`, `_lastContent.type == 'file'`, and the text exactly equals the decoded path
   text for `_lastContent.value` (the current file URI-list), **drop**, log
   `file-path-twin`. This catches stale memory path twins without blocking unrelated memory
   text copies.
5. **Rich plain twin check:** if `job.sourceKind == 'memory'`, the current payload is
   `text/plain`, `_lastContent.type == 'rich'`, and the text exactly equals the plain
   fallback embedded in `_lastContent.value`, **drop**, log `rich-plain-twin`. This catches
   stale memory plain fallbacks after a rich capture without treating rich events as file
   path twins.
6. **Capture:** `history.add` using `job.id` as the record id. The new record is kept as the
   head; `kind + contentBytes + contentSha256` selects candidates, digest matches
   are verified field-by-field, and exact older matches are removed in one batch before
   capacity eviction. Older history records are not compared with each other; the final
   reference filter is at most O(N), and this in-memory cleanup never writes the system
   clipboard. Then
   `setLastContent({ type, value, origin:'capture', sourceKind:job.sourceKind, source, id:job.id })`.
   For suppressed repeats, extension bookkeeping verifies the current top history record has
   the same kind and payload, then `history.touch(top)` updates `usedAt` and queues the
   normal async snapshot. If top does not match, it warns and skips the touch.
7. Schedule the next job on a fresh idle dispatch. Each compare runs against the state the *previous* processed
   job left, so it is consistent with FIFO order - but note a capture can overwrite a pending
   restore marker (see [Known limitations](#known-limitations)).


### Truth table

| current sourceKind | type+value == last | last.origin | result                                                                          |
| ------------------ | ------------------ | ----------- | ------------------------------------------------------------------------------- |
| any                | no                 | *           | capture if no twin filter matches                                               |
| any                | yes                | history     | capture if no twin filter matches                                               |
| external file      | yes                | restore     | **suppress repeat** (same-last), verify current version and history head        |
| other              | yes                | restore     | **drop** (echo)                                                                 |
| memory             | yes                | capture     | **drop** (stale replay)                                                         |
| non-memory         | yes                | capture     | **drop** (same-last)                                                            |
| memory text/plain  | no                 | *           | **drop** only when `_lastContent.type=file` and text equals decoded file path   |
| memory text/plain  | no                 | *           | **drop** only when `_lastContent.type=rich` and text equals rich plain fallback |

## File copies

File-copy handling is intentionally simple: capture one `kind=file` record from
`text/uri-list`; restore later chooses GNOME's file-copy MIME or decoded path text by
target app.
Keep that policy out of the generic queue/drop model; see
[file-twin-design](file-twin-design.md).


## Known limitations

Accepted tradeoffs of the single-`_lastContent`, content-match model. All are bounded and
fail-closed (a wrong call yields at most a duplicate or a missed drop - never a crash/hang).

- **Self-write marker churn.** `_lastContent` is one shared slot. If a real (non-memory) copy
  is captured *between* a restore's `setLastContent(origin='restore')` and that restore's echo
  reaching the drain, the marker is overwritten and the echo is captured as a **duplicate** of
  the restored entry. Needs a copy to interleave a restore (narrow window); it is the
  deliberate cost of one slot instead of a separate self-write field.
- **Consecutive same content collapses.** Copying the exact same payload twice in a row
  produces one visible entry; the top entry's `usedAt` is refreshed if it still matches the
  dropped payload. This remains a monitor-level stability guard for Wayland owner re-announce
  paths. Separately, a captured non-consecutive repeat becomes the new head and removes only
  older exact matches selected by the content-identity index.
- **Replay of older-than-last content.** Only the most-recent content is remembered, so a
  replay of content *older* than the last capture (`copy aaa → copy bbb → replay aaa`) is not
  recognised and is captured. Rare.
- **Read-before-drop cost.** An echo/replay is fully read (async, bounded by caps + 2 s
  timeout) before being dropped, and `_lastContent.value` holds the last content (for images,
  base64 up to the cap) until the next event - bounded and overwritten, not a leak.
- **Wrapper reads sample current clipboard state.** Payload capture avoids
  `Meta.SelectionSource.read_async()` because that native path can crash `gnome-shell` for
  transient external owners. The queue still uses the owner-change job's MIME metadata, but
  the payload read samples the current Shell clipboard wrapper state. Rapid owner changes can
  therefore produce an empty/skipped read or a stale MIME/content mismatch. This is accepted
  for now because stability beats exactly-once capture. Stale-owner / owner-epoch
  consistency (skip a capture when the owner changed between a job's reads) is a separate
  future optimization; if added, it must stay narrow - no global dequeue skip and no skip
  on the file branch, or file-copy / memory-twin semantics break.
- **Read once, then decide (implemented invariant).** Every payload read is a single wrapper
  call through `capture-reader.js` that returns a JS-owned copy. Size/type/drop/capture decisions
  run on that copy and the clipboard is never re-read to re-check a payload. The plain-text
  payload is read at most once per job and shared between the rich branch and its text
  fallback. Plain text has no wrapper-side cap: it is read into memory first, then
  size-checked on the JS copy (accepted tradeoff). MIME fallback retries are allowed only
  after a failed read - once a read succeeds, decisions never leave the memory copy.
  Re-reading the clipboard can race with a newer owner, produce different data, or cross a
  less stable native boundary again.
- **Screenshot capture rides the image path.** Capturing screenshots / memory images depends
  on `general.captureImages`, which `WARNING.md` flags as the risky GI path (prior `signal 11`
  on Shell 46). Disable it there if the session destabilises.
