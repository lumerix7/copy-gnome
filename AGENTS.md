# copy-gnome

## GNOME Shell safety

- Validate inputs, catch recoverable errors, and fail closed: clipboard features may skip
  work or stop, but must not crash or hang `gnome-shell`.
- Clipboard capture must not call `Meta.SelectionSource.read_async()` for payload reads (KeePassXC -> GNOME Shell SIGSEGV);
  use the Shell clipboard wrapper path and skip empty/failed reads instead.
- Clipboard capture reads a payload at most once (`_readSourceBytes` is one wrapper read
  returning JS-owned bytes; the plain-text payload is read once per job and shared between
  the rich fallback and text branches), then validates, drops, or captures from that memory
  copy. Never re-read clipboard data to re-check it; MIME fallback retries are allowed only
  after a failed read. Wrapper reads sample the current clipboard (accepted stability
  tradeoff); stale-owner/epoch consistency is a separate future optimization. Details in
  [docs/03-clipboard/capture-pipeline.md](docs/03-clipboard/capture-pipeline.md).
- A bounded periodic sweep deletes expired daily `clips-*.jsonl` files older than
  `history.maxAgeDays` (default 3). It runs only after history load and never from
  `disable()`; it deletes whole files by date and never rewrites contents. Details in
  [docs/04-storage](docs/04-storage/README.md).
- The DBus control service (`core/ipc.js`, consumed by the CLI history commands) starts
  only at the end of runtime start (after history load) and is unexported in `disable()`.
  IPC handlers never throw into the Shell: the transport wraps every call and errors
  become `{ok:false}` JSON envelopes. Details in [docs/14-ipc](docs/14-ipc/README.md).
- Path resolution must fail closed: prefer `/opt/home/$USER` as a durable alternate home
  only if writable, using `.config/copy-gnome` for config and `.local/state/copy-gnome`
  for history/state; otherwise fall back as a whole to real-home XDG config/state dirs.


## Tips

- When a durable architecture rule, lifecycle rule, or module boundary changes, update this
  file briefly and put details in the relevant docs.
