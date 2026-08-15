import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { log } from './log.js';
import { MAX_SNAPSHOT_LINE_BYTES, historyWriterBusy, waitForHistoryWriter, writeHistorySnapshot } from './history-writer.js';
import {
    PLAIN_TEXT_MIME,
    RICH_TEXT_MIMES,
    URI_LIST_MIME,
    binaryPayload,
    payloadBytesTotal,
    plainTextPayload,
    primaryPayload,
    richPayload,
    uriListPayload,
} from './payloads.js';

// Append-only daily JSONL store. See docs/04-storage/README.md.
//
// Layout under <dataDir>:
//   clips-YYYYMMDD.jsonl   append-only, one full sorted history snapshot per line
//   tmp/                   reserved for future doctor/repair tooling
//
// The Shell extension never rewrites, truncates, compacts, or repairs the *contents* of clips
// files, and never touches the in-memory history model from here. It DOES delete whole expired
// daily files via sweepOldFiles() (a bounded retention sweep that runs only after history load,
// never during disable()/teardown). Startup can recover an earlier intact snapshot
// without modifying the file.

Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.File.prototype, 'set_attributes_async', 'set_attributes_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');

const DAY_MICROS = 86400 * 1e6;
const RECOVERY_LINES = 10;
const RECOVERY_BYTES = 2 * MAX_SNAPSHOT_LINE_BYTES + RECOVERY_LINES;
const STORE_IO_TIMEOUT_SEC = 5;
const DIRECTORY_BATCH = 64;
const MAX_DIRECTORY_ENTRIES = 16384;
const PRIORITY = GLib.PRIORITY_DEFAULT;
const decoder = new TextDecoder('utf-8', { fatal: true });
const activeIo = new Set();

function ioError(error, code) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, code);
}

// Resolve on cancellation, but keep the slot until native I/O actually settles.
// The operation only receives its own cancellable, paths and snapshot data.
function runStoreIo(dir, stage, cancels, operation) {
    const slot = `${stage} ${dir}`;
    if (activeIo.has(slot)) {
        log.warn(`[store]: ${stage} skipped; previous request still active`);
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        const request = new Gio.Cancellable();
        let deadline = 0;
        let finished = false;
        const finish = result => {
            if (finished)
                return;
            finished = true;
            cancels.delete(cancel);
            if (deadline) {
                try {
                    GLib.Source.remove(deadline);
                } catch (error) {
                    log.error(`[store]: ${stage} deadline cleanup`, error);
                }
            }
            log.debug(`[store]: ${stage} finished status=${result === null ? 'unavailable' : 'complete'}`);
            resolve(result);
        };
        const cancel = () => {
            if (finished)
                return;
            log.debug(`[store]: ${stage} cancelling`);
            finish(null);
            try {
                request.cancel();
            } catch (error) {
                log.error(`[store]: ${stage} cancellation`, error);
            }
        };
        deadline = GLib.timeout_add_seconds(PRIORITY, STORE_IO_TIMEOUT_SEC, () => {
            deadline = 0;
            log.warn(`[store]: ${stage} timed out after ${STORE_IO_TIMEOUT_SEC}s`);
            cancel();
            return GLib.SOURCE_REMOVE;
        });
        activeIo.add(slot);
        cancels.add(cancel);
        log.debug(`[store]: ${stage} started`);
        const complete = (result, error = null) => {
            activeIo.delete(slot);
            if (finished)
                log.debug(`[store]: ${stage} cancelled request settled`);
            if (error && !request.is_cancelled())
                log.error(`[store]: ${stage}`, error);
            finish(result);
        };
        void Promise.resolve().then(() => {
            request.set_error_if_cancelled();
            return operation(request);
        }).then(result => complete(result), error => complete(null, error));
    });
}

async function ensureDirectory(file, request) {
    request.set_error_if_cancelled();
    try {
        await file.make_directory_async(PRIORITY, request);
    } catch (error) {
        if (!ioError(error, Gio.IOErrorEnum.EXISTS))
            throw error;
        return;
    }
    request.set_error_if_cancelled();
    const info = new Gio.FileInfo();
    info.set_attribute_uint32('unix::mode', 0o700);
    await file.set_attributes_async(info, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, request);
}

