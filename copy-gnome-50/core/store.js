import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { log } from './log.js';
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
// never during disable()/teardown). If the newest line is bad, startup begins with empty
// history and leaves repair to a future doctor command.

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.File.prototype, 'append_to_async', 'append_to_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');

// Internal hard cap on a single JSONL snapshot line. Fixed for now; intended to become a
// configurable storage option later.
const MAX_SNAPSHOT_LINE_BYTES = 64 * 1024 * 1024;
const _enc = new TextEncoder();
const _dec = new TextDecoder();

function ensureDir(path) {
    GLib.mkdir_with_parents(path, 0o700);
}

function clipDateNameFromMicros(micros) {
    const seconds = Math.floor((Number(micros) || GLib.get_real_time()) / 1000000);
    const dt = GLib.DateTime.new_from_unix_local(seconds);
    return `clips-${dt.format('%Y%m%d')}.jsonl`;
}

function currentClipName() {
    return clipDateNameFromMicros(GLib.get_real_time());
}

function listNames(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    if (!dir.query_exists(null)) return [];
    const names = [];
    try {
        const en = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null)
            names.push(info.get_name());
        en.close(null);
    } catch (e) {
        log.warn(`[store]: enumerate ${dirPath}: ${e.message}`);
    }
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

function normalizeRecord(obj, maxLineBytes) {
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

    const rec = {
        id: obj.id,
        kind: obj.kind,
        mime: obj.mime,
        bytes: obj.bytes,
        preview: typeof obj.preview === 'string' ? obj.preview : '',
        createdAt: obj.createdAt,
        usedAt: obj.usedAt,
        payloads,
    };

    if (!validKindPayloads(rec))
        return null;
    if (rec.kind === 'text' && rec.mime !== PLAIN_TEXT_MIME && !rec.mime.startsWith('text/plain'))
        return null;
    if (rec.kind === 'rich' && !RICH_TEXT_MIMES.includes(rec.mime))
        return null;
    if (payloadBytesTotal(rec.payloads) > rec.bytes)
        log.debug(`[store]: record bytes lower than payload sum id=${rec.id} bytes=${rec.bytes} payloadBytes=${payloadBytesTotal(rec.payloads)}`);

    // Avoid accepting a line that can never be written back under current caps.
    const approx = JSON.stringify(rec).length;
    if (approx > maxLineBytes)
        return null;

    return rec;
}

function sortRecords(records) {
    return records.slice().sort((a, b) => b.usedAt - a.usedAt);
}

function normalizeSnapshot(obj, maxLineBytes) {
    if (!obj || obj.type !== 'history' || obj.version !== 1 || !Array.isArray(obj.items))
        return null;

    const out = [];
    const seenIds = new Set();
    for (const item of obj.items) {
        const rec = normalizeRecord(item, maxLineBytes);
        if (!rec || seenIds.has(rec.id))
            continue;
        seenIds.add(rec.id);
        out.push(rec);
    }
    return sortRecords(out);
}

export class Store {
    constructor({ dataDir, onTrim }) {
        this._dir = dataDir;
        this._onTrim = onTrim ?? (() => {});
        this._tmpDir = GLib.build_filenamev([dataDir, 'tmp']);
        this._pending = null;
        this._busy = false;
        this._closed = false;
        this._degraded = false;
        this._sweeping = false;
    }

    async open() {
        ensureDir(this._dir);
        ensureDir(this._tmpDir);

        const fileName = this._pickStartupFileName();
        if (!fileName) {
            log.info(`[store]: opened 0 records from ${this._dir}`);
            return [];
        }
        const path = clipPath(this._dir, fileName);

        try {
            const line = await this._readLastLineText(path);
            const records = this._parseSnapshotLine(line);
            log.info(`[store]: opened ${records.length} records from ${path}`);
            return records;
        } catch (e) {
            log.warn(`[store]: clips load failed path=${path} reason=${e.message}; starting empty`);
            return [];
        }
    }

