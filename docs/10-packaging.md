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
5. `gnome-extensions pack` to produce the installable bundle.

`gnome-extensions pack` example:

```sh
gnome-extensions pack copy-gnome-46 \
  --extra-source=core --extra-source=ui --extra-source=vendor \
  --schema=schemas/org.gnome.shell.extensions.copy-gnome.gschema.xml \
  --force -o dist/
```

## Install (`scripts/install-extension.sh`)

Detect the running Shell version, pick the matching dir, pack it, and install the
bundle with GNOME's standard extension CLI. Use `--gnome 46` or `--gnome 50` to force a
specific committed tree:

```sh
VER=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)   # e.g. 46
SRC="copy-gnome-${VER}"

gnome-extensions pack "$SRC" \
  --extra-source=core \
  --extra-source=ui \
  --extra-source=vendor \
  --schema=schemas/org.gnome.shell.extensions.copy-gnome.gschema.xml \
  --force \
  --out-dir=/tmp/copy-gnome-pack

gnome-extensions install --force \
  /tmp/copy-gnome-pack/copy-gnome@clipboard.shell-extension.zip
```

Then log out and back in on Wayland before enabling:

```sh
gnome-extensions enable copy-gnome@clipboard
```

Or, from a packed zip:

```sh
gnome-extensions install --force dist/copy-gnome@clipboard.shell-extension.zip
```

`core/`, `ui/`, and `vendor/` must be passed as `--extra-source` entries; otherwise
`gnome-extensions pack` only includes the top-level extension files and the installed
bundle is incomplete.

This standard install path is still not a hot-reload path: in current GNOME Shell
sessions it may install files to disk while `gnome-extensions info/enable` still cannot
see the UUID until the next login.

## First-run durable home (`/opt/home/$USER` - see [05](05-config.md))

Because the default config/state root is **`/opt/home/$USER`** (deliberately off real
`$HOME`), that directory must exist and be user-writable. The setup script does the
one-time setup:

```sh
# scripts/setup-home.sh  (run once)
install -d -m 0755 /opt/home
install -d -m 0700 "/opt/home/$USER"
# extension creates .config/copy-gnome and .local/state/copy-gnome itself
```

- `/opt/home` must be writable by the installing user or pre-created by the system owner.
- `/opt/home/$USER` is private per-user state and should be mode `0700`.
- If `/opt/home/$USER` is missing/unwritable, the extension logs a clear warning and falls
  back as a whole to `$XDG_CONFIG_HOME/copy-gnome` and `$XDG_STATE_HOME/copy-gnome`.

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
| `install-extension.sh` | detect or select version, pack with `gnome-extensions`, install bundle; relogin before enable on Wayland |
| `setup-home.sh` | one-time creation of `/opt/home/$USER` |
| `dev-nested.sh` | launch nested Wayland Shell for testing |
| `uninstall.sh` | disable + remove install dir (leaves data unless `--purge`) |
