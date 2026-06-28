import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { log, setLevel } from './core/log.js';
import { Paths } from './core/paths.js';
import { loadConfig } from './core/config.js';
import { byteLength, encodeUtf8 } from './core/utf8.js';
import { Store } from './core/store.js';
import { History } from './core/history.js';
import { Monitor } from './core/monitor.js';
import * as Clipboard from './core/clipboard.js';
import { paste, resetPaste } from './core/paste.js';
import { Indicator } from './ui/indicator.js';
import { Popup } from './ui/popup.js';

const UUID = 'copy-gnome@clipboard';
const DEBUG_VALUE_CHARS = 160;

function textPreview(text) {
    return text.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function debugValue(value, max = DEBUG_VALUE_CHARS) {
    const text = String(value ?? '');
    const shown = text.length <= max
        ? text
        : `${text.slice(0, Math.floor(max * 0.6))}...${text.slice(-(max - Math.floor(max * 0.6)))}`;
    return shown
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

function eventCtx(id, seq, fallback = 'extension') {
    return id && Number.isFinite(seq) && seq > 0 ? `[${id},${seq}]` : `[${fallback}]`;
}

function filePreview(uriList) {
    const uris = uriList.split('\n').filter(Boolean);
    let first = uris[0] || '';
    try {
        first = decodeURIComponent(first);
    } catch (e) {
        log.debug(`[restore]: file preview decode failed uri="${debugValue(first)}": ${e.message}`);
    }
    return uris.length > 1 ? `${first} (+${uris.length - 1} more)` : first;
}

function uriListCount(uriList) {
    return uriList.split('\n').filter(Boolean).length;
}

function filePathText(uriList) {
    const paths = [];
    for (const line of uriList.split('\n').map(l => l.trim()).filter(Boolean)) {
        if (!line.startsWith('file://')) {
            paths.push(line);
            continue;
        }
        try {
            paths.push(decodeURIComponent(line.replace(/^file:\/\//, '')));
        } catch (e) {
            log.debug(`[restore]: file path decode failed uri="${debugValue(line)}" reason=${e.message}`);
        }
    }
    return paths.join('\n');
}

function recordMatchesDrop(rec, drop) {
    if (!rec || !drop || rec.kind !== drop.kind)
        return false;
    if (drop.kind === 'text')
        return rec.text === drop.value;
    if (drop.kind === 'file')
        return rec.uri === drop.value;
    if (drop.kind === 'image' || drop.kind === 'binary')
        return rec.data === drop.value;
    return false;
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
            // Only sync the trimmed set back if History hasn't changed since the snapshot was
            // taken; otherwise a capture that landed mid-flush would be dropped from memory.
            // The newer pending snapshot will be flushed and re-trimmed, converging safely.
            onTrim: (records, gen) => {
                if (this._history && this._history.gen === gen)
                    this._history.trimTo(records);
            },
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
            onSuppressedRepeat: r => this._onSuppressedRepeat(r),
            captureFiles: () => this._config.general.captureFiles,
            captureImages: () => this._config.general.captureImages,
            denyAllMemorySources: () => this._config.general.denyAllMemorySources,
            allowMemoryMimes: () => this._config.general.allowMemoryMimes,
            maxItemBytes: () => this._config.history.maxItemBytes,
            maxBinaryBytes: () => this._config.storage.binaryMaxBytes,
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

        // Periodic retention sweep: delete daily clips-*.jsonl files older than maxAgeDays.
        // Started only here, after store.open() + history.load() have populated the in-memory
        // model, and never from disable()/teardown. The sweep is fail-closed and never touches
        // the in-memory history; deleting even the just-loaded old file is safe because memory
        // is the session source of truth and the next copy re-homes the snapshot to today's file.
        const maxAgeDays = this._config.history.maxAgeDays;
        if (maxAgeDays > 0) {
            this._store.sweepOldFiles(maxAgeDays)
                .catch(e => log.error(`cleanup: ${e.message}`));
            const sweepSec = Math.max(15, this._config.history.cleanupIntervalSec);
            this._cleanupTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, sweepSec, () => {
                try {
                    this._store?.sweepOldFiles(maxAgeDays)
                        .catch(e => log.error(`cleanup: ${e.message}`));
                } catch (e) {
                    log.error(`cleanup timer: ${e.message}`);
                }
                return GLib.SOURCE_CONTINUE;
            });
        }

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
        if (this._cleanupTimer) {
            try {
                GLib.Source.remove(this._cleanupTimer);
            } catch (e) {
                log.warn(`cleanup timer cleanup failed: ${e.message}`);
            }
            this._cleanupTimer = 0;
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
            const seq = Number.isFinite(c.seq) ? c.seq : 0;
            const ctx = eventCtx(c.id, seq);
            if (c.kind === 'text' || c.kind === 'file') {
                const text = c.text;
                if (!text) {
                    log.debug(`${ctx}: capture skipped kind=${c.kind} reason=empty-text`);
                    return;
                }
                const size = byteLength(text);

                if (c.kind === 'file') {
                    const preview = filePreview(text);
                    const rec = this._history.add({
                        id: c.id,
                        kind: 'file', mime: 'text/uri-list', text: null,
                        encoding: 'uri',
                        uri: text, bytes: size, preview,
                    });
                    log.debug(`${ctx}: history add recordId=${rec.id} kind=file bytes=${size} uriCount=${uriListCount(text)} preview="${debugValue(preview)}"`);
                    return;
                }
                if (size > cfg.history.maxItemBytes) {
                    log.debug(`${ctx}: capture skipped kind=text reason=history-max-bytes bytes=${size} max=${cfg.history.maxItemBytes}`);
                    return;
                }
                if (size > cfg.storage.textMaxBytes) {
                    log.warn(`${ctx}: capture skipped kind=text reason=text-cap bytes=${size} max=${cfg.storage.textMaxBytes}`);
                    return;
                }
                const rec = this._history.add({
                    id: c.id,
                    kind: 'text', mime: c.mime, encoding: 'utf8', text,
                    bytes: size, preview: textPreview(text),
                });
                log.debug(`${ctx}: history add recordId=${rec.id} kind=text bytes=${size}`);
            } else if (c.kind === 'image') {
                if (!cfg.general.captureImages) {
                    log.debug(`${ctx}: capture skipped kind=image reason=disabled`);
                    return;
                }
                const u8 = c.bytes;
                if (!u8 || u8.length === 0) {
                    log.debug(`${ctx}: capture skipped kind=image reason=empty-bytes`);
                    return;
                }
                if (u8.length > cfg.history.maxItemBytes) {
                    log.debug(`${ctx}: capture skipped kind=image reason=history-max-bytes bytes=${u8.length} max=${cfg.history.maxItemBytes}`);
                    return;
                }
                if (u8.length > cfg.storage.binaryMaxBytes) {
                    log.warn(`${ctx}: capture skipped kind=image reason=binary-cap bytes=${u8.length} max=${cfg.storage.binaryMaxBytes}`);
                    return;
                }
                const data = GLib.base64_encode(u8);
                const rec = this._history.add({
                    id: c.id,
                    kind: 'image', mime: c.mime, encoding: 'base64',
                    data,
                    bytes: u8.length,
                    preview: `[image ${Math.round(u8.length / 1024)} KB]`,
                });
                log.debug(`${ctx}: history add recordId=${rec.id} kind=image bytes=${u8.length}`);
            }
        } catch (e) {
            log.warn(`capture failed: ${e.message}`);
        }
    }

    _onSuppressedRepeat(d) {
        try {
            if (!this._enabled || !this._history || d?.reason !== 'same-last')
                return;
            const seq = Number.isFinite(d.seq) ? d.seq : 0;
            const ctx = eventCtx(d.id, seq);
            const top = this._history.list(1)[0] ?? null;
            if (!recordMatchesDrop(top, d)) {
                log.warn(`${ctx}: suppressed repeat skipped history touch repeatId=${d.id ?? '(none)'} kind=${d.kind ?? '(none)'} topId=${top?.id ?? '(none)'} topKind=${top?.kind ?? '(none)'} reason=top-mismatch`);
                return;
            }
            this._history.touch(top);
            log.debug(`${ctx}: history touch suppressed-repeat repeatId=${d.id} targetId=${top.id} kind=${top.kind} bytes=${top.bytes} reason=same-last`);
        } catch (e) {
            log.warn(`suppressed repeat handling failed: ${e.message}`);
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
            // Self-write filtering lives in the monitor: record what we are about to write
            // (origin 'restore', sourceKind 'memory'), then write. The drain side drops the
            // memory echo by matching this type+value. Back up first so a failed write rolls
            // back the marker (see docs/features/clipboard-capture/clipboard-capture-design.md).
            const backup = this._monitor.getLastContent();
            const markSelfWrite = (type, value) =>
                this._monitor.setLastContent({ origin: 'restore', type, value, sourceKind: 'memory', source: '(self-restore)' });
            if (rec.kind === 'image' && rec.data) {
                if (!this._config.general.captureImages) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=image reason=disabled`);
                    return;
                }
                const u8 = GLib.base64_decode(rec.data);
                if (!u8) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=image reason=invalid-base64`);
                    return;
                }
                markSelfWrite('image', rec.data);
                wrote = Clipboard.setContent(rec.mime, u8);
            } else if (rec.kind === 'file' && rec.uri) {
                if (!this._config.general.captureFiles) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=file reason=disabled`);
                    return;
                }
                const wmClass = this._targetWmClass(targetWindow);
                const restoreFileUri = this._shouldRestoreFileUri(wmClass);
                const mode = restoreFileUri ? 'file' : 'path';
                const fileApps = this._config?.ui?.fileApps ?? [];
                const fileMatch = this._matchingConfigSubstring(wmClass, fileApps);
                log.debug(`[restore]: file target recordId=${rec.id} wm_class="${debugValue(wmClass)}" normalized="${debugValue(String(wmClass ?? '').toLowerCase())}" mode=${mode} match=${fileMatch || '(none)'} fileApps=${fileApps.join(',') || '(none)'}`);
                if (restoreFileUri) {
                    markSelfWrite('file', rec.uri);
                    wrote = Clipboard.setContent('text/uri-list', encodeUtf8(rec.uri));
                    log.debug(`[restore]: file clipboard write mode=file recordId=${rec.id} uriCount=${uriListCount(rec.uri)} uriList="${debugValue(rec.uri)}"`);
                } else {
                    const pathText = filePathText(rec.uri);
                    if (!pathText) {
                        log.warn(`[restore]: file restore skipped recordId=${rec.id} reason=no-path-text uriList="${debugValue(rec.uri)}"`);
                        return;
                    }
                    markSelfWrite('text', pathText);
                    wrote = Clipboard.setText(pathText);
                    log.debug(`[restore]: file clipboard write mode=path recordId=${rec.id} bytes=${byteLength(pathText)} uriCount=${uriListCount(rec.uri)} value="${debugValue(pathText)}"`);
                }
            } else if (rec.text != null) {
                markSelfWrite('text', rec.text);
                log.debug(`[restore]: text clipboard write recordId=${rec.id} bytes=${byteLength(rec.text)} value="${debugValue(rec.text)}"`);
                wrote = Clipboard.setText(rec.text);
            } else if (rec.data) {
                const u8 = GLib.base64_decode(rec.data);
                if (!u8) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=${rec.kind ?? 'binary'} reason=invalid-base64`);
                    return;
                }
                markSelfWrite('binary', rec.data);
                wrote = Clipboard.setContent(rec.mime, u8);
            } else {
                log.warn(`[restore]: skipped recordId=${rec.id ?? '(none)'} kind=${rec.kind ?? '(none)'} reason=no-payload`);
                return;
            }

            if (!wrote) {
                this._monitor.setLastContentIfIs(backup);
                log.warn(`[restore]: aborted recordId=${rec.id ?? '(none)'} kind=${rec.kind ?? '(none)'} reason=clipboard-write-failed`);
                return;
            }

            if (!this._enabled || !this._history)
                return;
            // Move the used entry to the front (MRU).
            this._history.touch(rec);
            log.info(`[restore]: restored recordId=${rec.id} kind=${rec.kind} bytes=${rec.bytes}`);

            // Optionally paste into the focused window after focus returns.
            if (this._config.ui.autoPaste)
                this._schedulePaste(targetWindow, rec);
            else
                log.debug(`[paste]: skipped recordId=${rec.id} reason=autoPaste-disabled`);
        } catch (e) {
            log.warn(`restore failed: ${e.message}`);
        }
    }

    _schedulePaste(targetWindow = null, rec = null) {
        // Delay so focus has returned to the previous window after the popup closed.
        const delayMs = Math.max(0, this._config.ui.autoPasteDelayMs ?? 220);
        log.debug(`[paste]: scheduled recordId=${rec?.id ?? '(none)'} delayMs=${delayMs}`);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._timers.delete(id);
            try {
                if (this._enabled) {
                    this._restorePasteFocus(targetWindow);
                    const plan = this._resolvePastePlan();
                    log.debug(`[paste]: before inject recordId=${rec?.id ?? '(none)'} wm_class="${debugValue(plan.wmClass)}" normalized="${debugValue(plan.normalized)}" combo=${plan.combo} reason=${plan.reason} match=${plan.match || '(none)'}`);
                    const ok = paste(plan.combo, '[paste]');
                    if (!ok)
                        log.warn(`[paste]: injection failed recordId=${rec?.id ?? '(none)'} combo=${plan.combo} wm_class="${debugValue(plan.wmClass)}"`);
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
            const wmClass = this._targetWmClass(targetWindow);
            log.debug(`[paste]: restoring focus wm_class="${debugValue(wmClass)}"`);
            targetWindow.activate(global.get_current_time());
        } catch (e) {
            log.debug(`paste focus restore skipped: ${e.message}`);
        }
    }

    _targetWmClass(targetWindow = null) {
        try {
            return targetWindow?.get_wm_class?.() ??
                global.display.get_focus_window()?.get_wm_class?.() ?? '';
        } catch (e) {
            log.debug(`target wm_class read failed: ${e.message}`);
            return '';
        }
    }

    _shouldRestoreFileUri(wmClass) {
        const hay = String(wmClass ?? '').toLowerCase();
        if (!hay)
            return false;
        return this._matchingConfigSubstring(hay, this._config?.ui?.fileApps ?? []) !== '';
    }

    _matchingConfigSubstring(wmClass, values) {
        const hay = String(wmClass ?? '').toLowerCase();
        if (!hay || !Array.isArray(values))
            return '';
        for (const value of values) {
            const needle = String(value ?? '').toLowerCase();
            if (needle && hay.includes(needle))
                return needle;
        }
        return '';
    }

    // Pick the paste keystroke for the currently focused window. There is no semantic
    // "paste" on Wayland, so this is per-app; the clipboard is already set regardless.
    _resolvePasteCombo() {
        return this._resolvePastePlan().combo;
    }

    _resolvePastePlan() {
        const fallback = { combo: 'ctrl-v', reason: 'default', match: '', wmClass: '', normalized: '' };
        if (!this._config)
            return { ...fallback, reason: 'no-config' };
        let wmClass = '';
        try {
            const win = global.display.get_focus_window();
            wmClass = win?.get_wm_class?.() ?? '';
        } catch (e) {
            log.debug(`[paste]: wm_class read failed: ${e.message}`);
            return { ...fallback, reason: 'wm-class-error' };
        }
        const hay = String(wmClass ?? '').toLowerCase();
        if (!hay)
            return { ...fallback, reason: 'no-wm-class', wmClass, normalized: hay };
        const ui = this._config.ui ?? {};

        for (const o of ui.pasteOverrides ?? []) {
            const match = String(o?.match ?? '').toLowerCase();
            if (match && hay.includes(match))
                return {
                    combo: o.combo ?? 'ctrl-v',
                    reason: 'pasteOverride',
                    match,
                    wmClass,
                    normalized: hay,
                };
        }
        const terminalMatch = this._matchingConfigSubstring(hay, ui.terminalApps ?? []);
        if (terminalMatch)
            return {
                combo: 'ctrl-shift-v',
                reason: 'terminalApps',
                match: terminalMatch,
                wmClass,
                normalized: hay,
            };
        return { ...fallback, wmClass, normalized: hay };
    }
}