    _pickStartupFileName() {
        const current = currentClipName();
        if (Gio.File.new_for_path(clipPath(this._dir, current)).query_exists(null))
            return current;
        const names = listNames(this._dir).filter(isClipFileName).sort();
        return names.length ? names[names.length - 1] : null;
    }

    // Read only the final snapshot line, not the whole file. The file ends with '\n' after
    // each append, so we seek to the end and read backwards in chunks until we find the newline
    // that ends the previous record. Newline (0x0A) never appears inside a UTF-8 multibyte
    // sequence, so scanning raw bytes for it is safe. Reading stops once the candidate line
    // would exceed the snapshot cap (treated as unreadable -> empty).
    async _readLastLineText(path) {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return '';
        const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
        const size = Number(info.get_size());
        if (size <= 0)
            return '';

        const CHUNK = 1024 * 1024;
        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
        try {
            let pos = size;
            let buf = new Uint8Array(0);    // bytes [pos, size), grown chunk-by-chunk from the end
            while (pos > 0) {
                const want = Math.min(CHUNK, pos);
                const start = pos - want;
                const chunk = await this._readChunkAt(stream, start, want);
                if (chunk.length !== want) {
                    // Short of a full chunk means the file shrank under us (we only ever append,
                    // so this is unexpected). Fail closed rather than splice a gap into the line.
                    log.warn('[store]: history file changed size while reading; starting empty');
                    return '';
                }
                pos = start;
                const merged = new Uint8Array(chunk.length + buf.length);
                merged.set(chunk, 0);
                merged.set(buf, chunk.length);
                buf = merged;

                // Drop a single trailing newline, then look for the newline ending the previous
                // record; the bytes after it are the last line.
                let end = buf.length;
                if (buf[end - 1] === 0x0A)
                    end--;
                const nl = buf.lastIndexOf(0x0A, end - 1);
                if (nl >= 0)
                    return _dec.decode(buf.subarray(nl + 1, end));
                if (end > MAX_SNAPSHOT_LINE_BYTES) {
                    log.warn('[store]: latest history snapshot exceeds 64 MiB on disk; starting empty');
                    return '';
                }
                if (pos === 0)
                    return _dec.decode(buf.subarray(0, end));
            }
            return '';
        } finally {
            try {
                stream.close(null);
            } catch (e) {
                // ignore
            }
        }
    }

    // Read exactly `count` bytes starting at `offset`. read_bytes_async may return fewer bytes
    // than requested, so loop until the chunk is full or the stream ends. Returns a shorter
    // array only on early EOF; callers treat that as fail-closed.
    async _readChunkAt(stream, offset, count) {
        stream.seek(offset, GLib.SeekType.SET, null);
        const out = new Uint8Array(count);
        let got = 0;
        while (got < count) {
            const bytes = await stream.read_bytes_async(count - got, GLib.PRIORITY_DEFAULT, null);
            const data = bytes?.get_data();
            if (!data || data.length === 0)
                break;
            out.set(data, got);
            got += data.length;
        }
        return got === count ? out : out.subarray(0, got);
    }

    _parseSnapshotLine(line) {
        // Simplified by design: only the newest snapshot line is considered. If it is torn,
        // oversized, or invalid we start empty and leave older snapshots on disk for a future
        // doctor command, rather than scanning backwards for the previous good snapshot.
        if (!line)
            return [];
        if (line.length > MAX_SNAPSHOT_LINE_BYTES) {
            log.warn('[store]: latest history snapshot is oversized; starting empty');
            return [];
        }
        try {
            const records = normalizeSnapshot(JSON.parse(line), MAX_SNAPSHOT_LINE_BYTES);
            if (records)
                return records;
            log.warn('[store]: latest history snapshot is invalid; starting empty');
        } catch (e) {
            log.warn(`[store]: latest history snapshot is corrupt; starting empty: ${e.message}`);
        }
        return [];
    }

