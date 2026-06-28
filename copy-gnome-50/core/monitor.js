import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { log } from './log.js';

// Watches Mutter's selection for clipboard-owner changes (the Wayland-correct way; no
// polling). Producer/consumer split: _onOwnerChanged (enqueue side) only snapshots the
// synchronously-available fields (sourceKind, mimes) and pushes a job; the drain loop
// (consumer side) reads the content, compares it against _lastContent, and either drops
// (self-write echo / replay / consecutive same content) or captures.
//
// Candidate shapes handed to onCapture:
//   { kind: 'text',  id, seq, mime, text }
//   { kind: 'file',  id, seq, mime: 'text/uri-list', text }   // text = newline-joined uris
//   { kind: 'image', id, seq, mime, bytes }                   // bytes = JS-owned Uint8Array
// onSuppressedRepeat receives { id, seq, reason, kind, mime, value, sourceKind } when a
// same-last event is suppressed so extension-side bookkeeping can refresh the top record.
//
// `id` is a uuid minted when the owner-changed is received; for a captured event it becomes
// the history record's id, so one id threads event -> record -> logs.
// See docs/features/clipboard-capture/clipboard-capture-design.md.

const IMAGE_READ_FAILURE_LIMIT = 3;
const READ_TIMEOUT_MS = 2000;
const READ_CHUNK_BYTES = 64 * 1024;
const DEBUG_TEXT_CHARS = 160;

function supportedImageMime(mimes) {
    // Keep the Shell-side image path narrow. Screenshots on GNOME normally offer PNG;
    // other image/* targets can have provider-specific behavior and are skipped for now.
    return mimes.includes('image/png') ? 'image/png' : null;
}

const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING'];

function textMime(mimes) {
    return TEXT_MIMES.find(m => mimes.includes(m)) ?? null;
}

