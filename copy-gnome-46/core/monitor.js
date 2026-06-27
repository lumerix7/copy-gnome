import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { log } from './log.js';

// Watches Mutter's selection for clipboard-owner changes (the Wayland-correct way; no
// polling). Producer/consumer split: _onOwnerChanged (enqueue side) only snapshots the
// synchronously-available fields (sourceKind, mimes) and pushes a job; the drain loop
// (consumer side) reads the content, compares it against _lastContent, and either drops
// (self-write echo or stale memory replay) or captures.
//
// Candidate shapes handed to onCapture:
//   { kind: 'text',  id, seq, mime, text }
//   { kind: 'file',  id, seq, mime: 'text/uri-list', text }   // text = newline-joined uris
//   { kind: 'image', id, seq, mime, bytes }                   // bytes = JS-owned Uint8Array
//
// `id` is a uuid minted when the owner-changed is received; for a captured event it becomes
// the history record's id, so one id threads event -> record -> logs.
// See docs/features/clipboard-capture/clipboard-capture-design.md.

const FILE_ECHO_TTL_MS = 3000;
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
    return text
        .slice(0, DEBUG_TEXT_CHARS)
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t') + (text.length > DEBUG_TEXT_CHARS ? '...' : '');
}

function debugContent(type, value) {
    return `type=${type} bytes=${new TextEncoder().encode(value).length} value="${debugText(value)}"`;
}

function debugSource(source) {
    try {
        return String(source).slice(0, DEBUG_TEXT_CHARS);
    } catch (e) {
        return '(source)';
    }
}

// memory = Shell-owned (our own writes, screenshots, Mutter caches); everything else
// (Wayland / X11 clients) is a real external copy.
function sourceKindFromLabel(label) {
    return label.includes('SelectionSourceMemory') ? 'memory' : 'non-memory';
}

function uriListEntries(uriListText) {
    return uriListText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
}

// Canonical form for a uri-list: drop CRs/blank lines and trim each entry. Used as the
// file entry's stored content and for matching a later text/plain path twin.
function normalizeUriList(text) {
    return text
        .split('\n')
        .map(line => line.replace(/\r$/, '').trim())
        .filter(Boolean)
        .join('\n');
}

function normalizeSpecialCopiedFiles(text) {
    const lines = text
        .split('\n')
        .map(line => line.replace(/\r$/, '').trim())
        .filter(Boolean);
    if (lines.length > 0 && ['copy', 'cut'].includes(lines[0]))
        lines.shift();
    return normalizeUriList(lines.join('\n'));
}