    appendSnapshot(records, gen = 0) {
        if (this._closed)
            return;
        // Store only the records reference (a shallow copy from history.list()); the expensive
        // JSON.stringify of the full history is deferred to flush()/closeSync() so the capture
        // path stays O(1) and never serializes the whole history on every copy/touch. Each call
        // supersedes any unsaved snapshot, so we never queue stale or duplicate work. `gen` is
        // History's change counter at snapshot time, used to detect concurrent edits in flush().
        // No per-mutation flush: writes happen only on the periodic timer in extension.js
        // (storage.flushIntervalSec, default 1800s) and on disable()/closeSync(). _pending just
        // holds the latest full snapshot until then; recent captures may be lost on crash.
        this._pending = { target: currentClipName(), records, gen };
    }

    _snapshotItem(rec) {
        return {
            id: rec.id,
            kind: rec.kind,
            mime: rec.mime,
            bytes: rec.bytes ?? 0,
            preview: rec.preview ?? '',
            createdAt: rec.createdAt,
            usedAt: rec.usedAt,
            payloads: Array.isArray(rec.payloads) ? rec.payloads.map(p => ({
                mime: p.mime,
                encoding: p.encoding,
                value: p.value,
                bytes: p.bytes,
            })) : [],
        };
    }

    _snapshotForRecords(records) {
        return {
            type: 'history',
            version: 1,
            writtenAt: GLib.get_real_time(),
            items: sortRecords(records).map(rec => this._snapshotItem(rec)),
        };
    }

    _lineForSnapshot(records) {
        return JSON.stringify(this._snapshotForRecords(records));
    }

    _byteLength(str) {
        return _enc.encode(str).length;
    }

    // The cap is in UTF-8 bytes (what we write and what _readLastLineText budgets), not JS
    // string length, so CJK/emoji snapshots stay readable. Trim by LRU: keep the most-recently-
    // used prefix whose encoded size fits, using each record's own encoded size plus the
    // envelope, so we serialize each item once instead of re-serializing the whole snapshot per
    // dropped entry.
    _trimRecordsForSnapshot(records) {
        const sorted = sortRecords(records);
        const line = this._lineForSnapshot(sorted);
        // UTF-8 byte length is at most 3x the UTF-16 length, so if 3x already fits we are safely
        // under the cap without encoding the whole (possibly huge) line just to count bytes.
        if (line.length * 3 <= MAX_SNAPSHOT_LINE_BYTES)
            return { records: sorted, line, trimmed: false };

        const envelopeBytes = this._byteLength(this._lineForSnapshot([]));
        const itemBytes = sorted.map(rec => this._byteLength(JSON.stringify(this._snapshotItem(rec))));
        let total = envelopeBytes;
        let kept = 0;
        for (let i = 0; i < sorted.length; i++) {
            const add = itemBytes[i] + (kept > 0 ? 1 : 0);   // +1 for the separating comma
            if (total + add > MAX_SNAPSHOT_LINE_BYTES)
                break;
            total += add;
            kept++;
        }

        if (kept === sorted.length)
            return { records: sorted, line, trimmed: false };
        if (kept === 0) {
            log.warn(`[store]: skipping oversized history snapshot (newest item ${itemBytes[0]} bytes exceeds 64 MiB)`);
            return { records: [], line: null, trimmed: false };
        }

        const trimmed = sorted.slice(0, kept);
        log.warn(`[store]: trimmed history snapshot to ${kept} entries to stay under 64 MiB`);
        return { records: trimmed, line: this._lineForSnapshot(trimmed), trimmed: true };
    }

