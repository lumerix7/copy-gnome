# 02 - Architecture

## Module layout (single shared source → see [09](09-multi-version.md))

```
src/
  extension.js        # entry: enable()/disable(); wires everything together
  prefs.js            # Adw/Gtk4 preferences window (optional GUI)
  metadata.json       # stamped per shell-version at build time
  stylesheet.css

  core/
    monitor.js        # MetaSelection watcher → emits "capture" events
    clipboard.js      # St.Clipboard / Meta selection read+write helpers, mime logic
    history.js        # in-memory MRU model, dedup, eviction (the source of truth)
    store/
      index.js        # Storage interface + factory (picks backend from config)
      json-store.js   # daily append-only full-history snapshot JSONL
      gda-store.js    # optional backend: SQLite via libgda (only if typelib present)
    config.js         # load/merge/validate YAML|JSON config, file-watch reload
    paths.js          # resolve COPY_GNOME_HOME / XDG dirs
    hash.js           # GLib.compute_checksum_for_bytes wrapper (sha256)
    paste.js          # Clutter virtual-device paste injection
    log.js            # leveled logging

  ui/
    indicator.js      # top-panel button + menu
    popup.js          # caret/window-anchored modal list (the main UX)
    listItem.js       # row widget (preview, actions)
    search.js         # filter/scoring

  vendor/
    yaml.js           # vendored minimal pure-JS YAML loader (no GI yaml typelib exists)
```


## Component responsibilities & data flow

```
                    owner-changed
 MetaSelection ───────────────────▶ monitor.js
                                        │ read async (clipboard.js)
                                        ▼
                                   capture event ({mimes, bytes|uri, source app})
                                        │  privacy filter, dedup
                                        ▼
                                   history.js  (in-memory MRU, source of truth)
                                    │            │
                          mark dirty│            │ sorted index
                                    ▼            ▼
                              store backend   ui/popup, ui/indicator
                            (async, debounced)
```

- **`history.js` is the single source of truth.** UI renders from it; the store is a
  durable mirror, written asynchronously. On `enable()` the store is loaded back into
  `history.js`.
- **All disk IO is async** (`Gio` async APIs / `GLib` idle) so the compositor never
  blocks. A blocking write in `gnome-shell` freezes the whole desktop - this is a hard
  rule.


## Lifecycle

`enable()`:
1. `paths.resolve()` → ensure `COPY_GNOME_HOME` subdirs exist (async).
2. `config.load()` → merged config object; start file-watch.
3. `store.open()` → load index into `history.js`.
4. `monitor.start()` → connect `MetaSelection::owner-changed`.
5. register keybindings (see [08](08-keybindings.md)), build `indicator`.

`disable()` (must be synchronous-ish and complete fast):
1. disconnect monitor + keybindings, destroy UI.
2. run a tiny best-effort store flush only; skip it if the write would be large, busy, or
   degraded.
3. drop all references; null out timeouts/sources (avoid leaks - Shell reuses the JS
   context across enable/disable on lock screen).

> Note: extensions are **disabled on the lock screen** and re-enabled on unlock. Treat
> `disable()`/`enable()` as frequent, not just at logout. Flush on every `disable()`.


## Event/timer hygiene

- Every `GLib.timeout_add` / signal connection is tracked and removed in `disable()`.
- The periodic-flush timer is a single `GLib.timeout_add_seconds` re-armed each tick.
- Use `GLib.SOURCE_REMOVE`/`GLib.SOURCE_CONTINUE` return values explicitly.