function clipDateNameFromMicros(micros) {
    const seconds = Math.floor((Number(micros) || GLib.get_real_time()) / 1000000);
    const dt = GLib.DateTime.new_from_unix_local(seconds);
    return `clips-${dt.format('%Y%m%d')}.jsonl`;
}

function currentClipName() {
    return clipDateNameFromMicros(GLib.get_real_time());
}

async function listClipNames(dir, request) {
    request.set_error_if_cancelled();
    log.debug(`[store]: scanning directory ${dir}`);
    const en = await Gio.File.new_for_path(dir)
        .enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, PRIORITY, request);
    const names = [];
    try {
        let count = 0;
        while (true) {
            request.set_error_if_cancelled();
            const entries = await en.next_files_async(DIRECTORY_BATCH, PRIORITY, request);
            request.set_error_if_cancelled();
            count += entries.length;
            if (count > MAX_DIRECTORY_ENTRIES)
                throw new Error(`history directory exceeds ${MAX_DIRECTORY_ENTRIES} entries`);
            if (entries.length === 0)
                break;
            for (const entry of entries) {
                const name = entry.get_name();
                if (isClipFileName(name))
                    names.push(name);
            }
        }
    } finally {
        try {
            await en.close_async(PRIORITY, null);
        } catch (error) {
            log.error('[store]: directory enumerator cleanup', error);
        }
    }
    log.debug(`[store]: directory scan finished clips=${names.length}`);
    return names;
}

function isClipFileName(name) {
    return /^clips-\d{8}\.jsonl$/.test(name);
}

// Parse the YYYYMMDD date from a clips filename into a local-midnight GLib.DateTime, or null.
function clipDateFromName(name) {
    const m = /^clips-(\d{4})(\d{2})(\d{2})\.jsonl$/.exec(name);
    if (!m) return null;
    return GLib.DateTime.new_local(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0);
}

// Whole days between a clips filename's date and `now`, or null if the name doesn't parse.
// Shared by sweepOldFiles() (which files are old enough to delete) and open() (whether a
// fallback file it just recovered is already within that same deletion window).
function clipAgeDays(name, now) {
    const fileDay = clipDateFromName(name);
    if (!fileDay)
        return null;
    return Math.floor(now.difference(fileDay) / DAY_MICROS);
}

function clipPath(dir, name) {
    return GLib.build_filenamev([dir, name]);
}

function normalizePayload(obj) {
    if (!obj || typeof obj !== 'object')
        return null;
    if (typeof obj.mime !== 'string' || obj.mime.length === 0)
        return null;
    if (!['utf8', 'uri-list', 'base64'].includes(obj.encoding))
        return null;
    if (typeof obj.value !== 'string')
        return null;
    if (typeof obj.bytes !== 'number' || obj.bytes < 0)
        return null;
    return {
        mime: obj.mime,
        encoding: obj.encoding,
        value: obj.value,
        bytes: obj.bytes,
    };
}

function normalizePayloads(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 8)
        return null;
    const out = [];
    for (const item of value) {
        const payload = normalizePayload(item);
        if (!payload)
            return null;
        out.push(payload);
    }
    return out;
}

function validKindPayloads(rec) {
    const primary = primaryPayload(rec);
    if (!primary || rec.mime !== primary.mime)
        return false;
    if (rec.kind === 'text')
        return !!plainTextPayload(rec);
    if (rec.kind === 'rich')
        return !!richPayload(rec) && !!plainTextPayload(rec);
    if (rec.kind === 'file')
        return primary.mime === URI_LIST_MIME && primary.encoding === 'uri-list' &&
            !!uriListPayload(rec);
    if (rec.kind === 'image' || rec.kind === 'binary')
        return primary.encoding === 'base64' && !!binaryPayload(rec);
    return false;
}

