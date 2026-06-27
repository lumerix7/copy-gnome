# 10 - Packaging & install (local only, not published)

Not published to extensions.gnome.org - local build + install only.

## UUID

`copy-gnome@clipboard` (the `metadata.json` `uuid`). Install dir:
`~/.local/share/gnome-shell/extensions/copy-gnome@clipboard/`.

## Build (`scripts/build.sh`)

For each target version (46, 50):

1. Copy `src/` → `copy-gnome-<ver>/`.
2. Stamp `metadata.json` `shell-version` = `["<ver>"]` (+ bump `version`).
3. Apply compat selection if needed (see [09](09-multi-version.md)).
4. `glib-compile-schemas copy-gnome-<ver>/schemas/` (validates + compiles).
5. Optionally `gnome-extensions pack` to produce a distributable zip.

`gnome-extensions pack` example:

```sh
gnome-extensions pack copy-gnome-46 \
  --extra-source=core --extra-source=ui --extra-source=vendor \
  --schema=schemas/org.gnome.shell.extensions.copy-gnome.gschema.xml \
  --force -o dist/
```

## Install (`scripts/install.sh`)

Detect the running Shell version and pick the matching dir:

```sh
VER=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)   # e.g. 46
SRC="copy-gnome-${VER}"
DEST="$HOME/.local/share/gnome-shell/extensions/copy-gnome@clipboard"

rm -rf "$DEST"; mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"
glib-compile-schemas "$DEST/schemas/"          # ensure compiled at destination
gnome-extensions enable copy-gnome@clipboard || true
```

Or, from a packed zip: `gnome-extensions install dist/copy-gnome@clipboard.shell-extension.zip --force`.

## First-run data dir (the `/opt/copy-gnome/$USER` default - see [05](05-config.md))

Because the default data base is **`/opt/copy-gnome/$USER`** (deliberately off `$HOME`),
`/opt/copy-gnome` must exist and be user-writable. The install script does the one-time
privileged setup:

```sh
# scripts/setup-home.sh  (run once, needs sudo)
sudo install -d -m 1777 /opt/copy-gnome          # sticky like /tmp: each user owns their subdir
# extension creates /opt/copy-gnome/$USER itself on first enable (0700)
```

- `1777` (sticky) lets every user create their own `$USER` subdir while not touching
  others'. The extension creates `/opt/copy-gnome/$USER` mode `0700` on first run.
- Alternative (single-user box): `sudo install -d -m 0755 -o $USER -g $USER /opt/copy-gnome`.
- Override anytime with `COPY_GNOME_HOME=/somewhere/writable`.
- If `/opt/copy-gnome` is missing/unwritable and no override, the extension logs a clear
  error and falls back to `$XDG_DATA_HOME/copy-gnome` so the desktop never breaks.

## Reload on Wayland (important)

- **You cannot restart `gnome-shell` in place on Wayland.** Alt+F2 `r` is X11-only.
  After install/upgrade you must **log out and back in**.
- For development, use a **nested session** without logging out:
  ```sh
  dbus-run-session -- gnome-shell --nested --wayland
  ```
  then enable the extension inside the nested Shell and watch logs:
  ```sh
  journalctl -f -o cat /usr/bin/gnome-shell
  # or: journalctl --user -f | grep -i copy-gnome
  ```

## Scripts summary (`scripts/`)

| Script | Purpose |
|--------|---------|
| `build.sh` | src → copy-gnome-46/50, stamp, compile schemas, pack |
| `install.sh` | detect version, copy to extensions dir, compile schemas, enable |
| `setup-home.sh` | one-time `sudo` creation of `/opt/copy-gnome` |
| `dev-nested.sh` | launch nested Wayland Shell for testing |
| `uninstall.sh` | disable + remove install dir (leaves data unless `--purge`) |
