# @clipboard/copy-gnome

Node CLI and recovery tooling for copy-gnome.

```sh
npm install
npm install -g .

copy-gnome status
copy-gnome doctor
copy-gnome logs --since 30m
copy-gnome logs -f --tail 100
copy-gnome disable
copy-gnome config validate
copy-gnome config get general.captureImages
copy-gnome config set general.captureImages false
copy-gnome config edit
copy-gnome repair
copy-gnome --completion bash
```

The CLI deliberately avoids importing GNOME Shell/GJS extension code. It uses filesystem
checks plus `gnome-extensions`, `gsettings`, and `journalctl`, so it is still useful when
the extension itself is unhealthy.

Commands:

- `status`: print extension, config, path, GSettings, and latest clips health.
- `doctor`: read-only diagnostics; exits non-zero only on `fail` checks.
- `logs`: focused recent journal output; `-f/--follow` tails new matching lines and
  `-n/--tail` limits the initial journal window.
- `enable`, `disable`, `restart`, `extension-status`: wrappers around `gnome-extensions`.
- `paths`: print the same data/config path resolution used by the extension.
- `config path|validate|show|get|set|edit`: inspect or update `config.yaml`; writes are
  validated and replace the file through a temporary file.
- `repair`: dry-run by default; `--yes` backs up the clips file and truncates a bad tail line.
- `--completion bash`: print bash completion for commands, options, config keys, and files.
