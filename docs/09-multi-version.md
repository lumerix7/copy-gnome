# 09 - Multi-version support (GNOME 46 & 50)

## Recommendation: single source of truth, build per version

The repo currently has empty `copy-gnome-46/` and `copy-gnome-50/` dirs. Maintaining two
full hand-edited copies means every fix is done twice and they drift. Both 46 and 50 are
**post-GNOME-45**, so they share the modern API: ESM `import`, the `Extension`/
`ExtensionPreferences` base classes, `resource:///org/gnome/shell/...` imports. The
differences between 46 and 50 are small and isolatable.

**Design: one `src/` tree + a build script that emits the two packaged dirs.**

```
src/                      # the only place you edit code
scripts/build.sh          # stamps metadata.json shell-version, runs compat transform,
                          # compiles schemas, outputs to copy-gnome-46/ & copy-gnome-50/
copy-gnome-46/            # BUILD OUTPUT (installable extension for Shell 46)
copy-gnome-50/            # BUILD OUTPUT (installable extension for Shell 50)
```

`copy-gnome-46/` and `copy-gnome-50/` become **generated artifacts** (gitignore or
commit them, your call - committing makes "install without building" possible).

## What actually differs between 46 and 50

Keep all version-specific code behind a thin shim so `src/` stays clean:

```
src/compat/
  index.js        # detects Shell version (Config.PACKAGE_VERSION), re-exports shims
  v46.js
  v50.js
```

Likely divergence points to watch (verify against release notes when 50 ships):

- `metadata.json` → `shell-version`: `["46"]` vs `["50"]` (stamped by build).
- Occasional moves/renames of `resource:///` modules between releases.
- Adwaita/GTK widget deprecations in `prefs.js` across versions.
- Any `MetaSelection` / `Clutter` virtual-device signature drift.

If a future GNOME makes a **breaking** change that can't be hidden behind a shim, add
`src/compat/vNN.js` rather than forking the whole tree.

## metadata.json (template, stamped at build)

```json
{
  "uuid": "copy-gnome@clipboard",
  "name": "copy-gnome",
  "description": "Wayland-native clipboard manager",
  "shell-version": ["__SHELL_VERSION__"],
  "settings-schema": "org.gnome.shell.extensions.copy-gnome",
  "version": 1
}
```

> Note: a single artifact could list `"shell-version": ["46","50"]`, but keeping
> separate per-version outputs (as the repo is set up) lets each pin exactly one Shell
> and ship version-specific shims without runtime branching cost. We keep the two output
> dirs and one source tree.
