# File twin design

GNOME 50 uses a deliberately simple file model: a file copy is one normal history record,
and paste/restore decides which clipboard MIME to write.


## Capture

File capture is not a special twin flow.

1. If the source advertises `text/uri-list` or `x-special/gnome-copied-files`, read only the
   file URI list from that same queued source. Prefer `x-special/gnome-copied-files` when it
   is present so the first-line action (`copy` / `cut`) can be logged.
2. Normalize it into newline-separated URI entries. Standard `file:///absolute/path` is kept
   as-is; authority-less `file:/absolute/path` file URIs are accepted and stored as
   `file:///absolute/path`.
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
never read. The `x-special/gnome-copied-files` action is logged as
`fileAction=copy|cut|unknown` but is not stored or replayed yet; restore remains a
non-destructive file-reference paste.


## Restore

Restore writes exactly one clipboard MIME for a file record:

- if the focused/target window has a `wm_class`, lower-case it and match by substring
  against lower-cased `ui.fileApps`; matches write `x-special/gnome-copied-files` with
  `copy\n<uri-list>`
- otherwise, decode the URI list to path text and write `text/plain`

`ui.fileApps` defaults to `["org.gnome.nautilus"]`, so Nautilus receives the GNOME file-copy
MIME; other apps receive path text unless the user opts them into file-target behavior.

An explicit mode skips the `ui.fileApps` match: the row menu's `Paste path` always writes
path text, and `copy-gnome use <id> --mode path|file` forces either write.


## Memory path twins

`Meta.SelectionSourceMemory` is not by itself a reason to drop content: desktop file copies
and ordinary text copies can both arrive as memory sources. The file-twin rule is about the
relationship between the current payload and the current `_lastContent` file record, not
about a source-kind allow/deny policy.

Desktop/file-manager copies can emit a stale `text/plain` path from the previous file
before the real file MIME event arrives. That path is not a separate user text copy.
Drop it only when all of these are true:

- current `job.sourceKind == 'memory'`
- current payload type is `text/plain`
- current `_lastContent.type == 'file'` (`_lastContent.value` is the normalized URI-list
  captured/restored from `text/uri-list` or `x-special/gnome-copied-files`)
- current text exactly equals the decoded path text for `_lastContent.value`

Log this as `file-path-twin`. Other memory text remains capturable.
