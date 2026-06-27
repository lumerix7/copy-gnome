import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { log, setLevel } from './core/log.js';
import { Paths } from './core/paths.js';
import { loadConfig } from './core/config.js';
import { sha256Text, sha256Bytes, byteLength, encodeUtf8 } from './core/hash.js';
import { Store } from './core/store.js';
import { History } from './core/history.js';
import { Monitor } from './core/monitor.js';
import * as Clipboard from './core/clipboard.js';
import { paste, resetPaste } from './core/paste.js';
import { Indicator } from './ui/indicator.js';
import { Popup } from './ui/popup.js';

const UUID = 'copy-gnome@clipboard';

function textPreview(text) {
    return text.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function filePreview(uriList) {
    const uris = uriList.split('\n').filter(Boolean);
    const first = decodeURIComponent(uris[0] || '').replace(/^file:\/\//, '');
    const base = first.split('/').pop() || first;
    return uris.length > 1 ? `${base} (+${uris.length - 1} more)` : base;
}

export default class CopyGnomeExtension extends Extension {
    enable() {
        this._enabled = true;
        this._timers = new Set();
        this._keys = [];

        this._paths = new Paths().resolve();
        this._config = loadConfig(this._paths.config);
        setLevel(this._config.logging.level);
        this._settings = this.getSettings();

        this._store = new Store({
            dataDir: this._paths.data,
            opts: this._config.storage,
        });
        this._history = new History({
            opts: this._config.history,
            store: this._store,
            onChange: () => this._onHistoryChange(),
        });
        this._ready = false;
        this._store.open()
            .then(records => {
                if (!this._enabled || !this._history) return;
                this._history.load(records);
                this._ready = true;
                this._startRuntime();
            })
            .catch(e => {
                if (!this._enabled) return;
                log.error(`store open failed: ${e.message}`);
                this._history?.load([]);
                this._ready = true;
                this._startRuntime();
            });
    }

    _startRuntime() {
        if (!this._enabled || !this._history || this._monitor)
            return;
        this._monitor = new Monitor({
            onCapture: c => this._onCapture(c),
            watchPrimary: () => this._config.general.watchPrimarySelection,
            captureFiles: () => this._config.general.captureFiles,
            captureImages: () => this._config.general.captureImages,
            maxItemBytes: () => this._config.history.maxItemBytes,
            maxBinaryBytes: () => this._config.storage.inlineBinaryMaxBytes,
            secretMimes: () => this._config.privacy.secretMimes,
        });
        this._monitor.start();

        this._popup = new Popup({
            getItems: () => this._history.list(),
            onActivate: (rec, targetWindow) => this._restore(rec, targetWindow),
            onClear: () => this._history.clear(),
            getUi: () => this._uiConfig(),
        });

        this._indicator = new Indicator({
            onOpen: (anchorActor, targetWindow) => this._popup.toggle(targetWindow, {
                placement: 'panel',
                anchorActor,
            }),
        });
        Main.panel.addToStatusArea(UUID, this._indicator);

        this._addKeybinding('toggle-popup', () => this._popup.toggle());

        // Periodic guaranteed flush (the "~1 minute persistence").
        const sec = Math.max(5, this._config.storage.flushIntervalSec);
        this._flushTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, sec, () => {
            this._store.flush().catch(e => log.warn(`periodic flush: ${e.message}`));
            return GLib.SOURCE_CONTINUE;
        });

        log.info('enabled');
    }

    disable() {
        this._enabled = false;
        for (const name of this._keys) {
            try {
                Main.wm.removeKeybinding(name);
            } catch (e) {
                log.warn(`remove keybinding ${name}: ${e.message}`);
            }
        }
        this._keys = [];

        if (this._flushTimer) {
            try {
                GLib.Source.remove(this._flushTimer);
            } catch (e) {
                log.warn(`flush timer cleanup failed: ${e.message}`);
            }
            this._flushTimer = 0;
        }
        for (const id of this._timers) {
            try {
                GLib.Source.remove(id);
            } catch (e) {
                log.warn(`timer cleanup failed: ${e.message}`);
            }
        }
        this._timers.clear();

        try {
            this._monitor?.stop();
        } catch (e) {
            log.warn(`monitor stop failed: ${e.message}`);
        }
        try {
            this._popup?.hide();
        } catch (e) {
            log.warn(`popup hide failed: ${e.message}`);
        }
        try {
            this._indicator?.destroy();
        } catch (e) {
            log.warn(`indicator destroy failed: ${e.message}`);
        }

        try {
            this._store?.closeSync();
        } catch (e) {
            log.warn(`store close failed: ${e.message}`);
        }
        try {
            resetPaste();
        } catch (e) {
            log.warn(`paste reset failed: ${e.message}`);
        }

        this._monitor = null;
        this._popup = null;
        this._indicator = null;
        this._history = null;
        this._store = null;
        this._settings = null;
        this._config = null;

        log.info('disabled');
    }

    _addKeybinding(name, handler) {
        try {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    try {
                        if (this._enabled)
                            handler();
                    } catch (e) {
                        log.warn(`keybinding ${name} failed: ${e.message}`);
                    }
                });
            this._keys.push(name);
        } catch (e) {
            log.warn(`add keybinding ${name}: ${e.message}`);
        }
    }

    _onHistoryChange() {
        this._indicator?.refresh();
    }

    _uiConfig() {
        this._config = loadConfig(this._paths.config, { quiet: true });
        setLevel(this._config.logging.level);
        return this._config.ui;
    }

    async _onCapture(c) {
        try {
            if (!this._enabled || !this._monitor || !this._history || !this._store)
                return;
            const cfg = this._config;
            if (c.kind === 'text' || c.kind === 'file') {
                const text = c.text;
                if (!text) return;
                const hash = sha256Text(text);
                if (this._monitor.consumeExpected(hash)) return;

                const size = byteLength(text);
                if (c.kind === 'file') {
                    this._history.add({
                        kind: 'file', mime: 'text/uri-list', hash, text: null,
                        encoding: 'uri',
                        uri: text, bytes: size, preview: filePreview(text),
                    });
                    return;
                }
                if (size > cfg.history.maxItemBytes) {
                    log.debug(`skipping oversized text (${size} bytes)`);
                    return;
                }
                if (size > cfg.storage.inlineMaxBytes) {
                    log.warn(`skipping oversized text (${size} bytes exceeds inline cap)`);
                    return;
                }
                this._history.add({
                    kind: 'text', mime: c.mime, hash, encoding: 'utf8', text,
                    bytes: size, preview: textPreview(text),
                });
            } else if (c.kind === 'image') {
                if (!cfg.general.captureImages) {
                    log.debug('skipping image capture; disabled');
                    return;
                }
                const u8 = c.bytes;
                if (!u8 || u8.length === 0) return;
                if (u8.length > cfg.history.maxItemBytes) {
                    log.debug(`skipping oversized image (${u8.length} bytes)`);
                    return;
                }
                if (u8.length > cfg.storage.inlineBinaryMaxBytes) {
                    log.warn(`skipping oversized image (${u8.length} bytes exceeds inline binary cap)`);
                    return;
                }
                const hash = sha256Bytes(u8);
                if (this._monitor.consumeExpected(hash)) return;
                this._history.add({
                    kind: 'image', mime: c.mime, hash, encoding: 'base64',
                    data: GLib.base64_encode(u8),
                    bytes: u8.length,
                    preview: `[image ${Math.round(u8.length / 1024)} KB]`,
                });
            }
        } catch (e) {
            log.warn(`capture failed: ${e.message}`);
        }
    }

    async _restore(rec, targetWindow = null) {
        try {
            if (!this._enabled || !this._monitor || !this._history || !this._store)
                return;
            // Always write to the real system clipboard (this is the core action).
            // Only continue to MRU/paste after the clipboard write succeeds; otherwise
            // auto-paste could paste stale clipboard content.
            let wrote = false;
            if (rec.kind === 'image' && rec.data) {
                if (!this._config.general.captureImages) {
                    log.warn('image restore skipped; image support is disabled');
                    return;
                }
                const u8 = GLib.base64_decode(rec.data);
                if (!u8) {
                    log.warn('image restore skipped; invalid base64 payload');
                    return;
                }
                this._monitor.expect(rec.hash);
                wrote = Clipboard.setContent(rec.mime, u8);
            } else if (rec.kind === 'file' && rec.uri) {
                if (!this._config.general.captureFiles) {
                    log.warn('file restore skipped; file support is disabled');
                    return;
                }
                this._monitor.expect(rec.hash);
                wrote = Clipboard.setContent('text/uri-list', encodeUtf8(rec.uri));
            } else if (rec.text != null) {
                this._monitor.expect(rec.hash);
                wrote = Clipboard.setText(rec.text);
            } else if (rec.data) {
                const u8 = GLib.base64_decode(rec.data);
                if (!u8) {
                    log.warn('binary restore skipped; invalid base64 payload');
                    return;
                }
                this._monitor.expect(rec.hash);
                wrote = Clipboard.setContent(rec.mime, u8);
            } else {
                log.warn('restore skipped; record has no payload');
                return;
            }

            if (!wrote) {
                this._monitor.consumeExpected(rec.hash);
                log.warn('restore aborted; clipboard write failed');
                return;
            }

            if (!this._enabled || !this._history)
                return;
            // Move the used entry to the front (MRU).
            this._history.touch(rec);

            // Optionally paste into the focused window after focus returns.
            if (this._config.ui.autoPaste)
                this._schedulePaste(targetWindow);
        } catch (e) {
            log.warn(`restore failed: ${e.message}`);
        }
    }

    _schedulePaste(targetWindow = null) {
        // Delay so focus has returned to the previous window after the popup closed.
        const delayMs = Math.max(0, this._config.ui.autoPasteDelayMs ?? 220);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._timers.delete(id);
            try {
                if (this._enabled) {
                    this._restorePasteFocus(targetWindow);
                    paste(this._resolvePasteCombo());
                }
            } catch (e) {
                log.warn(`scheduled paste failed: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    _restorePasteFocus(targetWindow) {
        if (!this._config?.ui?.pasteRestoresFocus || !targetWindow)
            return;
        try {
            if (targetWindow.minimized)
                return;
            targetWindow.activate(global.get_current_time());
        } catch (e) {
            log.debug(`paste focus restore skipped: ${e.message}`);
        }
    }

    // Pick the paste keystroke for the currently focused window. There is no semantic
    // "paste" on Wayland, so this is per-app; the clipboard is already set regardless.
    _resolvePasteCombo() {
        if (!this._config)
            return 'ctrl-v';
        const win = global.display.get_focus_window();
        const hay = (win?.get_wm_class() ?? '').toLowerCase();
        const ui = this._config.ui;

        for (const o of ui.pasteOverrides ?? []) {
            if (o?.match && hay.includes(String(o.match).toLowerCase()))
                return o.combo ?? 'ctrl-v';
        }
        if (ui.terminalApps.some(t => hay.includes(String(t).toLowerCase())))
            return 'ctrl-shift-v';
        return 'ctrl-v';
    }
}
