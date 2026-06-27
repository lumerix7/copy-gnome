# 08 - Keybindings

## Constraint: Shell keybindings require GSettings

`Main.wm.addKeybinding(name, settings, flags, modes, handler)` reads the accelerator
from a **GSettings key of type `as`** (array of strings). There is no API to register a
global Shell shortcut from a plain string at runtime without a backing schema. So:

- Keybindings are defined in a **compiled GSettings schema** shipped with the extension.
- YAML may *mirror* them for documentation, but GSettings is authoritative.
- The prefs GUI writes the GSettings keys (with a key-capture widget).

## Schema

`schemas/org.gnome.shell.extensions.copy-gnome.gschema.xml`:

```xml
<schema id="org.gnome.shell.extensions.copy-gnome"
        path="/org/gnome/shell/extensions/copy-gnome/">
  <key name="toggle-popup" type="as">
    <default><![CDATA[['<Super>v']]]></default>
    <summary>Open clipboard history popup</summary>
  </key>
  <!-- a few bootstrap keys also live here: backend, enabled (see 05) -->
</schema>
```

Compiled with `glib-compile-schemas schemas/` at build/install time (see [10](10-packaging.md)).

## Registration (in `enable()`)

```js
Main.wm.addKeybinding('toggle-popup', this._settings,
    Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
    () => this._popup.toggle());
```

Remove with `Main.wm.removeKeybinding('toggle-popup')` in `disable()`.

## Conflicts

- `<Super>v` may collide with other extensions / future GNOME defaults. Make it
  user-configurable (it is) and document how to change it. On conflict the binding
  silently fails to register - detect and warn in logs.
