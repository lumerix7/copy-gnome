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
import { DBusTransport } from './core/ipc.js';
import { defaultSaveName, savePlan, saveFileDialog, uriDisplayPath, writeBytesToUri } from './core/save.js';
import { partitionExistingUris, showInFileManager } from './core/reveal.js';
import * as Clipboard from './core/clipboard.js';
import { paste, resetPaste } from './core/paste.js';
import {
    HTML_MIME,
    PLAIN_TEXT_MIME,
    URI_LIST_MIME,
    binaryPayload,
    makePayload,
    makeTextPayload,
    payloadBytesTotal,
    plainTextPayload,
    richComparableValue,
    richPayload,
    recordComparableType,
    recordComparableValue,
    uriListPayload,
} from './core/payloads.js';
import { recordPreview } from './core/preview.js';
import { Indicator } from './ui/indicator.js';
import { Popup } from './ui/popup.js';

const UUID = 'copy-gnome@clipboard';
const DEBUG_VALUE_CHARS = 160;

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

function uriListCount(uriList) {
    const text = String(uriList ?? '');
    let count = 0;
    let lineHasText = false;
    for (const ch of text) {
        if (ch === '\n') {
            if (lineHasText)
                count++;
            lineHasText = false;
        } else {
            lineHasText = true;
        }
    }
    if (lineHasText)
        count++;
    return count;
}

function gnomeCopiedFilesPayload(uriList) {
    return `copy\n${uriList}`;
}

