import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { ClipboardReadScope } from './clipboard.js';
import { Completions } from './completions.js';
import { readCapture } from './capture-reader.js';
import { log } from './log.js';
import { richComparablePlain } from './payloads.js';

// Watches Mutter's selection for clipboard-owner changes (the Wayland-correct way; no
// polling). The owner signal screens privacy and snapshots metadata and configuration.
// Each idle dispatch starts one detached payload read. A live completion compares
// the result with _lastContent and either suppresses the duplicate or captures it.
//
// Candidate shapes handed to onCapture:
//   { kind: 'text',  id, seq, mime, text }
//   { kind: 'rich',  id, seq, mime, rich, richBytes, text, textMime, textBytes }
//   { kind: 'file',  id, seq, mime: 'text/uri-list', text }   // text = newline-joined uris
//   { kind: 'image', id, seq, mime, bytes }                   // bytes = JS-owned Uint8Array
// onSuppressedRepeat receives { id, seq, reason, kind, mime, value, sourceKind } when a
// same-last event is suppressed. It returns the matching history head ID after refreshing it.
//
// `id` is a uuid minted when the owner-changed is received; for a captured event it becomes
// the history record's id, so one id threads event -> record -> logs.
// See docs/03-clipboard/capture-pipeline.md.

const IMAGE_READ_FAILURE_LIMIT = 3;
const DEBUG_TEXT_CHARS = 160;

const MAX_PENDING_CAPTURES = 32;
const MAX_MIME_TYPES = 256;
const MAX_MIME_LENGTH = 1024;