function normalizeContentIdentity(obj) {
    if (Number.isInteger(obj?.contentBytes) && obj.contentBytes >= 0 &&
            typeof obj.contentSha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(obj.contentSha256)) {
        return {
            contentBytes: obj.contentBytes,
            contentSha256: obj.contentSha256,
        };
    }
    return null;
}

function normalizeRecord(obj) {
    if (!obj || typeof obj !== 'object')
        return null;
    if (typeof obj.id !== 'string')
        return null;
    if (!['text', 'rich', 'file', 'image', 'binary'].includes(obj.kind))
        return null;
    if (typeof obj.mime !== 'string')
        return null;
    if (typeof obj.bytes !== 'number' || obj.bytes < 0)
        return null;
    if (typeof obj.createdAt !== 'number' || typeof obj.usedAt !== 'number')
        return null;
    const payloads = normalizePayloads(obj.payloads);
    if (!payloads)
        return null;

    const identity = normalizeContentIdentity(obj);
    if (!identity)
        return null;
    const rec = {
        id: obj.id,
        kind: obj.kind,
        mime: obj.mime,
        bytes: obj.bytes,
        createdAt: obj.createdAt,
        usedAt: obj.usedAt,
        payloads,
        ...identity,
    };

    if (!validKindPayloads(rec))
        return null;
    if (rec.kind === 'text' && rec.mime !== PLAIN_TEXT_MIME && !rec.mime.startsWith('text/plain'))
        return null;
    if (rec.kind === 'rich' && !RICH_TEXT_MIMES.includes(rec.mime))
        return null;
    if (payloadBytesTotal(rec.payloads) > rec.bytes)
        log.debug(`[store]: record bytes lower than payload sum id=${rec.id} bytes=${rec.bytes} payloadBytes=${payloadBytesTotal(rec.payloads)}`);

    return rec;
}

function sortRecords(records) {
    return records.slice().sort((a, b) => b.usedAt - a.usedAt);
}

function normalizeSnapshot(obj) {
    if (!obj || obj.type !== 'history' || !Number.isFinite(obj.writtenAt) ||
            !Array.isArray(obj.items))
        return null;

    const out = [];
    const seenIds = new Set();
    for (const item of obj.items) {
        const rec = normalizeRecord(item);
        if (!rec || seenIds.has(rec.id))
            return null;
        seenIds.add(rec.id);
        out.push(rec);
    }
    return sortRecords(out);
}

function parseCandidate(path, distance, parts, size) {
    if (!size || size > MAX_SNAPSHOT_LINE_BYTES) {
        log.warn(`[store]: snapshot skipped path=${path} tailLine=${distance} bytes=${size}`);
        return null;
    }
    log.debug(`[store]: checking snapshot path=${path} tailLine=${distance} bytes=${size}`);
    try {
        // The file was read backwards. Assemble the candidate once, then parse it.
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (let i = parts.length - 1; i >= 0; i--) {
            bytes.set(parts[i], offset);
            offset += parts[i].length;
        }
        const records = normalizeSnapshot(JSON.parse(decoder.decode(bytes)));
        if (records === null)
            log.warn(`[store]: snapshot schema invalid path=${path} tailLine=${distance}`);
        else if (distance > 1)
            log.info(`[store]: recovered previous line path=${path} tailLine=${distance} records=${records.length}`);
        return records;
    } catch (error) {
        log.error(`[store]: invalid snapshot path=${path} tailLine=${distance}`, error);
        return null;
    }
}

