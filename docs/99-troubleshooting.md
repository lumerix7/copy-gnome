# 99 - Troubleshooting

## `Window manager warning: Overwriting existing binding...`

Example:

```text
Window manager warning: Overwriting existing binding of keysym 31 with keysym 31
Window manager warning: Overwriting existing binding of keysym 39 with keysym 39
```

This is not currently a copy-gnome keybinding.

copy-gnome registers only one global Shell keybinding:

```text
toggle-popup = ["<Super>v"]
```

The popup's number selection (`1`, `11`, `0` for row 10, etc.) is handled inside the
already-open modal popup by `ui/popup.js`; it is not registered with `Main.wm.addKeybinding`
and does not reserve global `Super+1..9` or workspace switching shortcuts.

The `keysym 31..39` values are XKB keysyms for number keys `1..9`. On Ubuntu GNOME these
warnings usually come from Ubuntu Dock / Dash-to-Dock registering or re-registering its
Super-number app hotkeys:

```text
org.gnome.shell.extensions.dash-to-dock hot-keys true
app-hotkey-1..10
app-shift-hotkey-1..10
app-ctrl-hotkey-1..10
```

GNOME Shell's warning line does not print modifiers, so it can look like a plain number-key
conflict even when the actual shortcut includes `Super`, `Shift`, or `Ctrl`.

Do not add copy-gnome-side "skip same keybinding" logic for this warning unless logs show
`toggle-popup` or `<Super>v` is involved. The practical copy-gnome response is to keep
`copy-gnome logs` focused on copy-gnome lines and real Shell errors, not Dock reload noise.

If you explicitly want to test whether Ubuntu Dock is the source, inspect:

```sh
gsettings list-recursively org.gnome.shell.extensions.dash-to-dock | rg -i 'hot-keys|app-.*hotkey'
```

Disabling Ubuntu Dock Super-number hotkeys is possible but changes desktop behavior:

```sh
gsettings set org.gnome.shell.extensions.dash-to-dock hot-keys false
```

Do not do that automatically from copy-gnome tooling.
