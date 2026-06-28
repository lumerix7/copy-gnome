# File copy design

GNOME 50 uses a deliberately simple file model: a file copy is one normal history record,
and paste/restore decides which clipboard MIME to write.


## Capture

File capture is not a special twin flow.

1. If the source advertises `text/uri-list` or `x-special/gnome-copied-files`, read only the
   file URI list from that same queued source.
2. Normalize it into newline-separated URI entries.
3. Add exactly one `kind=file` history record:

```json
{
  "kind": "file",
  "mime": "text/uri-list",
  "encoding": "uri",
  "text": null,
  "data": null,
  "uri": "file:///home/user/a.txt",
  "bytes": 23
}
```

No `text/plain` path twin is captured, synthesized, promoted, or linked. File bytes are
never read.


## Restore

Restore writes exactly one clipboard MIME for a file record:

- if the focused/target window `wm_class` matches `ui.fileApps`, write `text/uri-list`
- otherwise, decode the URI list to path text and write `text/plain`

`ui.fileApps` defaults to `["org.gnome.Nautilus"]`, so Nautilus receives `text/uri-list`;
other apps receive path text unless the user opts them into file-target behavior.


## Memory sources

`Meta.SelectionSourceMemory` is not trusted as a file path twin. It may be a Shell write,
restore echo, screenshot, empty selection, or stale compositor-owned content. The optional
`general.denyAllMemorySources` flag filters memory sources at enqueue time. Only MIME
types matching `general.allowMemoryMimes` (exact MIME or simple `type/*` wildcard, default
`image/*`) are kept in the queued job; if none match, the memory source is skipped.
Non-memory sources are not filtered by this option.