async function readChunk(stream, start, count, request) {
    request.set_error_if_cancelled();
    stream.seek(start, GLib.SeekType.SET, request);
    const bytes = new Uint8Array(count);
    for (let offset = 0; offset < count;) {
        request.set_error_if_cancelled();
        const part = (await stream.read_bytes_async(count - offset, PRIORITY, request)).get_data();
        if (!part.length)
            throw new Error('history file shortened while reading');
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}

async function readSnapshot(path, budget, request) {
    request.set_error_if_cancelled();
    const file = Gio.File.new_for_path(path);
    let info;
    try {
        info = await file.query_info_async('standard::type,standard::size',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, request);
    } catch (error) {
        if (ioError(error, Gio.IOErrorEnum.NOT_FOUND))
            return { exists: false, records: null };
        throw error;
    }
    request.set_error_if_cancelled();
    const size = info.get_size();
    if (info.get_file_type() !== Gio.FileType.REGULAR || !size) {
        log.warn(`[store]: snapshot file is empty or non-regular path=${path}`);
        return { exists: true, records: null };
    }

    const stream = await file.read_async(PRIORITY, request);
    try {
        let pos = size;
        let length = 0;
        let parts = [];
        let distance = 0;
        const takeCandidate = () => {
            budget.lines--;
            const records = parseCandidate(path, ++distance, parts, length);
            length = 0;
            parts = [];
            return records;
        };
        while (pos > 0 && budget.bytes > 0 && budget.lines > 0) {
            const count = Math.min(256 * 1024, pos, budget.bytes);
            const chunk = await readChunk(stream, pos - count, count, request);
            request.set_error_if_cancelled();
            let end = count;
            if (pos === size && chunk[count - 1] === 0x0a)
                end--;
            pos -= count;
            budget.bytes -= count;
            while (end > 0 && budget.lines > 0) {
                const delimiter = chunk.lastIndexOf(0x0a, end - 1);
                const part = chunk.subarray(delimiter + 1, end);
                length += part.length;
                if (length > MAX_SNAPSHOT_LINE_BYTES)
                    parts = [];
                else if (part.length)
                    parts.push(part);
                if (delimiter < 0)
                    break;
                const records = takeCandidate();
                if (records !== null)
                    return { exists: true, records };
                end = delimiter;
                // Give the Shell a turn before trying another complete candidate.
                await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
                request.set_error_if_cancelled();
            }
        }
        const records = pos === 0 && budget.lines > 0 ? takeCandidate() : null;
        if (records === null)
            log.warn(`[store]: no intact snapshot in scan path=${path} checked=${distance} linesLeft=${budget.lines} bytesLeft=${budget.bytes}`);
        return { exists: true, records };
    } finally {
        try {
            await stream.close_async(PRIORITY, null);
        } catch (error) {
            log.error('[store]: snapshot reader cleanup', error);
        }
    }
}

async function loadHistory(dir, current, request) {
    const folder = Gio.File.new_for_path(dir);
    await ensureDirectory(folder, request);
    await ensureDirectory(folder.get_child('tmp'), request);
    const todayPath = clipPath(dir, current);
    if (!await waitForHistoryWriter(todayPath))
        return null;
    const budget = { lines: RECOVERY_LINES, bytes: RECOVERY_BYTES };
    const today = await readSnapshot(todayPath, budget, request);
    if (today.records !== null)
        return { name: current, records: today.records };
    if (!budget.lines || !budget.bytes) {
        log.warn('[store]: snapshot recovery limit reached');
        return null;
    }
    const names = await listClipNames(dir, request);
    const older = names.filter(name => name !== current).sort().at(-1);
    if (!older)
        return today.exists ? null : { name: null, records: [] };
    const path = clipPath(dir, older);
    log.debug(`[store]: trying previous daily file path=${path}`);
    if (!await waitForHistoryWriter(path))
        return null;
    const previous = await readSnapshot(path, budget, request);
    return previous.records === null ? null : { name: older, records: previous.records };
}

async function sweepFiles(dir, maxAgeDays, protectedFallback, request) {
    const now = GLib.DateTime.new_now_local();
    const names = await listClipNames(dir, request);
    for (const name of names) {
        request.set_error_if_cancelled();
        const ageDays = clipAgeDays(name, now);
        if (ageDays === null) {
            log.warn(`[store]: cleanup skip unparsable name=${name}`);
            continue;
        }
        if (ageDays <= maxAgeDays)
            continue;
        if (name === protectedFallback) {
            log.warn(`[store]: keeping ${name} until a newer snapshot is saved`);
            continue;
        }
        const path = clipPath(dir, name);
        if (historyWriterBusy(path))
            continue;
        try {
            await Gio.File.new_for_path(path).delete_async(PRIORITY, request);
            log.info(`[store]: cleanup deleted ${path} ageDays=${ageDays}`);
        } catch (error) {
            request.set_error_if_cancelled();
            log.error(`[store]: cleanup delete failed path=${path}`, error);
        }
    }
    return true;
}

export class Store {
    constructor({ dataDir, onTrim, onNewDailyFile }) {
        this._dir = GLib.canonicalize_filename(dataDir, null);
        this._onTrim = onTrim ?? (() => {});
        this._onNewDailyFile = onNewDailyFile ?? (() => {});
        this._cancelIo = new Set();
        this._pending = null;
        this._flushing = null;
        this._closeWork = null;
        this._writePaused = false;
        this._closed = false;
        this._degraded = false;
        this._sweeping = false;
        this._retryNewDailySweep = false;
        this._protectedFallback = null;
        this._recoveredFromOlderFile = false;
        this._recoveredFileAgeDays = null;
    }

    // True once open() has returned a non-empty snapshot loaded from a daily file other than
    // today's. That file becomes a sweep
    // candidate as soon as its age (recoveredFileAgeDays) reaches history.maxAgeDays, so the
    // caller must give the recovered snapshot a durable copy in today's file before that
    // happens - see extension.js's _rehomeRecoveredSnapshot() and docs/04-storage/lifecycle.md.
    get recoveredFromOlderFile() {
        return this._recoveredFromOlderFile;
    }

    // Age in whole days (by filename date, as of the open() call) of the file
    // recoveredFromOlderFile refers to; null when recoveredFromOlderFile is false.
    get recoveredFileAgeDays() {
        return this._recoveredFileAgeDays;
    }

    async open() {
        if (this._closed)
            return [];
        const dir = this._dir;
        const current = currentClipName();
        let result = null;
        try {
            result = await runStoreIo(dir, 'history startup', this._cancelIo,
                request => loadHistory(dir, current, request));
        } catch (error) {
            log.error('[store]: history startup setup', error);
        }
        if (this._closed)
            return [];
        if (result === null) {
            this._writePaused = true;
            log.warn('[store]: history recovery unavailable; using memory-only history this session');
            return [];
        }
        const { name, records } = result;
        log.info(`[store]: opened ${records.length} records source=${name ?? '(new history)'} dir=${dir}`);
        if (name && name !== current && records.length > 0) {
            this._protectedFallback = name;
            this._recoveredFromOlderFile = true;
            this._recoveredFileAgeDays = clipAgeDays(name, GLib.DateTime.new_now_local());
            log.info(`[store]: recovered older snapshot name=${name} ageDays=${this._recoveredFileAgeDays}`);
        }
        return records;
    }

    appendSnapshot(records, gen = 0) {
        if (this._closed || this._writePaused)
            return;
        // Keep only the latest unwritten snapshot. Detach its metadata before
        // starting the writer so later history edits cannot change the batch.
        this._pending = { target: currentClipName(), records, gen };
        log.debug(`[store]: pending snapshot queued target=${this._pending.target} records=${records.length} gen=${gen}`);
    }

    _snapshotItem(rec) {
        const identity = normalizeContentIdentity(rec);
        if (!identity)
            throw new Error(`invalid history content identity id=${rec?.id ?? '(none)'}`);
        const item = {
            id: rec.id,
            kind: rec.kind,
            mime: rec.mime,
            bytes: rec.bytes ?? 0,
            createdAt: rec.createdAt,
            usedAt: rec.usedAt,
            payloads: Array.isArray(rec.payloads) ? rec.payloads.map(p => ({
                mime: p.mime,
                encoding: p.encoding,
                value: p.value,
                bytes: p.bytes,
            })) : [],
            ...identity,
        };
        return item;
    }

    flush() {
        if (this._writePaused)
            return Promise.resolve('failed');
        if (this._closed)
            return Promise.resolve('idle');
        const batch = this._pending;
        const path = batch && clipPath(this._dir, batch.target);
        if (this._flushing || (path && historyWriterBusy(path))) {
            log.debug('[store]: flush skipped reason=busy');
            return Promise.resolve('busy');
        }

        if (!batch)
            return Promise.resolve(this._degraded ? 'failed' : 'idle');
        const { records, target, gen } = batch;
        this._pending = null;
        try {
            const snapshot = sortRecords(records).map(record => this._snapshotItem(record));
            log.debug('[store]: flush started');
            this._flushing = this._finishFlush(writeHistorySnapshot(path, snapshot), snapshot, path, target, gen);
            return this._flushing;
        } catch (error) {
            this._degraded = true;
            log.error('[store]: prepare history snapshot', error);
            return Promise.resolve('failed');
        }
    }

    async _finishFlush(work, snapshot, path, target, gen) {
        try {
            const { status, kept, created } = await work;
            if (status === 'failed') {
                if (!this._degraded)
                    log.warn('[store]: persistence degraded');
                this._degraded = true;
                return status;
            }
            if (status !== 'saved')
                return status;
            this._degraded = false;
            if (this._protectedFallback !== target)
                this._protectedFallback = null;
            try {
                if (!this._closed && kept < snapshot.length)
                    this._onTrim(snapshot.slice(0, kept), gen);
                if (!this._closed && created) {
                    log.info(`[store]: new daily file created ${path}`);
                    this._onNewDailyFile(target, path);
                }
            } catch (error) {
                log.error('[store]: notify after saving snapshot', error);
            }
            return status;
        } catch (error) {
            this._degraded = true;
            log.error('[store]: finish history flush', error);
            return 'failed';
        } finally {
            this._flushing = null;
            log.debug('[store]: flush finished');
        }
    }

    // Retention sweep: delete whole daily clips-*.jsonl files whose filename date is strictly
    // older than `maxAgeDays` days. Bounded and fail-closed: never throws into the timer
    // callback, never touches the in-memory history (Store holds no reference to it). Runs only
    // after history load and never from disable()/teardown (see extension.js / WARNING.md).
    async sweepOldFiles(maxAgeDays, { retryIfBusy = false } = {}) {
        if (!(maxAgeDays > 0) || this._closed || this._writePaused)
            return;
        if (this._sweeping) {
            // Timer/startup overlap remains a no-op, but a successful first append to a new
            // daily file must not lose its one cleanup trigger while a sweep is in flight.
            if (retryIfBusy)
                this._retryNewDailySweep = true;
            return;
        }
        this._sweeping = true;
        let completed = false;
        try {
            const dir = this._dir;
            const protectedFallback = this._protectedFallback;
            completed = await runStoreIo(dir, 'history retention', this._cancelIo,
                request => sweepFiles(dir, maxAgeDays, protectedFallback, request));
        } catch (error) {
            log.error('[store]: cleanup sweep failed', error);
        } finally {
            this._sweeping = false;
            const retry = this._retryNewDailySweep;
            this._retryNewDailySweep = false;
            if (retry && completed && !this._closed)
                await this.sweepOldFiles(maxAgeDays);
        }
    }

    close() {
        if (this._closed)
            return this._closeWork;
        this._closed = true;
        for (const cancel of this._cancelIo)
            cancel();
        const batch = this._pending;
        this._pending = null;
        this._closeWork = this._flushing ?? Promise.resolve('idle');
        if (this._degraded || this._writePaused || !batch)
            return this._closeWork;
        try {
            const snapshot = sortRecords(batch.records).map(record => this._snapshotItem(record));
            this._closeWork = writeHistorySnapshot(clipPath(this._dir, batch.target), snapshot, true)
                .then(result => result.status);
        } catch (error) {
            log.error('[store]: prepare final history snapshot', error);
        }
        return this._closeWork;
    }
}