function fileUriPath(uri) {
    if (uri.startsWith('file://'))
        return uri.replace(/^file:\/\//, '');
    if (/^file:\/(?!\/)/.test(uri))
        return uri.replace(/^file:/, '');
    return null;
}

function normalizeFileUri(uri) {
    if (uri.startsWith('file://'))
        return uri;
    if (/^file:\/(?!\/)/.test(uri))
        return `file://${uri.slice('file:'.length)}`;
    return uri;
}

function normalizeUriListForRestore(uriList) {
    return uriList
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(normalizeFileUri)
        .join('\n');
}

function filePathText(uriList) {
    const paths = [];
    for (const line of uriList.split('\n').map(l => l.trim()).filter(Boolean)) {
        const pathPart = fileUriPath(line);
        if (pathPart == null) {
            paths.push(line);
            continue;
        }
        try {
            paths.push(decodeURIComponent(pathPart));
        } catch (e) {
            log.debug(`[restore]: file path decode failed uri="${debugValue(line)}" reason=${e.message}`);
        }
    }
    return paths.join('\n');
}

function recordMatchesDrop(rec, drop) {
    if (!rec || !drop || recordComparableType(rec) !== drop.kind)
        return false;
    return recordComparableValue(rec) === drop.value;
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
            maxItemBytes: () => this._config.history.maxItemBytes,
            maxTextBytes: () => this._config.storage.textMaxBytes,
            maxBinaryBytes: () => this._config.storage.binaryMaxBytes,
            secretMimes: () => this._config.privacy.secretMimes,
        });
        this._seedLastContentFromHistory();
        this._monitor.start();

        this._popup = new Popup({
            getItems: () => this._history.list(),
            onActivate: (rec, targetWindow, opts) => this._restore(rec, targetWindow, opts),
            onRemove: rec => this._history.remove(rec.id),
            onClear: () => this._history.clear(),
            onSave: () => this._flushFromPopup(),
            onSaveRecord: rec => this._saveRecord(rec),
            onRevealFile: rec => this._revealFile(rec),
            getUi: () => this._uiConfig(),
        });

        this._indicator = new Indicator({
            onOpen: (anchorActor, targetWindow) => this._popup.toggle(targetWindow, {
                placement: 'panel',
                anchorActor,
            }),
            onShow: (anchorActor, targetWindow) => this._popup.show(targetWindow, {
                placement: 'panel',
                anchorActor,
            }),
            onClear: () => this._history.clear(),
        });
        Main.panel.addToStatusArea(UUID, this._indicator);

        this._addKeybinding('toggle-popup', () => this._popup.toggle());

        // Periodic guaranteed flush; Ctrl+S in the popup can also flush on demand.
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

        // DBus control channel for the CLI (docs/14-ipc). Fail-closed: a failed export
        // only loses the CLI history commands; the extension keeps running.
        this._ipc = new DBusTransport();
        this._ipc.start(this._ipcHandlers());

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
            this._ipc?.stop();
        } catch (e) {
            log.warn(`ipc stop failed: ${e.message}`);
        }
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

        this._ipc = null;
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

    _seedLastContentFromHistory() {
        try {
            if (!this._monitor || !this._history)
                return;
            const rec = this._history?.list(1)?.[0] ?? null;
            const type = recordComparableType(rec);
            const value = recordComparableValue(rec);
            if (typeof type !== 'string' || typeof value !== 'string' || value.length === 0)
                return;
            this._monitor?.setLastContent({
                id: rec.id,
                origin: 'history',
                sourceKind: 'history',
                source: '(history-head)',
                type,
                value,
            });
        } catch (e) {
            log.warn(`history head seed skipped: ${e.message}`);
        }
    }

    async _flushFromPopup() {
        try {
            const status = await this._store?.flush() ?? 'idle';
            log.debug(`[store]: history save ${status}`);
            return status;
        } catch (e) {
            log.warn(`popup save: ${e.message}`);
            return 'failed';
        }
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
            if (c.kind === 'rich') {
                const rich = c.rich;
                const text = c.text;
                if (!rich || !text) {
                    log.debug(`${ctx}: capture skipped kind=rich reason=empty-payload`);
                    return;
                }
                const richBytes = Number.isFinite(c.richBytes) ? c.richBytes : byteLength(rich);
                const textBytes = Number.isFinite(c.textBytes) ? c.textBytes : byteLength(text);
                const companionPayloads = Array.isArray(c.companionPayloads)
                    ? c.companionPayloads
                        .filter(p => p && typeof p.mime === 'string' &&
                            typeof p.value === 'string' && Number.isFinite(p.bytes))
                        .map(p => makeTextPayload(p.mime, p.value, p.bytes))
                    : [];
                const size = richBytes + textBytes + payloadBytesTotal(companionPayloads);
                if (size > cfg.history.maxItemBytes) {
                    log.debug(`${ctx}: capture skipped kind=rich reason=history-max-bytes bytes=${size} max=${cfg.history.maxItemBytes}`);
                    return;
                }
                if (size > cfg.storage.textMaxBytes) {
                    log.warn(`${ctx}: capture skipped kind=rich reason=text-cap bytes=${size} max=${cfg.storage.textMaxBytes}`);
                    return;
                }
                const payloads = [
                    makeTextPayload(c.mime || HTML_MIME, rich, richBytes),
                    makeTextPayload(c.textMime || PLAIN_TEXT_MIME, text, textBytes),
                    ...companionPayloads,
                ];
                const rec = this._history.add({
                    id: c.id,
                    kind: 'rich',
                    mime: c.mime || HTML_MIME,
                    bytes: payloadBytesTotal(payloads),
                    payloads,
                });
                log.debug(`${ctx}: history add recordId=${rec.id} kind=rich mime=${rec.mime} bytes=${rec.bytes} richBytes=${richBytes} textBytes=${textBytes} companionMimes=${companionPayloads.map(p => p.mime).join(',') || '(none)'}`);
            } else if (c.kind === 'text' || c.kind === 'file') {
                const text = c.text;
                if (!text) {
                    log.debug(`${ctx}: capture skipped kind=${c.kind} reason=empty-text`);
                    return;
                }
                const size = byteLength(text);

                if (c.kind === 'file') {
                    const payloads = [makePayload(URI_LIST_MIME, 'uri-list', text, size)];
                    const rec = this._history.add({
                        id: c.id,
                        kind: 'file',
                        mime: URI_LIST_MIME,
                        bytes: size,
                        payloads,
                    });
                    log.debug(`${ctx}: history add recordId=${rec.id} kind=file bytes=${size} uriCount=${uriListCount(text)} preview="${debugValue(recordPreview(rec))}"`);
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
                const payloads = [makeTextPayload(c.mime || PLAIN_TEXT_MIME, text, size)];
                const rec = this._history.add({
                    id: c.id,
                    kind: 'text',
                    mime: c.mime || PLAIN_TEXT_MIME,
                    bytes: size,
                    payloads,
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
                const payloads = [makePayload(c.mime, 'base64', data, u8.length)];
                const rec = this._history.add({
                    id: c.id,
                    kind: 'image',
                    mime: c.mime,
                    bytes: u8.length,
                    payloads,
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

    /**
     * Restore `rec` to the clipboard and float it to the top. Returns true only after the
     * clipboard write (or a valid recent-top skip) and the MRU touch both happened.
     * `opts.autoPaste === false` suppresses the auto-paste injection (CLI restores).
     */
    async _restore(rec, targetWindow = null, opts = {}) {
        try {
            if (!this._enabled || !this._monitor || !this._history || !this._store)
                return false;
            const recentTop = this._recentTopRestoreWindow(rec, this._config?.ui?.skipClipboardWriteForRecentTopSec ?? 0);
            // Usually restore writes to the real system clipboard first. The recent row-1
            // shortcut skips only that write; validation, MRU touch, and paste continue.
            let wrote = false;
            // Self-write filtering lives in the monitor: record what we are about to write
            // (origin 'restore', sourceKind 'memory'), then write. The drain side drops the
            // memory echo by matching this type+value. Back up first so a failed write rolls
            // back the marker (see docs/03-clipboard/capture-pipeline.md).
            const backup = this._monitor.getLastContent();
            const markSelfWrite = (type, value) =>
                this._monitor.setLastContent({ origin: 'restore', type, value, sourceKind: 'memory', source: '(self-restore)' });
            // pasteMode gates the shortcut to confirmed same-mode restores: a rich record's
            // own clipboard write is single-MIME (see Clipboard.setContent), so skipping a
            // write that would actually change mode leaves the clipboard offering the wrong
            // (or no) target for the new mode. rec.lastPasteMode is only set after a real
            // write, so the first restore of a rich record always writes for real even inside
            // the recent-top window; only a second restore in the same mode can skip.
            const skipWrite = (type, pasteMode = null) => {
                const modeOk = pasteMode == null ||
                    (rec.lastPasteMode != null && rec.lastPasteMode === pasteMode);
                const skip = !!recentTop && modeOk;
                if (skip) {
                    log.debug(`[restore]: clipboard write skipped recordId=${rec.id} kind=${rec.kind} type=${type} reason=recent-top row=${recentTop.rowNumber} ageMs=${recentTop.ageMs} windowSec=${recentTop.windowSec}`);
                } else if (recentTop && pasteMode != null) {
                    log.debug(`[restore]: clipboard write forced recordId=${rec.id} kind=${rec.kind} type=${type} reason=recent-top-mode-unconfirmed lastPasteMode=${rec.lastPasteMode ?? '(none)'} pasteMode=${pasteMode}`);
                }
                return skip;
            };
            if (rec.kind === 'rich') {
                const rich = richPayload(rec);
                const plain = plainTextPayload(rec);
                if (!rich || !plain) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=rich reason=missing-payload`);
                    return false;
                }
                const mode = this._resolveRichTextMode(targetWindow, opts?.mode);
                if (mode.mode === 'rich') {
                    if (skipWrite('rich', 'rich'))
                        wrote = true;
                    else {
                        const comparable = richComparableValue(rich.value, plain.value);
                        markSelfWrite('rich', comparable);
                        log.debug(`[restore]: rich clipboard write recordId=${rec.id} mode=rich mime=${rich.mime} richBytes=${rich.bytes} textBytes=${plain.bytes} reason=${mode.reason} match=${mode.match || '(none)'}`);
                        wrote = Clipboard.setContent(rich.mime, encodeUtf8(rich.value));
                        if (wrote)
                            rec.lastPasteMode = 'rich';
                    }
                } else {
                    if (skipWrite('text', 'plain'))
                        wrote = true;
                    else {
                        markSelfWrite('text', plain.value);
                        log.debug(`[restore]: rich clipboard write recordId=${rec.id} mode=plain bytes=${byteLength(plain.value)} reason=${mode.reason} match=${mode.match || '(none)'} value="${debugValue(plain.value)}"`);
                        wrote = Clipboard.setText(plain.value);
                        if (wrote)
                            rec.lastPasteMode = 'plain';
                    }
                }
            } else if (rec.kind === 'image') {
                if (!this._config.general.captureImages) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=image reason=disabled`);
                    return false;
                }
                const payload = binaryPayload(rec);
                if (!payload) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=image reason=missing-payload`);
                    return false;
                }
                const u8 = GLib.base64_decode(payload.value);
                if (!u8) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=image reason=invalid-base64`);
                    return false;
                }
                if (skipWrite('image'))
                    wrote = true;
                else {
                    markSelfWrite('image', payload.value);
                    wrote = Clipboard.setContent(rec.mime, u8);
                }
            } else if (rec.kind === 'file') {
                if (!this._config.general.captureFiles) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=file reason=disabled`);
                    return false;
                }
                const payload = uriListPayload(rec);
                if (!payload) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=file reason=missing-payload`);
                    return false;
                }
                const restoreUri = normalizeUriListForRestore(payload.value);
                const wmClass = this._targetWmClass(targetWindow);
                const restoreFileUri = this._shouldRestoreFileUri(wmClass);
                const mode = restoreFileUri ? 'file' : 'path';
                const fileApps = this._config?.ui?.fileApps ?? [];
                const fileMatch = this._matchingConfigSubstring(wmClass, fileApps);
                log.debug(`[restore]: file target recordId=${rec.id} wm_class="${debugValue(wmClass)}" normalized="${debugValue(String(wmClass ?? '').toLowerCase())}" mode=${mode} match=${fileMatch || '(none)'} fileApps=${fileApps.join(',') || '(none)'}`);
                if (restoreFileUri) {
                    if (skipWrite('file'))
                        wrote = true;
                    else {
                        markSelfWrite('file', restoreUri);
                        const payload = gnomeCopiedFilesPayload(restoreUri);
                        wrote = Clipboard.setContent('x-special/gnome-copied-files', encodeUtf8(payload));
                        log.debug(`[restore]: file clipboard write mode=file mime=x-special/gnome-copied-files action=copy recordId=${rec.id} uriCount=${uriListCount(restoreUri)} uriList="${debugValue(restoreUri)}"`);
                    }
                } else {
                    const pathText = filePathText(restoreUri);
                    if (!pathText) {
                        log.warn(`[restore]: file restore skipped recordId=${rec.id} reason=no-path-text uriList="${debugValue(restoreUri)}"`);
                        return false;
                    }
                    if (skipWrite('text'))
                        wrote = true;
                    else {
                        markSelfWrite('text', pathText);
                        wrote = Clipboard.setText(pathText);
                        log.debug(`[restore]: file clipboard write mode=path recordId=${rec.id} bytes=${byteLength(pathText)} uriCount=${uriListCount(restoreUri)} value="${debugValue(pathText)}"`);
                    }
                }
            } else if (rec.kind === 'text') {
                const payload = plainTextPayload(rec);
                if (!payload) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=text reason=missing-payload`);
                    return false;
                }
                if (skipWrite('text'))
                    wrote = true;
                else {
                    markSelfWrite('text', payload.value);
                    log.debug(`[restore]: text clipboard write recordId=${rec.id} bytes=${byteLength(payload.value)} value="${debugValue(payload.value)}"`);
                    wrote = Clipboard.setText(payload.value);
                }
            } else {
                const payload = binaryPayload(rec);
                if (!payload) {
                    log.warn(`[restore]: skipped recordId=${rec.id ?? '(none)'} kind=${rec.kind ?? '(none)'} reason=no-payload`);
                    return false;
                }
                const u8 = GLib.base64_decode(payload.value);
                if (!u8) {
                    log.warn(`[restore]: skipped recordId=${rec.id} kind=${rec.kind ?? 'binary'} reason=invalid-base64`);
                    return false;
                }
                if (skipWrite('binary'))
                    wrote = true;
                else {
                    markSelfWrite('binary', payload.value);
                    wrote = Clipboard.setContent(rec.mime, u8);
                }
            }

            if (!wrote) {
                this._monitor.setLastContentIfIs(backup);
                log.warn(`[restore]: aborted recordId=${rec.id ?? '(none)'} kind=${rec.kind ?? '(none)'} reason=clipboard-write-failed`);
                return false;
            }

            if (!this._enabled || !this._history)
                return false;
            // Move the used entry to the front (MRU).
            this._history.touch(rec);
            log.info(`[restore]: restored recordId=${rec.id} kind=${rec.kind} bytes=${rec.bytes}`);

            // Optionally paste into the focused window after focus returns.
            if (!this._config.ui.autoPaste)
                log.debug(`[paste]: skipped recordId=${rec.id} reason=autoPaste-disabled`);
            else if (opts?.autoPaste === false)
                log.debug(`[paste]: skipped recordId=${rec.id} reason=caller-opt-out`);
            else
                this._schedulePaste(targetWindow, rec);
            return true;
        } catch (e) {
            log.warn(`restore failed: ${e.message}`);
            return false;
        }
    }

    // Save a record to disk via the portal save dialog (docs/07-ui.md); every kind except
    // `file`. The popup has already closed itself; the dialog runs in the portal process,
    // so the Shell only awaits DBus and file IO here.
    async _saveRecord(rec) {
        try {
            if (!this._enabled || !rec || rec.kind === 'file')
                return;
            const plan = savePlan(rec);
            if (!plan) {
                log.warn(`[save]: skipped recordId=${rec.id ?? '(none)'} kind=${rec.kind ?? '(none)'} reason=no-saveable-payload`);
                return;
            }
            const suggestedName = defaultSaveName(rec.kind, rec.createdAt, plan.extension);
            log.debug(`[save]: dialog recordId=${rec.id} kind=${rec.kind} mime=${rec.mime} bytes=${plan.bytes.length} suggestedName=${suggestedName}`);
            const uri = await saveFileDialog({ suggestedName });
            if (!uri) {
                log.debug(`[save]: cancelled recordId=${rec.id}`);
                return;
            }
            if (!this._enabled)
                return;
            const ok = await writeBytesToUri(uri, plan.bytes);
            if (ok) {
                log.info(`[save]: saved recordId=${rec.id} kind=${rec.kind} bytes=${plan.bytes.length} uri=${uri}`);
                Main.notify('copy-gnome', `Saved: ${uriDisplayPath(uri)}`);
            } else {
                Main.notify('copy-gnome', 'Save failed - see the journal for [save] lines');
            }
        } catch (e) {
            log.warn(`save record failed: ${e.message}`);
        }
    }

    // "Show in Files" for a file record (docs/07-ui.md). Existence is checked while the
    // popup is still open: all-missing returns {status:'missing'} so the popup shows its
    // inline hint; otherwise the popup is hidden here and the existing uris are revealed
    // in the session file manager.
    async _revealFile(rec) {
        try {
            if (!this._enabled || rec?.kind !== 'file')
                return { status: 'skipped' };
            const payload = uriListPayload(rec);
            const uris = payload
                ? normalizeUriListForRestore(payload.value).split('\n').filter(Boolean)
                : [];
            if (!uris.length) {
                log.warn(`[reveal]: skipped recordId=${rec.id ?? '(none)'} reason=no-uris`);
                return { status: 'missing' };
            }
            const { existing, missing } = await partitionExistingUris(uris);
            log.debug(`[reveal]: recordId=${rec.id} uris=${uris.length} existing=${existing.length} missing=${missing.length}`);
            if (!existing.length) {
                log.info(`[reveal]: all files missing recordId=${rec.id} uris=${uris.length}`);
                return { status: 'missing' };
            }
            if (!this._enabled)
                return { status: 'skipped' };
            this._popup?.hide('reveal');
            const shown = await showInFileManager(existing);
            if (!shown) {
                Main.notify('copy-gnome', 'Could not open the file manager');
                return { status: 'failed' };
            }
            if (missing.length)
                Main.notify('copy-gnome', `${missing.length} of ${uris.length} files no longer exist`);
            log.info(`[reveal]: shown recordId=${rec.id} uris=${existing.length}`);
            return { status: 'shown' };
        } catch (e) {
            log.warn(`reveal file failed: ${e.message}`);
            return { status: 'failed' };
        }
    }

    _recentTopRestoreWindow(rec, windowSec) {
        if (!(windowSec > 0) || !rec || typeof rec.usedAt !== 'number')
            return null;
        const selectedId = rec.id;
        const items = this._history?.list() ?? [];
        const rowIndex = items.findIndex(item => item.id === selectedId);
        if (rowIndex !== 0)
            return null;
        const ageMicros = GLib.get_real_time() - rec.usedAt;
        if (ageMicros < 0 || ageMicros > windowSec * 1000000)
            return null;
        return {
            rowIndex,
            rowNumber: rowIndex + 1,
            ageMs: Math.max(0, Math.round(ageMicros / 1000)),
            windowSec,
        };
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
                    log.debug(`[paste]: before inject recordId=${rec?.id ?? '(none)'} wm_class="${debugValue(plan.wmClass)}" normalized="${debugValue(plan.normalized)}" keys=${plan.keys.join('+') || '(none)'} reason=${plan.reason} match=${plan.match || '(none)'}`);
                    const ok = paste(plan.keys, '[paste]');
                    if (!ok)
                        log.warn(`[paste]: injection failed recordId=${rec?.id ?? '(none)'} keys=${plan.keys.join('+') || '(none)'} wm_class="${debugValue(plan.wmClass)}"`);
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

    _resolveRichTextMode(targetWindow = null, explicitMode = null) {
        if (explicitMode === 'rich' || explicitMode === 'plain')
            return { mode: explicitMode, reason: 'explicit', match: '' };

        const wmClass = this._targetWmClass(targetWindow);
        const hay = String(wmClass ?? '').toLowerCase();
        if (!hay)
            return { mode: 'plain', reason: 'no-wm-class', match: '' };

        const plainMatch = this._matchingConfigSubstring(hay, this._config?.ui?.plainTextApps ?? []);
        if (plainMatch)
            return { mode: 'plain', reason: 'plainTextApps', match: plainMatch };

        const richMatch = this._matchingConfigSubstring(hay, this._config?.ui?.richTextApps ?? []);
        if (richMatch)
            return { mode: 'rich', reason: 'richTextApps', match: richMatch };

        return { mode: 'plain', reason: 'default', match: '' };
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
    _resolvePastePlan() {
        const fallbackKeys = Array.isArray(this._config?.ui?.defaultPasteKeys)
            ? this._config.ui.defaultPasteKeys
            : ['ctrl', 'v'];
        const fallback = { keys: fallbackKeys, reason: 'default', match: '', wmClass: '', normalized: '' };
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

        for (const binding of ui.pasteKeybindings ?? []) {
            const keys = Array.isArray(binding?.keys) ? binding.keys : null;
            if (!keys)
                continue;
            const match = this._matchingConfigSubstring(hay, binding.apps ?? []);
            if (match)
                return {
                    keys,
                    reason: 'pasteKeybindings',
                    match,
                    wmClass,
                    normalized: hay,
                };
        }
        return { ...fallback, wmClass, normalized: hay };
    }

    // ---- IPC handlers (docs/14-ipc) ------------------------------------------------
    // Each handler returns a JSON-serializable envelope; the transport catches throws,
    // so a handler bug degrades to an { ok: false } reply instead of a Shell error.

    _ipcHandlers() {
        const guard = fn => (...args) => {
            if (!this._enabled || !this._history || !this._monitor || !this._config)
                return { ok: false, code: 'not-ready', error: 'extension not ready' };
            return fn(...args);
        };
        return {
            List: guard(limit => this._ipcList(limit)),
            Get: guard(id => this._ipcGet(id)),
            Use: guard((id, mode) => this._ipcUse(id, mode)),
            CopyText: guard(text => this._ipcCopyText(text)),
            GetClipboardText: guard(() => this._ipcGetClipboardText()),
            Search: guard((query, limit) => this._ipcSearch(query, limit)),
            Remove: guard(id => this._ipcRemove(id)),
            Clear: guard(() => this._ipcClear()),
            Popup: guard(() => this._ipcPopup()),
            Status: () => this._ipcStatus(),
        };
    }

    _ipcItem(rec, { withPayloads = false } = {}) {
        const item = {
            id: rec.id,
            kind: rec.kind,
            mime: rec.mime,
            bytes: rec.bytes,
            preview: recordPreview(rec),
            createdAt: rec.createdAt,
            usedAt: rec.usedAt,
        };
        if (withPayloads) {
            item.payloads = (rec.payloads ?? []).map(p => ({
                mime: p.mime,
                encoding: p.encoding,
                bytes: p.bytes,
                value: p.value,
            }));
        }
        return item;
    }

    /** Resolve an entry by exact id, or by a unique id prefix of at least 4 chars. */
    _ipcFind(id) {
        const key = String(id ?? '').trim();
        if (!key)
            return { error: { ok: false, code: 'bad-args', error: 'empty id' } };
        const records = this._history.list();
        const exact = records.find(r => r.id === key);
        if (exact)
            return { rec: exact };
        if (key.length >= 4) {
            const matches = records.filter(r => typeof r.id === 'string' && r.id.startsWith(key));
            if (matches.length === 1)
                return { rec: matches[0] };
            if (matches.length > 1)
                return { error: { ok: false, code: 'ambiguous', error: `id prefix "${key}" matches ${matches.length} entries` } };
        }
        return { error: { ok: false, code: 'not-found', error: `no entry with id ${key}` } };
    }

    _ipcList(limit) {
        const all = this._history.list();
        const items = limit > 0 ? all.slice(0, limit) : all;
        return { ok: true, total: all.length, items: items.map(r => this._ipcItem(r)) };
    }

    _ipcGet(id) {
        const { rec, error } = this._ipcFind(id);
        if (error)
            return error;
        return { ok: true, item: this._ipcItem(rec, { withPayloads: true }) };
    }

    async _ipcUse(id, mode) {
        const { rec, error } = this._ipcFind(id);
        if (error)
            return error;
        const explicitMode = mode === 'rich' || mode === 'plain' ? mode : null;
        const ok = await this._restore(rec, null, { autoPaste: false, mode: explicitMode });
        if (!ok)
            return { ok: false, code: 'restore-failed', error: 'restore failed; check the journal for [restore] lines' };
        return { ok: true, id: rec.id, kind: rec.kind };
    }

    _ipcCopyText(text) {
        const value = String(text ?? '');
        if (!value)
            return { ok: false, code: 'bad-args', error: 'empty text' };
        const size = byteLength(value);
        const cfg = this._config;
        const cap = Math.min(cfg.history.maxItemBytes, cfg.storage.textMaxBytes);
        if (size > cap)
            return { ok: false, code: 'too-large', error: `${size} bytes exceeds the ${cap} byte text cap` };
        // Same self-write dance as _restore: mark before writing so the monitor drops the
        // echo, roll the marker back if the write failed.
        const backup = this._monitor.getLastContent();
        this._monitor.setLastContent({ origin: 'restore', type: 'text', value, sourceKind: 'memory', source: '(cli-copy)' });
        if (!Clipboard.setText(value)) {
            this._monitor.setLastContentIfIs(backup);
            return { ok: false, code: 'clipboard-write-failed', error: 'clipboard write failed' };
        }
        const rec = this._history.add({
            kind: 'text',
            mime: PLAIN_TEXT_MIME,
            bytes: size,
            payloads: [makeTextPayload(PLAIN_TEXT_MIME, value, size)],
        });
        log.info(`[ipc]: copy recordId=${rec.id} bytes=${size}`);
        return { ok: true, id: rec.id, bytes: size };
    }

    async _ipcGetClipboardText() {
        const text = await Clipboard.getText();
        return { ok: true, hasText: text != null, text: text ?? '' };
    }

    _ipcSearch(query, limit) {
        const q = String(query ?? '').toLowerCase();
        if (!q)
            return { ok: false, code: 'bad-args', error: 'empty query' };
        const matches = this._history.list().filter(rec => this._ipcSearchText(rec).includes(q));
        const items = limit > 0 ? matches.slice(0, limit) : matches;
        return { ok: true, total: matches.length, items: items.map(r => this._ipcItem(r)) };
    }

    _ipcSearchText(rec) {
        const parts = [];
        for (const p of rec.payloads ?? []) {
            if (p?.encoding === 'utf8' || p?.encoding === 'uri-list')
                parts.push(p.value ?? '');
        }
        return parts.join('\n').toLowerCase();
    }

    _ipcRemove(id) {
        const { rec, error } = this._ipcFind(id);
        if (error)
            return error;
        this._history.remove(rec.id);
        return { ok: true, id: rec.id };
    }

    _ipcClear() {
        const count = this._history.list().length;
        this._history.clear();
        return { ok: true, cleared: count };
    }

    _ipcPopup() {
        if (!this._popup)
            return { ok: false, code: 'not-ready', error: 'popup not ready' };
        this._popup.toggle();
        return { ok: true };
    }

    _ipcStatus() {
        return {
            ok: true,
            uuid: UUID,
            version: String(this.metadata?.version ?? ''),
            ready: !!this._ready,
            count: this._history ? this._history.list().length : 0,
        };
    }
}
