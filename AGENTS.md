# copy-gnome

## GNOME Shell safety

- Validate inputs, catch recoverable errors, and fail closed: clipboard features may skip
  work or stop, but must not crash or hang `gnome-shell`.


## Tips

- Read `WARNING.md` when touching Shell lifecycle, clipboard capture, popup focus/grabs,
  GNOME version support, or recovery behavior.
- When a durable architecture rule, lifecycle rule, or module boundary changes, update this
  file briefly and put details in the relevant docs.