function debugText(text) {
    const value = String(text ?? '');
    const shown = value.length <= DEBUG_TEXT_CHARS
        ? value
        : `${value.slice(0, Math.floor(DEBUG_TEXT_CHARS * 0.6))}...${value.slice(-(DEBUG_TEXT_CHARS - Math.floor(DEBUG_TEXT_CHARS * 0.6)))}`;
    return shown
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

function debugContent(type, value) {
    return `type=${type} bytes=${new TextEncoder().encode(value).length} value="${debugText(value)}"`;
}

function comparableContent(c) {
    return c && typeof c.type === 'string' && typeof c.value === 'string';
}

function debugSource(source) {
    try {
        return String(source).slice(0, DEBUG_TEXT_CHARS);
    } catch (e) {
        return '(source)';
    }
}

function eventCtx(id, seq) {
    return id && Number.isFinite(seq) ? `[${id},${seq}]` : '[monitor]';
}

function jobCtx(job) {
    return eventCtx(job?.id, job?.seq);
}

function readLimitDetails(result, capName, fallbackMaxBytes = null) {
    const parts = [];
    if (Number.isFinite(result?.bytesRead))
        parts.push(`bytesRead=${result.bytesRead}`);
    if (Number.isFinite(result?.maxBytes))
        parts.push(`maxBytes=${result.maxBytes}`);
    else if (Number.isFinite(fallbackMaxBytes))
        parts.push(`maxBytes=${fallbackMaxBytes}`);
    if (capName)
        parts.push(`cap=${capName}`);
    return parts.length ? ` ${parts.join(' ')}` : '';
}

// memory = Shell-owned (our own writes, screenshots, Mutter caches); everything else
// (Wayland / X11 clients) is a real external copy.
function sourceKindFromLabel(label) {
    return label.includes('SelectionSourceMemory') ? 'memory' : 'non-memory';
}

function mimeMatches(pattern, mime) {
    if (pattern === '*')
        return true;
    if (pattern.endsWith('/*'))
        return mime.startsWith(pattern.slice(0, -1));
    return pattern === mime;
}

function allowedMimes(mimes, patterns) {
    if (!Array.isArray(mimes) || !Array.isArray(patterns))
        return [];
    return mimes.filter(mime => patterns.some(pattern => mimeMatches(pattern, mime)));
}

function uriListEntries(uriListText) {
    return uriListText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
}

function normalizeFileUri(line) {
    if (line.startsWith('file://'))
        return line;
    if (/^file:\/(?!\/)/.test(line))
        return `file://${line.slice('file:'.length)}`;
    return line;
}

// Canonical form for a uri-list: drop CRs/blank lines and trim each entry. Used as the
// file entry's stored content. Accept authority-less file:/absolute/path input but store
// standard file:///absolute/path output.
function normalizeUriList(text) {
    return text
        .split('\n')
        .map(line => line.replace(/\r$/, '').trim())
        .filter(Boolean)
        .map(normalizeFileUri)
        .join('\n');
}

function fileUriPath(uri) {
    if (typeof uri !== 'string')
        return null;
    if (uri.startsWith('file://'))
        return uri.replace(/^file:\/\//, '');
    if (/^file:\/(?!\/)/.test(uri))
        return uri.replace(/^file:/, '');
    return null;
}

function uriListPathText(uriList) {
    if (typeof uriList !== 'string')
        return '';
    const paths = [];
    for (const line of uriListEntries(uriList)) {
        const pathPart = fileUriPath(line);
        if (pathPart == null)
            return '';
        try {
            paths.push(decodeURIComponent(pathPart));
        } catch (e) {
            return '';
        }
    }
    return paths.join('\n');
}

function parseSpecialCopiedFiles(text) {
    const lines = text
        .split('\n')
        .map(line => line.replace(/\r$/, '').trim())
        .filter(Boolean);
    let action = 'unknown';
    if (lines.length > 0 && ['copy', 'cut'].includes(lines[0])) {
        action = lines.shift();
    }
    return {
        action,
        uriList: normalizeUriList(lines.join('\n')),
    };
}

export class Monitor {
    constructor({
        onCapture, onSuppressedRepeat, captureFiles, captureImages, maxItemBytes,
        maxTextBytes, maxBinaryBytes, secretMimes, denyAllMemorySources, allowMemoryMimes,
    } = {}) {
        this._onCapture = typeof onCapture === 'function' ? onCapture : (() => {});
        this._onSuppressedRepeat = typeof onSuppressedRepeat === 'function' ? onSuppressedRepeat : (() => {});
        this._captureFiles = captureFiles ?? (() => false);
        this._captureImages = captureImages ?? (() => false);
        this._denyAllMemorySources = denyAllMemorySources ?? (() => true);
        this._allowMemoryMimes = allowMemoryMimes ?? (() => []);
        this._maxItemBytes = maxItemBytes ?? (() => 16 * 1024 * 1024);
        this._maxTextBytes = maxTextBytes ?? this._maxItemBytes;
        this._maxBinaryBytes = maxBinaryBytes ?? this._maxItemBytes;
        this._secretMimes = secretMimes ?? (() => []);
        this._selection = null;
        this._ownerChangedId = 0;
        this._lastContent = null;     // { id, origin, sourceKind, source, type, value }
        this._queue = [];             // FIFO owner-change jobs
        this._nextJobSeq = 1;
        this._processing = false;
        this._imageReadFailures = 0;
        this._imageCaptureDisabled = false;
        this._stopped = true;
    }

    start() {
        try {
            this._selection = global.display.get_selection();
            this._ownerChangedId = this._selection.connect('owner-changed',
                (_sel, selType, source) => this._onOwnerChanged(selType, source));
            this._stopped = false;
            log.debug('monitor started');
        } catch (e) {
            this._selection = null;
            this._ownerChangedId = 0;
            this._stopped = true;
            log.warn(`monitor failed to start: ${e.message}`);
        }
    }

    stop() {
        this._stopped = true;
        this._queue = [];
        this._nextJobSeq = 1;
        log.debug(`monitor stopping queueCleared=yes lastContent=${this._lastContent ? 'yes' : 'no'}`);
        if (this._ownerChangedId) {
            try {
                this._selection?.disconnect(this._ownerChangedId);
            } catch (e) {
                log.warn(`monitor disconnect failed: ${e.message}`);
            }
            this._ownerChangedId = 0;
        }
        this._selection = null;
        this._lastContent = null;
    }

    // --- self-write / last-content state (see design.md) ---

    /** @returns {object|null} the current _lastContent snapshot. */
    getLastContent() {
        return this._lastContent;
    }

    /**
     * Record the last clipboard content we wrote (origin 'restore') or captured (origin
     * 'capture'). The drain side compares an incoming memory event against this to drop our
     * own restore echo or a stale memory replay. No TTL: every capture overwrites it.
     */
    setLastContent({ id, origin, sourceKind = null, source = null, type = null, value }) {
        if (typeof type !== 'string' || typeof value !== 'string') {
            log.debug(`last content ignored reason=invalid type=${typeof type} value=${typeof value}`);
            return this._lastContent;
        }
        this._lastContent = {
            id: id ?? GLib.uuid_string_random(),
            origin,
            sourceKind,
            source,
            type,
            value,
        };
        log.debug(`[monitor]: last content set id=${this._lastContent.id} origin=${origin} sourceKind=${sourceKind} ${debugContent(type, value ?? '')}`);
        return this._lastContent;
    }

    /** Roll back to `backup` iff the current _lastContent is still a restore marker. */
    setLastContentIfIs(backup) {
        if (this._lastContent?.origin === 'restore') {
            log.debug(`[monitor]: last content rolled back from origin=restore to ${backup ? `origin=${backup.origin}` : 'null'}`);
            this._lastContent = backup ?? null;
        }
    }

    /**
     * Drop reason for `candidate` produced by `job`, else ''. This is only a consecutive
     * same-content guard: it compares against the single last clipboard payload, never
     * history. It catches our write-back echo, memory replays, and Wayland/clipboard-manager
     * owner re-announces of the same content without restoring full dedup.
     */
    _dropReason(job, candidate) {
        const last = this._lastContent;
        if (!comparableContent(last) || !candidate ||
                typeof candidate.kind !== 'string' || typeof candidate.value !== 'string')
            return '';
        if (candidate.kind !== last.type || candidate.value !== last.value)
            return '';
        if (last.origin === 'restore')
            return 'echo';
        if (job.sourceKind === 'memory')
            return 'stale-replay';
        return 'same-last';
    }

    _isFilePathTwin(job, text) {
        try {
            if (job?.sourceKind !== 'memory' || typeof text !== 'string')
                return false;
            const last = this._lastContent;
            if (!comparableContent(last) || last.type !== 'file')
                return false;
            const pathText = uriListPathText(last.value);
            return pathText !== '' && text === pathText;
        } catch (e) {
            log.warn(`${jobCtx(job)}: file path twin check skipped reason=${String(e?.message ?? e)}`);
            return false;
        }
    }

    _notifySuppressedRepeat(job, candidate, reason) {
        if (reason !== 'same-last')
            return;
        try {
            this._onSuppressedRepeat({
                id: job.id,
                seq: job.seq,
                reason,
                kind: candidate.kind,
                mime: candidate.mime,
                value: candidate.value,
                sourceKind: job.sourceKind,
            });
        } catch (e) {
            log.warn(`suppressed repeat notification failed: ${e.message}`);
        }
    }

    _readSourceMimes(source) {
        try {
            return (source.get_mimetypes() ?? []).filter(m => typeof m === 'string');
        } catch (e) {
            return [];
        }
    }

    /** Capture a file uri-list as one plain file record. */
    _captureFile(text, id, seq, { sourceMime = 'text/uri-list', fileAction = 'unknown' } = {}) {
        log.debug(`${eventCtx(id, seq)}: capture file sourceMime=${sourceMime} fileAction=${fileAction} bytes=${new TextEncoder().encode(text).length} uriCount=${uriListEntries(text).length} uriList="${debugText(text)}"`);
        this._onCapture({ kind: 'file', id, seq, mime: 'text/uri-list', text });
    }

    // --- enqueue side (producer): only snapshots sync fields and pushes ---

    _onOwnerChanged(selType, source) {
        if (this._stopped)
            return;

        try {
            // Only the CLIPBOARD selection is monitored (PRIMARY / middle-click capture removed).
            if (selType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
            if (!source) return;   // selection cleared

            this._queueRead(source);
        } catch (e) {
            log.warn(`owner change ignored: ${e.message}`);
        }
    }

    _queueRead(source) {
        if (!source || typeof source.get_mimetypes !== 'function')
            return;
        const id = GLib.uuid_string_random();
        const seq = this._nextJobSeq++;
        const sourceLabel = debugSource(source);
        const sourceKind = sourceKindFromLabel(sourceLabel);
        const rawMimes = this._readSourceMimes(source);
        let mimes = rawMimes;
        if (sourceKind === 'memory' && this._denyAllMemorySources()) {
            const allow = this._allowMemoryMimes();
            mimes = allowedMimes(rawMimes, allow);
            if (mimes.length === 0) {
                log.debug(`${eventCtx(id, seq)}: queue skipped sourceKind=memory reason=denyAllMemorySources mimes=${rawMimes.join(',') || '(none)'} allowMemoryMimes=${allow.join(',') || '(none)'} source=${sourceLabel}`);
                return;
            }
            log.debug(`${eventCtx(id, seq)}: queue memory allowed mimes=${rawMimes.join(',') || '(none)'} allowedMimes=${mimes.join(',')} allowMemoryMimes=${allow.join(',') || '(none)'}`);
        }
        const job = {
            id,
            seq,
            source,
            sourceLabel,
            sourceKind,
            mimes,
        };
        this._queue.push(job);
        log.debug(`${jobCtx(job)}: queue received/enqueued sourceKind=${job.sourceKind} source=${sourceLabel} queued=${this._queue.length} running=${this._processing ? 'yes' : 'no'}`);
        if (!this._processing)
            this._drain().catch(e => log.warn(`read failed: ${e.message}`));
    }

    // --- drain side (consumer): reads content, decides, captures ---

    async _drain() {
        if (this._processing)
            return;
        this._processing = true;
        log.debug('[monitor]: queue drain start');
        try {
            while (this._queue.length > 0 && !this._stopped) {
                const job = this._queue.shift();
                log.debug(`${jobCtx(job)}: queue dequeued/handling sourceKind=${job.sourceKind} source=${job.sourceLabel} remaining=${this._queue.length}`);
                await this._readOnce(job);
            }
        } finally {
            this._processing = false;
            log.debug(`[monitor]: queue drain stop remaining=${this._queue.length}`);
        }
    }

    async _readOnce(job) {
        try {
            const mimes = job.mimes;
            log.debug(`${jobCtx(job)}: source mimes=${mimes.join(',') || '(none)'}`);
            if (this._stopped) {
                log.debug(`${jobCtx(job)}: queue handled status=skipped reason=stopped remaining=${this._queue.length}`);
                return;
            }

            const has = m => mimes.includes(m);

            // Privacy: skip password-manager / concealed selections.
            const secret = this._secretMimes();
            if (secret.length && mimes.some(m => secret.includes(m))) {
                log.debug(`${jobCtx(job)}: queue handled status=skipped reason=concealed remaining=${this._queue.length}`);
                return;
            }

            const imageMime = supportedImageMime(mimes);
            const hasUnsupportedImage = !imageMime && mimes.some(m => m.startsWith('image/'));
            const plainMime = textMime(mimes);

            if (has('text/uri-list') || has('x-special/gnome-copied-files')) {
                if (!this._captureFiles()) {
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=file reason=disabled remaining=${this._queue.length}`);
                    return;
                }
                const fileMimes = has('x-special/gnome-copied-files')
                    ? ['x-special/gnome-copied-files', ...(has('text/uri-list') ? ['text/uri-list'] : [])]
                    : ['text/uri-list'];
                let mime = fileMimes[0];
                let result = null;
                for (const candidateMime of fileMimes) {
                    result = await this._readSourceBytes(job.source, candidateMime, this._maxItemBytes());
                    if (this._stopped) return;
                    if (result.ok) {
                        mime = candidateMime;
                        break;
                    }
                    const fallbackMime = fileMimes[fileMimes.indexOf(candidateMime) + 1] ?? '';
                    if (fallbackMime) {
                        const details = readLimitDetails(result, 'history.maxItemBytes', this._maxItemBytes());
                        log.warn(`${jobCtx(job)}: file clipboard read failed mime=${candidateMime} reason=${result.reason}${details} fallbackMime=${fallbackMime}`);
                        continue;
                    }
                    const details = readLimitDetails(result, 'history.maxItemBytes', this._maxItemBytes());
                    log.warn(`${jobCtx(job)}: file clipboard read skipped mime=${candidateMime} reason=${result.reason}${details}`);
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=file mime=${candidateMime} reason=${result.reason}${details} remaining=${this._queue.length}`);
                    return;
                }
                log.debug(`${jobCtx(job)}: source read file mime=${mime} bytes=${result.bytes.length}`);
                const rawText = new TextDecoder().decode(result.bytes);
                const special = mime === 'x-special/gnome-copied-files'
                    ? parseSpecialCopiedFiles(rawText)
                    : null;
                const fileAction = special?.action ?? 'unknown';
                const text = special ? special.uriList : normalizeUriList(rawText);
                log.debug(`${jobCtx(job)}: file payload parsed sourceMime=${mime} fileAction=${fileAction} uriCount=${uriListEntries(text).length} raw="${debugText(rawText)}" normalized="${debugText(text)}"`);
                if (text) {
                    const candidate = { kind: 'file', mime: 'text/uri-list', value: text };
                    const dropReason = this._dropReason(job, candidate);
                    if (dropReason) {
                        this._notifySuppressedRepeat(job, candidate, dropReason);
                        log.debug(`${jobCtx(job)}: queue handled status=dropped kind=file mime=text/uri-list sourceMime=${mime} fileAction=${fileAction} reason=${dropReason} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                        return;
                    }
                    const uriCount = uriListEntries(text).length;
                    this._captureFile(text, job.id, job.seq, { sourceMime: mime, fileAction });
                    this.setLastContent({ id: job.id, origin: 'capture', sourceKind: job.sourceKind, source: job.sourceLabel, type: 'file', value: text });
                    log.debug(`${jobCtx(job)}: queue handled status=captured kind=file mime=text/uri-list sourceMime=${mime} fileAction=${fileAction} bytes=${result.bytes.length} uriCount=${uriCount} remaining=${this._queue.length}`);
                } else {
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=file mime=${mime} fileAction=${fileAction} reason=empty remaining=${this._queue.length}`);
                }
                return;
            }

            // Prefer text when offered; many apps offer both text and image targets.
            if (plainMime) {
                const maxBytes = Math.min(this._maxItemBytes(), this._maxTextBytes());
                const capName = this._maxTextBytes() <= this._maxItemBytes()
                    ? 'storage.textMaxBytes'
                    : 'history.maxItemBytes';
                const result = await this._readSourceBytes(job.source, plainMime, maxBytes);
                if (this._stopped) return;
                if (!result.ok) {
                    const details = readLimitDetails(result, capName, maxBytes);
                    log.warn(`${jobCtx(job)}: text clipboard read skipped mime=${plainMime} reason=${result.reason}${details}`);
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=text mime=${plainMime} reason=${result.reason}${details} remaining=${this._queue.length}`);
                    return;
                }
                log.debug(`${jobCtx(job)}: source read text mime=${plainMime} bytes=${result.bytes.length}`);
                const text = new TextDecoder().decode(result.bytes);
                if (text && text.length > 0) {
                    log.debug(`${jobCtx(job)}: source text value="${debugText(text)}"`);
                    if (this._isFilePathTwin(job, text)) {
                        log.debug(`${jobCtx(job)}: queue handled status=dropped kind=text mime=${plainMime} reason=file-path-twin bytes=${result.bytes.length} remaining=${this._queue.length}`);
                        return;
                    }
                    const candidate = { kind: 'text', mime: plainMime, value: text };
                    const dropReason = this._dropReason(job, candidate);
                    if (dropReason) {
                        this._notifySuppressedRepeat(job, candidate, dropReason);
                        log.debug(`${jobCtx(job)}: queue handled status=dropped kind=text mime=${plainMime} reason=${dropReason} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                        return;
                    }
                    log.debug(`${jobCtx(job)}: capture text bytes=${result.bytes.length}`);
                    this._onCapture({ kind: 'text', id: job.id, seq: job.seq, mime: 'text/plain;charset=utf-8', text });
                    this.setLastContent({ id: job.id, origin: 'capture', sourceKind: job.sourceKind, source: job.sourceLabel, type: 'text', value: text });
                    log.debug(`${jobCtx(job)}: queue handled status=captured kind=text mime=${plainMime} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                    return;
                }
                log.debug(`${jobCtx(job)}: queue handled status=skipped kind=text mime=${plainMime} reason=empty remaining=${this._queue.length}`);
            }

            if (imageMime || hasUnsupportedImage) {
                if (!this._captureImages()) {
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=image reason=disabled remaining=${this._queue.length}`);
                    return;
                }
                if (this._imageCaptureDisabled) {
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=image reason=disabled-after-failures remaining=${this._queue.length}`);
                    return;
                }
                if (!imageMime) {
                    log.warn(`${jobCtx(job)}: image clipboard read skipped reason=unsupported-mime supported=image/png`);
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=image reason=unsupported-mime remaining=${this._queue.length}`);
                    return;
                }
                const maxBytes = Math.min(this._maxItemBytes(), this._maxBinaryBytes());
                const capName = this._maxBinaryBytes() <= this._maxItemBytes()
                    ? 'storage.binaryMaxBytes'
                    : 'history.maxItemBytes';
                if (maxBytes <= 0) {
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=image reason=binary-cap-zero remaining=${this._queue.length}`);
                    return;
                }
                const result = await this._readSourceBytes(job.source, imageMime, maxBytes);
                if (this._stopped) return;
                if (!result.ok) {
                    this._noteImageReadFailure(result.reason, imageMime);
                    const details = readLimitDetails(result, capName, maxBytes);
                    log.debug(`${jobCtx(job)}: queue handled status=skipped kind=image mime=${imageMime} reason=${result.reason}${details} remaining=${this._queue.length}`);
                    return;
                }
                log.debug(`${jobCtx(job)}: source read image mime=${imageMime} bytes=${result.bytes.length}`);
                const data = GLib.base64_encode(result.bytes);
                const dropReason = this._dropReason(job, { kind: 'image', mime: imageMime, value: data });
                if (dropReason) {
                    this._notifySuppressedRepeat(job, { kind: 'image', mime: imageMime, value: data }, dropReason);
                    log.debug(`${jobCtx(job)}: queue handled status=dropped kind=image mime=${imageMime} reason=${dropReason} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                    return;
                }
                this._imageReadFailures = 0;
                this._onCapture({ kind: 'image', id: job.id, seq: job.seq, mime: imageMime, bytes: result.bytes });
                this.setLastContent({ id: job.id, origin: 'capture', sourceKind: job.sourceKind, source: job.sourceLabel, type: 'image', value: data });
                log.debug(`${jobCtx(job)}: queue handled status=captured kind=image mime=${imageMime} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                return;
            }
            log.debug(`${jobCtx(job)}: queue handled status=skipped reason=unsupported-mime remaining=${this._queue.length}`);
        } catch (e) {
            log.warn(`${jobCtx(job)}: read failed reason=${e.message}`);
            log.debug(`${jobCtx(job)}: queue handled status=failed reason=exception remaining=${this._queue.length}`);
        }
    }

    _readSourceStream(source, mime) {
        if (!source || typeof source.read_async !== 'function' ||
                typeof source.read_finish !== 'function' || typeof mime !== 'string')
            return Promise.resolve({ ok: false, stream: null, reason: 'unsupported' });
        return this._withTimeout(`selection source ${mime} read`,
            finish => {
                source.read_async(mime, null, (_source, result) => {
                    try {
                        finish({ ok: true, stream: source.read_finish(result), reason: '' });
                    } catch (e) {
                        log.warn(`selection source ${mime} read failed: ${e.message}`);
                        finish({ ok: false, stream: null, reason: 'read-error' });
                    }
                });
            },
            { ok: false, stream: null, reason: 'timeout' },
            { ok: false, stream: null, reason: 'read-error' });
    }

    _withTimeout(label, start, timeoutValue, errorValue) {
        return new Promise(resolve => {
            let done = false;
            let timer = 0;
            const finish = value => {
                if (done)
                    return;
                done = true;
                if (timer) {
                    try {
                        GLib.Source.remove(timer);
                    } catch (e) {
                        // already fired/removed
                    }
                    timer = 0;
                }
                resolve(value);
            };
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, READ_TIMEOUT_MS, () => {
                timer = 0;
                log.warn(`${label} timed out`);
                finish(timeoutValue);
                return GLib.SOURCE_REMOVE;
            });
            try {
                start(finish);
            } catch (e) {
                log.warn(`${label} failed: ${e.message}`);
                finish(errorValue);
            }
        });
    }

    async _readSourceBytes(source, mime, maxBytes) {
        if (!Number.isFinite(maxBytes) || maxBytes <= 0)
            return { ok: false, bytes: null, reason: 'oversize', bytesRead: 0, maxBytes };
        const opened = await this._readSourceStream(source, mime);
        if (!opened.ok)
            return { ok: false, bytes: null, reason: opened.reason, bytesRead: 0, maxBytes };
        const stream = opened.stream;
        if (!stream)
            return { ok: false, bytes: null, reason: 'empty', bytesRead: 0, maxBytes };
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const chunk = await this._readStreamChunk(stream, mime);
                if (!chunk.ok)
                    return { ok: false, bytes: null, reason: chunk.reason };
                const data = chunk.bytes?.get_data();
                if (!data || data.length === 0)
                    break;
                total += data.length;
                if (total > maxBytes)
                    return { ok: false, bytes: null, reason: 'oversize', bytesRead: total, maxBytes };
                chunks.push(Uint8Array.from(data));
            }
        } catch (e) {
            log.warn(`selection source ${mime} stream read failed: ${e.message}`);
            return { ok: false, bytes: null, reason: 'read-error', bytesRead: total, maxBytes };
        } finally {
            await this._closeStream(stream);
        }
        if (total <= 0)
            return { ok: false, bytes: null, reason: 'empty', bytesRead: total, maxBytes };
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return { ok: true, bytes: out, reason: '', bytesRead: total, maxBytes };
    }

    _readStreamChunk(stream, mime) {
        return this._withTimeout(`selection source ${mime} stream read`,
            finish => {
                stream.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null,
                    (_stream, result) => {
                        try {
                            finish({ ok: true, bytes: stream.read_bytes_finish(result), reason: '' });
                        } catch (e) {
                            log.warn(`selection source ${mime} stream read failed: ${e.message}`);
                            finish({ ok: false, bytes: null, reason: 'read-error' });
                        }
                    });
            },
            { ok: false, bytes: null, reason: 'timeout' },
            { ok: false, bytes: null, reason: 'read-error' });
    }

    _closeStream(stream) {
        return this._withTimeout('selection source stream close',
            finish => {
                stream.close_async(GLib.PRIORITY_DEFAULT, null, (_stream, result) => {
                    try {
                        stream.close_finish(result);
                    } catch (e) {
                        // ignore close failures on a transient clipboard stream
                    }
                    finish(null);
                });
            },
            null,
            null);
    }

    _noteImageReadFailure(reason, mime) {
        if (reason === 'empty' || reason === 'oversize')
            return;
        this._imageReadFailures += 1;
        if (this._imageReadFailures >= IMAGE_READ_FAILURE_LIMIT) {
            this._imageCaptureDisabled = true;
            log.error(`image capture disabled for this session after ${this._imageReadFailures} read failures`);
            return;
        }
        log.warn(`image clipboard read failed (${mime}, ${reason}); failure ${this._imageReadFailures}/${IMAGE_READ_FAILURE_LIMIT}`);
    }
}