    // flush() is driven solely by the periodic timer in extension.js (storage.flushIntervalSec)
    // and by closeSync() on teardown; there is no per-mutation debounce. If a flush is already in
    // progress, a concurrent call leaves _pending in place for the next periodic tick.
    async flush() {
        if (this._closed || !this._pending)
            return 'idle';
        if (this._busy)
            return 'busy';
        this._busy = true;
        const batch = this._pending;
        this._pending = null;
        try {
            // Serialize here, not in the capture path. If the full snapshot exceeds the internal
            // hard cap, trim oldest entries until it is writable and sync History to that trimmed
            // set. The trimmed batch may be stale by the time the append resolves; _onTrim guards
            // against that via batch.gen.
            const { records, line, trimmed } = this._trimRecordsForSnapshot(batch.records);
            if (!line)
                return 'failed';
            const path = clipPath(this._dir, batch.target);
            log.debug(`[store]: flush ${records.length} records -> ${path}${trimmed ? ' (trimmed)' : ''}`);
            await this._appendTextAsync(path, line + '\n');
            if (trimmed)
                this._onTrim(records, batch.gen);
            this._degraded = false;
            return 'saved';
        } catch (e) {
            if (!this._degraded) {
                this._degraded = true;
                log.error(`[store]: persistence append failed; dropping pending history snapshot: ${e.message}`);
            } else {
                log.warn(`[store]: persistence append failed; dropping pending history snapshot: ${e.message}`);
            }
            return 'failed';
        } finally {
            this._busy = false;
        }
    }

    async _appendTextAsync(path, text) {
        ensureDir(this._dir);
        const file = Gio.File.new_for_path(path);
        const stream = await file.append_to_async(Gio.FileCreateFlags.NONE,
            GLib.PRIORITY_DEFAULT, null);
        try {
            await stream.write_bytes_async(new GLib.Bytes(_enc.encode(text)),
                GLib.PRIORITY_DEFAULT, null);
        } finally {
            await stream.close_async(GLib.PRIORITY_DEFAULT, null);
        }
    }

    // Retention sweep: delete whole daily clips-*.jsonl files whose filename date is strictly
    // older than `maxAgeDays` days. Bounded and fail-closed: never throws into the timer
    // callback, never touches the in-memory history (Store holds no reference to it). Runs only
    // after history load and never from disable()/teardown (see extension.js / WARNING.md).
    async sweepOldFiles(maxAgeDays) {
        if (!(maxAgeDays > 0) || this._closed || this._sweeping)
            return;
        this._sweeping = true;
        try {
            const now = GLib.DateTime.new_now_local();
            const dayMicros = 86400 * 1e6;
            for (const name of listNames(this._dir).filter(isClipFileName)) {
                // Stop promptly if disable()/closeSync() ran mid-sweep; teardown must not keep
                // deleting. (Also bounds any overlapping sweep.)
                if (this._closed)
                    return;
                const fileDay = clipDateFromName(name);
                if (!fileDay) {
                    log.warn(`[store]: cleanup skip unparsable name=${name}`);
                    continue;
                }
                const ageDays = Math.floor(now.difference(fileDay) / dayMicros);
                if (ageDays <= maxAgeDays)
                    continue;
                try {
                    const path = clipPath(this._dir, name);
                    const file = Gio.File.new_for_path(path);
                    await file.delete_async(GLib.PRIORITY_DEFAULT, null);
                    log.info(`[store]: cleanup deleted ${path} ageDays=${ageDays}`);
                } catch (e) {
                    log.warn(`[store]: cleanup delete failed path=${clipPath(this._dir, name)} reason=${e.message}`);
                }
            }
        } catch (e) {
            log.error(`[store]: cleanup sweep failed: ${e.message}`);
        } finally {
            this._sweeping = false;
        }
    }

    closeSync() {
        this._closed = true;
        if (this._busy || this._degraded || !this._pending)
            return;
        const batch = this._pending;
        this._pending = null;
        try {
            // Best-effort synchronous flush on teardown (see WARNING.md). Serialize here under
            // the same 64 MiB snapshot cap as the async path; whatever the trim returns is
            // writable, so we write it rather than dropping the user's most recent changes.
            const { line } = this._trimRecordsForSnapshot(batch.records);
            if (!line)
                return;
            const path = clipPath(this._dir, batch.target);
            log.debug(`[store]: flush(final) -> ${path}`);
            const file = Gio.File.new_for_path(path);
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(_enc.encode(line + '\n'), null);
            stream.close(null);
        } catch (e) {
            log.error(`[store]: final flush failed: ${e.message}`);
        }
    }
}
