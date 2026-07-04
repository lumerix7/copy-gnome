# copy-gnome

## GNOME Shell safety

- Validate inputs, catch recoverable errors, and fail closed: clipboard features may skip
  work or stop, but must not crash or hang `gnome-shell`.
- A bounded periodic sweep deletes expired daily `clips-*.jsonl` files older than
  `history.maxAgeDays` (default 3). It runs only after history load and never from
  `disable()`; it deletes whole files by date and never rewrites contents. Details in
  [docs/04-storage.md](docs/04-storage.md#cleanup).
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
