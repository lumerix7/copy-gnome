# 04 - Storage

copy-gnome stores clipboard history as daily append-only JSONL files. The running
extension keeps history in memory; disk is a periodically-written durable mirror.

## Reading Order

| Doc                                         | Topic                                                            |
|---------------------------------------------|------------------------------------------------------------------|
| [snapshot-line](snapshot-line.md)           | JSONL snapshot schema, item fields, null/omission rules          |
| [payloads](payloads.md)                     | Text, files, images/binary, and rich text storage decisions      |
| [lifecycle](lifecycle.md)                   | Startup, write path, day switching, durability, writer ownership |
| [cleanup-and-limits](cleanup-and-limits.md) | Retention sweep, caps, prohibited runtime work                  |


## Layout

```
/opt/home/$USER/.local/state/copy-gnome/
  clips-20260628.jsonl
  clips-20260629.jsonl
  tmp/
```

If `/opt/home/$USER` is not writable, the fallback state directory is
`$XDG_STATE_HOME/copy-gnome/` (`~/.local/state/copy-gnome/` when unset).

Use daily files by default. That keeps individual append-only files bounded without suffix
rollover logic.


## Core Decisions

- `clips-YYYYMMDD.jsonl` is append-only.
- Each line is one complete sorted history snapshot, not an operation.
- The latest valid snapshot line is the durable history view after restart.
- Runtime search and popup operate only from memory.
- Records require derived `contentBytes` and `contentSha256`; an incomplete snapshot is invalid.
- The Shell extension appends snapshots and may delete whole expired daily files; it never
  rewrites, truncates, compacts, or repairs clip-file contents.
- Current records use a compact single-payload shape. Rich text should move toward a
  `payloads` shape that can store multiple MIME payloads without duplicating top-level
  `text` / `data` / `uri`; see [payloads](payloads.md#rich-text).


## Why This Shape

- No cross-file consistency problem.
- No blob allocation or blob GC in the current storage model.
- No operation replay for item updates.
- No move/copy/rename of old data on the normal path.
- Append-only writes are simple; a torn write loses only the last line.
- A corrupted final line is acceptable; startup begins empty and it can be repaired later.
- Memory is the source of truth during the session.
