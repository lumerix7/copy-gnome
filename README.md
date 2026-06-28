# copy-gnome

A Wayland-native clipboard manager for GNOME Shell - history, search, instant restore -
inspired by CopyQ but implemented as a Shell extension so it works on Wayland (where
standalone clipboard managers can't monitor the clipboard).

> Status: **M1 + popup**, GNOME Shell **46/50** local builds.


## Features (current)

- Clipboard monitoring via Mutter's `MetaSelection` (no polling) - text, copied-file
  URI references, and screenshot/image payloads are enabled by default.
- MRU history: re-using an entry floats it to the top; every copy is kept as its own
  entry.
- Centered, searchable popup (default **Super+V**):
  - first row pre-selected → `Enter` pastes the latest entry,
  - number keys paste rows by number, e.g. **1**, **11**; standalone **0** means row 10,
  - `/` focuses search; `Esc` cancels search first, then closes,
  - `↑/↓` or `j/k` moves selection; **single-click** pastes,
  - right-click a row for the item menu; all rows except copied files offer **Save as**
    (portal save dialog, default name `clip-<kind>-YYYYMMDD_HHMMSS.<ext>`), copied-file
    rows offer **Show in Files** (reveal in the session default file manager; missing
    files show a hint instead of a file-manager error),
  - every paste restores the entry, moves it to front, and (default) injects Ctrl+V
    into the focused window; recent row-1 restores can skip only the system clipboard
    rewrite for a short configured window.
- Top-panel indicator: recent entries, open clipboard, clear.
- Simple persistence: daily append-only `clips-YYYYMMDD.jsonl`; each line is a complete
  sorted history snapshot with bounded inline text, file URI references only for copied
  files, and optional capped base64 only for non-file payloads.
- YAML config (JSON also accepted); privacy skip for password-manager selections.


## Install (local, GNOME 46/50, Wayland)

```sh
# (optional) one-time data-home setup if you keep the default /opt/copy-gnome
./scripts/setup-home.sh

./scripts/install-extension.sh
# or explicitly: ./scripts/install-extension.sh --gnome 50
# Wayland: LOG OUT and back in, then:
gnome-extensions enable copy-gnome@clipboard
```

Then copy `config.example.yaml` to `$COPY_GNOME_HOME/config/config.yaml` if you want to
tweak defaults (default `$COPY_GNOME_HOME` = `/opt/copy-gnome/$USER`).


## CLI / recovery tool

```sh
./scripts/install-cli.sh

copy-gnome status
copy-gnome doctor
copy-gnome logs --since 30m
copy-gnome logs -f --tail 100
copy-gnome config validate
copy-gnome config get general.captureImages
copy-gnome config set general.captureImages false
copy-gnome disable
copy-gnome repair              # dry-run
copy-gnome repair --yes        # backup + truncate a bad JSONL tail line
copy-gnome --completion bash   # print bash completion
```

History commands talk to the running extension over its DBus service
([docs/14-ipc](docs/14-ipc/README.md)) and support scripting CopyQ-style:

```sh
copy-gnome list --limit 10
copy-gnome search 'error' --json
copy-gnome get 1a2b3c4d            # unique id prefix from `list`
copy-gnome use 1a2b3c4d            # restore to clipboard, float to top
echo -n "hello" | copy-gnome copy  # new entry + clipboard write
copy-gnome paste > clipboard.txt
copy-gnome rm 1a2b3c4d
copy-gnome clear --yes
copy-gnome popup                   # toggle the history popup
```

The CLI is a normal Node package (`@clipboard/copy-gnome`) with the `copy-gnome` binary.
It does not import GNOME Shell or extension runtime code, so `doctor`, `logs`, `config`,
`disable`, and `repair` remain useful when the extension is broken; the history commands
above need the extension running and exit with code 3 otherwise.
`scripts/install-cli.sh` installs bash completion to the user-level bash-completion
directory when generation succeeds.


## Develop without logging out

```sh
./scripts/dev-nested.sh                      # nested Wayland shell
journalctl --user -f | grep -i copy-gnome    # logs
```


## Layout

- `copy-gnome-46/` - the GNOME 46 extension build.
- `copy-gnome-50/` - the GNOME 50 extension build. Both are full, installable trees
  maintained in parallel; they differ only in `metadata.json` (`shell-version`) and
  `ui/popup.js` (GNOME 50 modal-grab and `orientation` fixes). `core/` is identical
  across both - see [docs/09-multi-version.md](docs/09-multi-version.md).
- `cli/` - Node CLI package (`copy-gnome`) for status, doctor, logs, config inspection,
  enable/disable, and JSONL repair.
- `docs/` - full design (start at [docs/00-index.md](docs/00-index.md)).
- `scripts/` - install / uninstall / dev / setup-home.


## Uninstall

```sh
./scripts/uninstall.sh            # add --purge to also delete the data home
```