function boundedMimes(mimes) {
    if (!Array.isArray(mimes) || mimes.length > MAX_MIME_TYPES)
        return false;
    for (const mime of mimes) {
        if (typeof mime !== 'string' || !mime.length || mime.length > MAX_MIME_LENGTH)
            return false;
    }
    return true;
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
    return `type=${type} chars=${value.length} value="${debugText(value)}"`;
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

// memory = Shell-owned (our own writes, screenshots, Mutter caches); everything else
// (Wayland / X11 clients) is a real external copy.
function sourceKindFromLabel(label) {
    if (label === '(source)')
        return 'unknown';
    return label.includes('SelectionSourceMemory') ? 'memory' : 'non-memory';
}

function uriListEntries(uriListText) {
    return uriListText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
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

export class Monitor {
    constructor({
        onCapture, onSuppressedRepeat, captureFiles, captureImages, maxItemBytes,
        maxTextBytes, maxBinaryBytes, secretMimes,
    } = {}) {
        this._onCapture = typeof onCapture === 'function' ? onCapture : (() => {});
        this._onSuppressedRepeat = typeof onSuppressedRepeat === 'function' ? onSuppressedRepeat : (() => {});
        this._captureFiles = captureFiles ?? (() => false);
        this._captureImages = captureImages ?? (() => false);
        this._maxItemBytes = maxItemBytes ?? (() => 16 * 1024 * 1024);
        this._maxTextBytes = maxTextBytes ?? this._maxItemBytes;
        this._maxBinaryBytes = maxBinaryBytes ?? this._maxItemBytes;
        this._secretMimes = secretMimes ?? (() => []);
        this._selection = null;
        this._ownerChangedId = 0;
        // Plain state shared with paste timers. Native owners stay in the signal callback.
        this.clipboardState = { active: false, version: 0, recordId: null };
        this._clipboardHasOwner = false;
        this._lastContent = null;     // { id, origin, sourceKind, source, type, value }
        this._queue = [];             // FIFO owner-change jobs
        this._nextJobSeq = 1;
        this._processing = false;
        this._imageReadFailures = 0;
        this._imageCaptureDisabled = false;
        this._stopped = true;
        this._work = null;
        this._scheduleRead = null;
        this._readScope = null;
        this._dropped = 0;
    }

    start() {
        if (!this._stopped)
            return;
        const work = new Completions();
        this._work = work;
        try {
            this._imageReadFailures = 0;
            this._imageCaptureDisabled = false;
            this._scheduleRead = work.onIdle('clipboard queue dispatch', () => this._startNext());
            this._selection = global.display.get_selection();
            this._ownerChangedId = this._selection.connect('owner-changed',
                work.onSignal('clipboard owner change', (_sel, selType, source) => this._onOwnerChanged(selType, source)));
            this.clipboardState.active = true;
            this._stopped = false;
            log.info('monitor started');
        } catch (e) {
            this.stop();
            log.error('monitor failed to start', e);
        }
    }

    stop() {
        if (this._stopped && !this._work && !this._selection)
            return;
        this._stopped = true;
        this.clipboardState.active = false;
        this.clipboardState.version++;
        this.clipboardState.recordId = null;
        this._clipboardHasOwner = false;
        const work = this._work;
        this._work = null;
        this._scheduleRead = null;
        work?.close();
        this.discardPendingReads('monitor stopped');
        this._processing = false;
        this._nextJobSeq = 1;
        log.debug(`monitor stopping queueCleared=yes lastContent=${this._lastContent ? 'yes' : 'no'}`);
        if (this._ownerChangedId) {
            try {
                this._selection?.disconnect(this._ownerChangedId);
            } catch (e) {
                log.error('monitor disconnect failed', e);
            }
            this._ownerChangedId = 0;
        }
        this._selection = null;
        this._lastContent = null;
        log.info('monitor stopped');
    }

    discardPendingReads(reason) {
        const queued = this._queue.length;
        this._queue.length = 0;
        const scope = this._readScope;
        this._readScope = null;
        scope?.close();
        if (queued || scope)
            log.debug(`[monitor]: retired pending captures reason=${reason} queued=${queued}`);
        this._reportDrops();
    }

    _reportDrops() {
        if (this._dropped)
            log.warn(`[monitor]: overload ended dropped=${this._dropped}`);
        this._dropped = 0;
    }

    beginClipboardWrite() {
        const clipboard = this.clipboardState;
        clipboard.recordId = null;
        return clipboard.active ? clipboard.version : null;
    }

    confirmClipboardWrite(before, recordId) {
        const clipboard = this.clipboardState;
        if (before !== null && clipboard.active && this._clipboardHasOwner && clipboard.version === before + 1) {
            clipboard.recordId = recordId;
            log.debug(`[paste]: clipboard write confirmed recordId=${recordId} version=${clipboard.version}`);
        }
    }

    // --- self-write / last-content state (see docs/03-clipboard/capture-pipeline.md) ---

    /** @returns {object|null} the current _lastContent snapshot. */
    getLastContent() {
        return this._lastContent;
    }

    /**
     * Record the last clipboard content we wrote (origin 'restore') or captured (origin
     * 'capture'). The drain side compares an incoming memory event against this to drop our
     * own restore echo or a stale memory replay. No TTL: every capture overwrites it.
     */
    setLastContent({ id, origin, sourceKind = null, source = null, type = null, value, clipboardVersion = null }) {
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
        const clipboard = this.clipboardState;
        if (clipboard.active && clipboardVersion === clipboard.version)
            clipboard.recordId = id;
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
        if (last.origin === 'history')
            return '';
        if (last.origin === 'restore') {
            // A file manager can cut the same URIs after our own file restore.
            return candidate.kind === 'file' && job.sourceKind === 'non-memory'
                ? 'same-last' : 'echo';
        }
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
            log.error(`${jobCtx(job)}: file path twin check skipped`, e);
            return false;
        }
    }

    _isRichPlainTwin(job, text) {
        try {
            if (job?.sourceKind !== 'memory' || typeof text !== 'string')
                return false;
            const last = this._lastContent;
            if (!comparableContent(last) || last.type !== 'rich')
                return false;
            return richComparablePlain(last.value) === text;
        } catch (e) {
            log.error(`${jobCtx(job)}: rich plain twin check skipped`, e);
            return false;
        }
    }

    _notifySuppressedRepeat(job, candidate, reason) {
        if (reason !== 'same-last')
            return;
        const clipboard = this.clipboardState;
        if (candidate.kind === 'file' && (job.sourceKind !== 'non-memory' ||
            !clipboard.active || job.clipboardVersion !== clipboard.version)) {
            log.debug(`${jobCtx(job)}: unconfirmed file repeat ignored`);
            return;
        }
        try {
            const recordId = this._onSuppressedRepeat({
                id: job.id,
                seq: job.seq,
                reason,
                kind: candidate.kind,
                mime: candidate.mime,
                value: candidate.value,
                sourceKind: job.sourceKind,
            });
            // Reuse the external file owner's offer, including its cut/copy action.
            if (candidate.kind === 'file' && typeof recordId === 'string' && recordId &&
                clipboard.active && clipboard.version === job.clipboardVersion) {
                clipboard.recordId = recordId;
                log.debug(`${jobCtx(job)}: repeated file confirmed recordId=${recordId} version=${clipboard.version}`);
            }
        } catch (e) {
            log.error('suppressed repeat notification failed', e);
        }
    }

    // --- enqueue side (producer): only snapshots sync fields and pushes ---

    _onOwnerChanged(selType, source) {
        if (this._stopped)
            return;

        try {
            // Only the CLIPBOARD selection is monitored (PRIMARY / middle-click capture removed).
            if (selType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
            const clipboard = this.clipboardState;
            clipboard.version++;
            clipboard.recordId = null;
            this._clipboardHasOwner = !!source;
            log.debug(`[paste]: clipboard version=${clipboard.version} owner=${source ? 'set' : 'cleared'}`);
            if (!source) {
                this.discardPendingReads('selection cleared');
                return;
            }

            this._queueRead(source, clipboard.version);
        } catch (e) {
            this.discardPendingReads('unreadable owner metadata');
            log.error('owner change ignored', e);
        }
    }

    _queueRead(source, clipboardVersion) {
        // Do not truncate a MIME list: its omitted tail may contain a privacy marker.
        const mimes = source.get_mimetypes();
        const secret = this._secretMimes();
        if (!boundedMimes(mimes) || !mimes.length || !boundedMimes(secret)) {
            this.discardPendingReads('unusable MIME metadata');
            log.warn('[monitor]: capture skipped; MIME metadata invalid or over limit');
            return;
        }
        if (mimes.some(mime => secret.includes(mime))) {
            this.discardPendingReads('concealed selection');
            log.debug('[monitor]: capture skipped reason=concealed');
            return;
        }

        const sourceLabel = debugSource(source);
        const maxItemBytes = this._maxItemBytes();
        const maxTextBytes = this._maxTextBytes();
        const maxBinaryBytes = this._maxBinaryBytes();
        if (![maxItemBytes, maxTextBytes, maxBinaryBytes].every(n => Number.isSafeInteger(n) && n >= 0)) {
            this.discardPendingReads('invalid capture limits');
            log.warn('[monitor]: capture skipped; invalid byte limit');
            return;
        }
        const job = {
            id: GLib.uuid_string_random(),
            seq: this._nextJobSeq++,
            clipboardVersion,
            sourceLabel,
            sourceKind: sourceKindFromLabel(sourceLabel),
            mimes: mimes.slice(),
            captureFiles: !!this._captureFiles(),
            captureImages: !!this._captureImages(),
            maxItemBytes,
            maxTextBytes,
            maxBinaryBytes,
        };
        if (!this.clipboardState.active || clipboardVersion !== this.clipboardState.version)
            return;
        if (this._queue.length >= MAX_PENDING_CAPTURES) {
            this._queue.shift();
            if (this._dropped === 0)
                log.warn(`[monitor]: capture queue full limit=${MAX_PENDING_CAPTURES}; dropping oldest pending job`);
            this._dropped++;
        }
        this._queue.push(job);
        log.debug(`${jobCtx(job)}: queue received/enqueued sourceKind=${job.sourceKind} queued=${this._queue.length}`);
        if (!this._processing)
            this._scheduleRead();
    }

    // One read starts per idle dispatch. Async continuations in capture-reader
    // only receive the job, its read scope and a scalar image-degradation flag.
    _startNext() {
        if (this._processing || this._stopped || !this._queue.length)
            return;
        const job = this._queue.shift();
        const scope = new ClipboardReadScope();
        this._readScope = scope;
        this._processing = true;
        const work = this._work;
        work.add('clipboard capture ' + jobCtx(job), readCapture(job, scope, this._imageCaptureDisabled), result => {
            try {
                if (result.ok && result.value && !scope.retired)
                    this._finishCapture(job, result.value);
            } finally {
                if (this._work === work) {
                    this._readScope = null;
                    this._processing = false;
                    if (this._queue.length)
                        this._scheduleRead();
                    else
                        this._reportDrops();
                }
            }
        });
    }

    _finishCapture(job, result) {
        if (result.imageFailure) {
            this._noteImageReadFailure(result.imageFailure);
            return;
        }
        const { record, value } = result;
        const { kind } = record;
        if (kind === 'image')
            this._imageReadFailures = 0;
        const candidate = { kind, mime: result.sourceMime ?? record.mime, value };
        let reason;
        if (kind === 'text' && this._isFilePathTwin(job, value))
            reason = 'file-path-twin';
        else if (kind === 'text' && this._isRichPlainTwin(job, value))
            reason = 'rich-plain-twin';
        else
            reason = this._dropReason(job, candidate);
        if (reason) {
            this._notifySuppressedRepeat(job, candidate, reason);
            log.debug(`${jobCtx(job)}: queue handled status=dropped kind=${kind} reason=${reason}`);
            return;
        }
        const scope = this._readScope;
        this._onCapture({ ...record, id: job.id, seq: job.seq });
        if (scope.retired)
            return;
        this.setLastContent({ id: job.id, origin: 'capture', sourceKind: job.sourceKind,
            source: job.sourceLabel, type: kind, value, clipboardVersion: job.clipboardVersion });
        log.debug(`${jobCtx(job)}: queue handled status=captured kind=${kind} mime=${record.mime} remaining=${this._queue.length}`);
    }

    _noteImageReadFailure(reason, mime) {
        if (reason === 'empty' || reason === 'oversize' || reason === 'busy' || reason === 'cancelled')
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
