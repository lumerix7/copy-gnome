# 09 - Multi-version support (GNOME 46 & 50)

## Two committed parallel trees

The repo ships **two full, installable extension trees**, `copy-gnome-46/` and
`copy-gnome-50/`, maintained in parallel by hand. `install-extension.sh` picks the one
matching the running Shell version (`copy-gnome-$VER`) and packs it directly - there is no
build step, and both trees are committed source. `core/` is kept byte-identical across
both; the only
divergence is `metadata.json` (`shell-version`) and `ui/popup.js` (see below). Both 46 and
50 are **post-GNOME-45**, so they share the modern API: ESM `import`, the `Extension`/
`ExtensionPreferences` base classes, `resource:///org/gnome/shell/...` imports.

Changing shared code means editing both trees. A missed sync is caught mechanically by
`scripts/check-sync.sh`, a repo-level check that is **not** part of the standalone CLI
package: it asserts the two trees differ only on `metadata.json` and `ui/popup.js`. It runs
as part of `./scripts/install-cli.sh`; run it directly to check without installing.

## What actually differs between 46 and 50

The two trees are kept in sync; today only two files diverge:

- `metadata.json` → `shell-version`: `["46"]` vs `["50"]`.
- `ui/popup.js` → GNOME 50 needs two fixes that 46 does not:
  - GNOME 48 deprecated the St widget `vertical` property; 50 uses
    `orientation: Clutter.Orientation.VERTICAL` instead.
  - GNOME 50's `Clutter.grab()` modal routes crossing (enter/leave) events to the grabbed
    backdrop, so descendant `St.Button`s never flip `hover` true and never emit `clicked`.
    50 drives the Clear button and the row buttons off `button-press-event` instead.
- `core/` is byte-identical across both; `prefs.js`, `ui/indicator.js`,
  `stylesheet.css`, `schemas/`, and `vendor/` are currently identical too.

Other points to watch if a future GNOME diverges further (verify against release notes):

- Moves/renames of `resource:///` modules between releases.
- Adwaita/GTK widget deprecations in `prefs.js` across versions.
- `MetaSelection` / `Clutter` virtual-device signature drift.

Today the two trees just carry the version-specific lines inline. If a future GNOME makes a
**breaking** change too large for inline differences, that is the point to reconsider a
`src/compat/` shim (and the single-source build it implies) rather than forking the tree
further.

## Why not a single source + build script

A single `src/` tree with a `scripts/build.sh` that emits both dirs would let each fix be
made once. It is deliberately **not** done here:

- The version-specific bits in `popup.js` are real branched code (a property rename plus a
  different input signal), not a value to stamp. A build would need a `src/compat/` shim
  with runtime version detection, adding its own bug surface.
- GNOME extensions have no standard build tooling; a hand-rolled build is net-new
  maintenance for a small project.
- `install-extension.sh` consumes the committed trees directly. A build would either force a build
  step before every install, or sit on top of committed outputs as a release-only ritual.

Two committed trees plus the drift check above get the safety at a fraction of the cost.
Revisit only if a **third** Shell version lands (three-way sync gets tedious) or the
version-specific surface grows too large to keep inline.

## metadata.json

```json
{
  "uuid": "copy-gnome@clipboard",
  "name": "Copy GNOME",
  "description": "Wayland-native clipboard manager",
  "shell-version": ["__SHELL_VERSION__"],
  "settings-schema": "org.gnome.shell.extensions.copy-gnome",
  "version": 1
}
```

The only field that differs between the two trees is `shell-version` (`["46"]` vs `["50"]`).

> Note: a single artifact could list `"shell-version": ["46","50"]`, but keeping separate
> per-version outputs lets each pin exactly one Shell and ship version-specific fixes
> without runtime branching cost. We keep the two output dirs, hand-maintained.
