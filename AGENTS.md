# copy-gnome

## GNOME Shell safety

- Treat this extension as running inside the compositor: failures must be fail-closed. A
  clipboard feature may warn, skip an item, or stop working, but it must not leave modal
  grabs, timers, signals, virtual key modifiers, or native/GI objects in a state that can
  crash or hang `gnome-shell`.


## Tips

- Read `WARNING.md` when touching Shell lifecycle, clipboard capture, popup focus/grabs,
  GNOME version support, or recovery behavior.
