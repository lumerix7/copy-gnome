# copy-gnome

## GNOME Shell safety

- Validate inputs, catch recoverable errors, and fail closed: clipboard features may skip
  work or stop, but must not crash or hang `gnome-shell`.
- A bounded periodic sweep deletes expired daily `clips-*.jsonl` files older than
  `history.maxAgeDays` (default 3). It runs only after history load and never from
  `disable()`; it deletes whole files by date and never rewrites contents. Details in
  [docs/04-storage.md](docs/04-storage.md#cleanup).


## Tips

- When a durable architecture rule, lifecycle rule, or module boundary changes, update this
  file briefly and put details in the relevant docs.