function filePathText(uriListText) {
    const paths = [];
    for (const line of uriListEntries(uriListText)) {
        if (!line.startsWith('file://')) {
            paths.push(line);
            continue;
        }
        try {
            paths.push(decodeURIComponent(line.replace(/^file:\/\//, '')));
        } catch (e) {
            log.debug(`file path decode failed uri="${debugText(line)}": ${e.message}`);
        }
    }
    return paths.join('\n');
}

// Every string form by which a file copy's follow-up text/plain owner-changed can refer to
// the same files: each file:// URI, each decoded bare path (GTK's text/plain fallback is
// the plain path, e.g. /home/u/x), and the newline-join of the bare paths for multi-file
// copies. Used to recognize that a text capture is a file copy's twin.
function fileEchoKeys(uriListText) {
    const keys = new Set();
    const paths = [];
    for (const line of uriListText.split('\n').map(l => l.trim()).filter(Boolean)) {
        keys.add(line);
        if (line.startsWith('file://')) {
            try {
                const p = decodeURIComponent(line.replace(/^file:\/\//, ''));
                keys.add(p);
                paths.push(p);
            } catch (e) {
                // Malformed percent-encoding: the URI form above is still a usable key.
            }
        }
    }
    if (paths.length > 1)
        keys.add(paths.join('\n'));
    return keys;
}

export class Monitor {
    constructor({
        onCapture, captureFiles, captureImages, maxItemBytes,
        maxBinaryBytes, secretMimes,
    } = {}) {
        this._onCapture = typeof onCapture === 'function' ? onCapture : (() => {});
        this._captureFiles = captureFiles ?? (() => false);
        this._captureImages = captureImages ?? (() => false);
        this._maxItemBytes = maxItemBytes ?? (() => 16 * 1024 * 1024);
        this._maxBinaryBytes = maxBinaryBytes ?? this._maxItemBytes;
        this._secretMimes = secretMimes ?? (() => []);
        this._selection = null;
        this._ownerChangedId = 0;
        this._lastContent = null;     // { id, origin, sourceKind, source, type, value }
        this._lastFile = null;        // { uriList, keys, pathText, seq, timeoutId } for file text/plain twin
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
        this._clearLastFile();
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
        this._lastContent = {
            id: id ?? GLib.uuid_string_random(),
            origin,
            sourceKind,
            source,
            type,
            value,
        };
        log.debug(`last content set id=${this._lastContent.id} origin=${origin} sourceKind=${sourceKind} ${debugContent(type, value ?? '')}`);
        return this._lastContent;
    }

    /** Roll back to `backup` iff the current _lastContent is still a restore marker. */
    setLastContentIfIs(backup) {
        if (this._lastContent?.origin === 'restore') {
            log.debug(`last content rolled back from origin=restore to ${backup ? `origin=${backup.origin}` : 'null'}`);
            this._lastContent = backup ?? null;
        }
    }

    /**
     * Drop reason for `candidate` produced by `job`, else ''. A memory event whose content
     * (type + value) matches _lastContent is our own write-back echo (origin 'restore') or a
     * stale memory replay (origin 'capture'). Non-memory events are never dropped here, so
     * ordinary repeated copies are not deduped.
     */
    _dropReason(job, candidate) {
        const last = this._lastContent;
        if (job.sourceKind === 'memory' && last &&
                candidate.kind === last.type && candidate.value === last.value)
            return last.origin === 'restore' ? 'echo' : 'stale-replay';
        return '';
    }

    // --- file text/plain twin window ---

    /** Remember, for FILE_ECHO_TTL_MS, that a file copy's text/plain twin may follow. */
    _rememberLastFile(uriListText, seq) {
        if (typeof uriListText !== 'string' || uriListText.length === 0)
            return;
        this._clearLastFile();
        const pathText = filePathText(uriListText);
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILE_ECHO_TTL_MS, () => {
            if (this._lastFile?.timeoutId !== timeoutId)
                return GLib.SOURCE_REMOVE;
            this._lastFile = null;
            if (!this._stopped && pathText) {
                const id = GLib.uuid_string_random();
                log.debug(`file twin window expired; synthesizing path id=${id} seq=${seq} bytes=${new TextEncoder().encode(pathText).length} uriCount=${uriListEntries(uriListText).length} path="${debugText(pathText)}" uriList="${debugText(uriListText)}"`);
                this._onCapture({
                    kind: 'text',
                    id,
                    seq,
                    mime: 'text/plain;charset=utf-8',
                    text: pathText,
                    fileTwinUriList: uriListText,
                    synthesizedFilePath: true,
                });
            } else {
                log.debug(`file twin window expired; no path synthesized stopped=${this._stopped ? 'yes' : 'no'} uriCount=${uriListEntries(uriListText).length} uriList="${debugText(uriListText)}"`);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._lastFile = {
            uriList: uriListText,
            keys: fileEchoKeys(uriListText),
            pathText,
            seq,
            timeoutId,
        };
        log.debug(`file twin window armed ttlMs=${FILE_ECHO_TTL_MS} seq=${seq} uriCount=${uriListEntries(uriListText).length} path="${debugText(pathText)}" uriList="${debugText(uriListText)}"`);
    }

    _clearLastFile() {
        if (this._lastFile?.timeoutId) {
            const uriList = this._lastFile.uriList;
            try {
                GLib.Source.remove(this._lastFile.timeoutId);
            } catch (e) {
                log.debug(`file echo timer cleanup failed: ${e.message}`);
            }
            log.debug(`file twin window cleared uriCount=${uriListEntries(uriList).length} uriList="${debugText(uriList)}"`);
        }
        this._lastFile = null;
    }

    /** @returns {string|null} the file copy's uri-list if `text` is its twin, else null. */
    _consumeLastFileMatch(text) {
        if (!this._lastFile) {
            log.debug(`file twin check miss reason=no-window text="${debugText(text)}"`);
            return null;
        }
        if (!this._lastFile.keys.has(text.trim())) {
            log.debug(`file twin check miss reason=not-same-path text="${debugText(text)}" uriList="${debugText(this._lastFile.uriList)}"`);
            this._clearLastFile();
            return null;
        }
        const uriList = this._lastFile.uriList;
        this._clearLastFile();
        log.debug(`file twin check hit text="${debugText(text)}" uriList="${debugText(uriList)}"`);
        return uriList;
    }

    _readSourceMimes(source) {
        try {
            return (source.get_mimetypes() ?? []).filter(m => typeof m === 'string');
        } catch (e) {
            return [];
        }
    }

    /** Capture a file uri-list, arming the echo window so its text/plain twin is recognized. */
    _captureFile(text, id, seq) {
        this._rememberLastFile(text, seq);
        log.debug(`capture file id=${id} seq=${seq} bytes=${new TextEncoder().encode(text).length} uriCount=${uriListEntries(text).length} uriList="${debugText(text)}"`);
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
        const job = {
            id,
            seq,
            source,
            sourceLabel,
            sourceKind: sourceKindFromLabel(sourceLabel),
            mimes: this._readSourceMimes(source),
        };
        this._queue.push(job);
        log.debug(`queue received/enqueued id=${id} seq=${seq} sourceKind=${job.sourceKind} source=${sourceLabel} queued=${this._queue.length} running=${this._processing ? 'yes' : 'no'}`);
        if (!this._processing)
            this._drain().catch(e => log.warn(`read failed: ${e.message}`));
    }

    // --- drain side (consumer): reads content, decides, captures ---

    async _drain() {
        if (this._processing)
            return;
        this._processing = true;
        log.debug('queue drain start');
        try {
            while (this._queue.length > 0 && !this._stopped) {
                const job = this._queue.shift();
                log.debug(`queue dequeued/handling id=${job.id} seq=${job.seq} sourceKind=${job.sourceKind} source=${job.sourceLabel} remaining=${this._queue.length}`);
                await this._readOnce(job);
            }
        } finally {
            this._processing = false;
            log.debug(`queue drain stop remaining=${this._queue.length}`);
        }
    }

    async _readOnce(job) {
        try {
            const mimes = job.mimes;
            log.debug(`source id=${job.id} seq=${job.seq} mimes=${mimes.join(',') || '(none)'}`);
            if (this._stopped) {
                log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped reason=stopped remaining=${this._queue.length}`);
                return;
            }

            const has = m => mimes.includes(m);

            // Privacy: skip password-manager / concealed selections.
            const secret = this._secretMimes();
            if (secret.length && mimes.some(m => secret.includes(m))) {
                this._clearLastFile();
                log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped reason=concealed remaining=${this._queue.length}`);
                return;
            }

            const imageMime = supportedImageMime(mimes);
            const hasUnsupportedImage = !imageMime && mimes.some(m => m.startsWith('image/'));
            const plainMime = textMime(mimes);

            if (has('text/uri-list') || has('x-special/gnome-copied-files')) {
                if (!this._captureFiles()) {
                    this._clearLastFile();
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=file reason=disabled remaining=${this._queue.length}`);
                    return;
                }
                const mime = has('text/uri-list') ? 'text/uri-list' : 'x-special/gnome-copied-files';
                const result = await this._readSourceBytes(job.source, mime, this._maxItemBytes());
                if (this._stopped) return;
                if (!result.ok) {
                    this._clearLastFile();
                    log.warn(`file clipboard read skipped (${mime}, ${result.reason})`);
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=file mime=${mime} reason=${result.reason} remaining=${this._queue.length}`);
                    return;
                }
                log.debug(`source read file id=${job.id} seq=${job.seq} mime=${mime} bytes=${result.bytes.length}`);
                const rawText = new TextDecoder().decode(result.bytes);
                const text = mime === 'x-special/gnome-copied-files'
                    ? normalizeSpecialCopiedFiles(rawText)
                    : normalizeUriList(rawText);
                if (text) {
                    const candidate = { kind: 'file', mime: 'text/uri-list', value: text };
                    const dropReason = this._dropReason(job, candidate);
                    if (dropReason) {
                        this._clearLastFile();
                        log.debug(`queue handled id=${job.id} seq=${job.seq} status=dropped kind=file mime=text/uri-list reason=${dropReason} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                        return;
                    }
                    const uriCount = uriListEntries(text).length;
                    this._captureFile(text, job.id, job.seq);
                    this.setLastContent({ id: job.id, origin: 'capture', sourceKind: job.sourceKind, source: job.sourceLabel, type: 'file', value: text });
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=captured kind=file mime=text/uri-list bytes=${result.bytes.length} uriCount=${uriCount} remaining=${this._queue.length}`);
                } else {
                    this._clearLastFile();
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=file mime=${mime} reason=empty remaining=${this._queue.length}`);
                }
                return;
            }

            // Prefer text when offered; many apps offer both text and image targets.
            if (plainMime) {
                const result = await this._readSourceBytes(job.source, plainMime, this._maxItemBytes());
                if (this._stopped) return;
                if (!result.ok) {
                    this._clearLastFile();
                    log.warn(`text clipboard read skipped (${plainMime}, ${result.reason})`);
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=text mime=${plainMime} reason=${result.reason} remaining=${this._queue.length}`);
                    return;
                }
                log.debug(`source read text id=${job.id} seq=${job.seq} mime=${plainMime} bytes=${result.bytes.length}`);
                const text = new TextDecoder().decode(result.bytes);
                if (text && text.length > 0) {
                    log.debug(`source text id=${job.id} seq=${job.seq} value="${debugText(text)}"`);
                    const candidate = { kind: 'text', mime: plainMime, value: text };
                    const dropReason = this._dropReason(job, candidate);
                    if (dropReason) {
                        this._clearLastFile();
                        log.debug(`queue handled id=${job.id} seq=${job.seq} status=dropped kind=text mime=${plainMime} reason=${dropReason} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                        return;
                    }
                    // A file copy fires a follow-up owner-changed exposing only its text/plain
                    // fallback (the bare path). Keep it as a normal text entry so pasting the
                    // path into editors still works. If it matches a just-captured file (same
                    // path, within the echo window), extension.js promotes the file back above
                    // the path and this consumes the pending window so no synthetic path is
                    // created later.
                    const twinUriList = this._consumeLastFileMatch(text);
                    const twinLog = twinUriList
                        ? `plainFileTwin=yes fileUriCount=${uriListEntries(twinUriList).length} fileUriList="${debugText(twinUriList)}"`
                        : 'plainFileTwin=no';
                    log.debug(`capture text id=${job.id} seq=${job.seq} bytes=${result.bytes.length} ${twinLog}`);
                    this._onCapture(twinUriList
                        ? { kind: 'text', id: job.id, seq: job.seq, mime: 'text/plain;charset=utf-8', text, fileTwinUriList: twinUriList }
                        : { kind: 'text', id: job.id, seq: job.seq, mime: 'text/plain;charset=utf-8', text });
                    this.setLastContent({ id: job.id, origin: 'capture', sourceKind: job.sourceKind, source: job.sourceLabel, type: 'text', value: text });
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=captured kind=text mime=${plainMime} bytes=${result.bytes.length} ${twinLog} remaining=${this._queue.length}`);
                    return;
                }
                this._clearLastFile();
                log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=text mime=${plainMime} reason=empty remaining=${this._queue.length}`);
            }

            this._clearLastFile();
            if (imageMime || hasUnsupportedImage) {
                if (!this._captureImages()) {
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=image reason=disabled remaining=${this._queue.length}`);
                    return;
                }
                if (this._imageCaptureDisabled) {
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=image reason=disabled-after-failures remaining=${this._queue.length}`);
                    return;
                }
                if (!imageMime) {
                    log.warn('skipping image selection; no supported image/png target');
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=image reason=unsupported-mime remaining=${this._queue.length}`);
                    return;
                }
                const maxBytes = this._maxBinaryBytes();
                if (maxBytes <= 0) {
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=image reason=binary-cap-zero remaining=${this._queue.length}`);
                    return;
                }
                const result = await this._readSourceBytes(job.source, imageMime, maxBytes);
                if (this._stopped) return;
                if (!result.ok) {
                    this._noteImageReadFailure(result.reason, imageMime);
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped kind=image mime=${imageMime} reason=${result.reason} remaining=${this._queue.length}`);
                    return;
                }
                log.debug(`source read image id=${job.id} seq=${job.seq} mime=${imageMime} bytes=${result.bytes.length}`);
                const data = GLib.base64_encode(result.bytes);
                const dropReason = this._dropReason(job, { kind: 'image', mime: imageMime, value: data });
                if (dropReason) {
                    log.debug(`queue handled id=${job.id} seq=${job.seq} status=dropped kind=image mime=${imageMime} reason=${dropReason} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                    return;
                }
                this._imageReadFailures = 0;
                this._onCapture({ kind: 'image', id: job.id, seq: job.seq, mime: imageMime, bytes: result.bytes });
                this.setLastContent({ id: job.id, origin: 'capture', sourceKind: job.sourceKind, source: job.sourceLabel, type: 'image', value: data });
                log.debug(`queue handled id=${job.id} seq=${job.seq} status=captured kind=image mime=${imageMime} bytes=${result.bytes.length} remaining=${this._queue.length}`);
                return;
            }
            log.debug(`queue handled id=${job.id} seq=${job.seq} status=skipped reason=unsupported-mime remaining=${this._queue.length}`);
        } catch (e) {
            log.warn(`read failed: ${e.message}`);
            log.debug(`queue handled id=${job.id} seq=${job.seq} status=failed reason=exception remaining=${this._queue.length}`);
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
            return { ok: false, bytes: null, reason: 'oversize' };
        const opened = await this._readSourceStream(source, mime);
        if (!opened.ok)
            return { ok: false, bytes: null, reason: opened.reason };
        const stream = opened.stream;
        if (!stream)
            return { ok: false, bytes: null, reason: 'empty' };
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
                    return { ok: false, bytes: null, reason: 'oversize' };
                chunks.push(Uint8Array.from(data));
            }
        } catch (e) {
            log.warn(`selection source ${mime} stream read failed: ${e.message}`);
            return { ok: false, bytes: null, reason: 'read-error' };
        } finally {
            await this._closeStream(stream);
        }
        if (total <= 0)
            return { ok: false, bytes: null, reason: 'empty' };
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return { ok: true, bytes: out, reason: '' };
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
