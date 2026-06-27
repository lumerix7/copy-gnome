import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { log } from './log.js';

// Append-only daily JSONL store. See docs/04-storage.md.
//
// Layout under <dataDir>:
//   clips-YYYYMMDD.jsonl   append-only, one full sorted history snapshot per line
//   tmp/                   reserved for future doctor/repair tooling
//
// The Shell extension never rewrites, truncates, compacts, deletes, or repairs clips
// files. Bad tail lines are ignored on load and left for a future doctor repair command.

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.File.prototype, 'append_to_async', 'append_to_finish');

const DEFAULT_TAIL_BYTES = 16 * 1024 * 1024;
const FINAL_FLUSH_MAX_BYTES = 64 * 1024;
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
        log.warn(`enumerate ${dirPath}: ${e.message}`);
    }
    return names;
}

function isClipFileName(name) {
    return /^clips-\d{8}\.jsonl$/.test(name);
}

function clipPath(dir, name) {
    return GLib.build_filenamev([dir, name]);
}

function normalizeRecord(obj, maxLineBytes) {
    if (!obj || typeof obj !== 'object')
        return null;
    if (typeof obj.id !== 'string' || typeof obj.hash !== 'string')
        return null;
    if (!['text', 'html', 'file', 'image', 'binary'].includes(obj.kind))
        return null;
    if (typeof obj.mime !== 'string' || typeof obj.encoding !== 'string')
        return null;
    if (typeof obj.bytes !== 'number' || obj.bytes < 0)
        return null;
    if (typeof obj.createdAt !== 'number' || typeof obj.usedAt !== 'number')
        return null;

    const rec = {
        id: obj.id,
        hash: obj.hash,
        kind: obj.kind,
        mime: obj.mime,
        encoding: obj.encoding,
        text: typeof obj.text === 'string' ? obj.text : null,
        data: typeof obj.data === 'string' ? obj.data : null,
        uri: typeof obj.uri === 'string' ? obj.uri : null,
        bytes: obj.bytes,
        preview: typeof obj.preview === 'string' ? obj.preview : '',
        createdAt: obj.createdAt,
        usedAt: obj.usedAt,
    };

    if (rec.kind === 'file' && !rec.uri)
        return null;
    if ((rec.kind === 'text' || rec.kind === 'html') && rec.text == null)
        return null;
    if ((rec.kind === 'image' || rec.kind === 'binary') && rec.data == null)
        return null;

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
    constructor({ dataDir, opts }) {
        this._dir = dataDir;
        this._opts = opts;
        this._tmpDir = GLib.build_filenamev([dataDir, 'tmp']);
        this._pending = null;
        this._flushSource = 0;
        this._busy = false;
        this._closed = false;
        this._degraded = false;
    }

    async open() {
        ensureDir(this._dir);
        ensureDir(this._tmpDir);

        const fileName = this._pickStartupFileName();
        if (!fileName) {
            log.info('store opened: 0 records');
            return [];
        }

        try {
            const text = await this._readTailText(clipPath(this._dir, fileName));
            const records = this._parseTailSnapshot(text);
            log.info(`store opened: ${records.length} records from ${fileName}`);
            return records;
        } catch (e) {
            log.warn(`clips load failed (${fileName}): ${e.message}; starting empty`);
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

    async _readTailText(path) {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return '';
        const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
        const size = Number(info.get_size());
        const maxTailBytes = Math.max(
            256 * 1024,
            Math.min(DEFAULT_TAIL_BYTES, this._opts.clipLineMaxBytes * this._opts.maxLoadedLines));
        const offset = Math.max(0, size - maxTailBytes);

        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
        try {
            if (offset > 0)
                stream.seek(offset, GLib.SeekType.SET, null);
            const bytes = await stream.read_bytes_async(maxTailBytes, GLib.PRIORITY_DEFAULT, null);
            let text = _dec.decode(bytes.get_data());
            if (offset > 0) {
                const firstNewline = text.indexOf('\n');
                text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
            }
            return text;
        } finally {
            try {
                stream.close(null);
            } catch (e) {
                // ignore
            }
        }
    }

    _parseTailSnapshot(text) {
        const lines = text.split('\n').filter(line => line.length > 0);
        let corruptWarnings = 0;
        let oversizedWarnings = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (line.length > this._opts.clipLineMaxBytes) {
                if (oversizedWarnings++ < 3)
                    log.warn('skipping oversized history snapshot while loading');
                continue;
            }
            try {
                const records = normalizeSnapshot(JSON.parse(line), this._opts.clipLineMaxBytes);
                if (records)
                    return records.slice(0, this._opts.maxLoadedLines);
            } catch (e) {
                // Most likely a torn final line. Ignore and keep looking within tail.
                if (corruptWarnings++ < 3) {
                    if (i === lines.length - 1)
                        log.warn('ignoring corrupt final history snapshot');
                    else
                        log.warn(`ignoring corrupt history snapshot: ${e.message}`);
                }
            }
        }
        if (corruptWarnings > 3)
            log.warn(`ignored ${corruptWarnings} corrupt history snapshots while loading`);
        if (oversizedWarnings > 3)
            log.warn(`ignored ${oversizedWarnings} oversized history snapshots while loading`);
        return [];
    }

    appendSnapshot(records) {
        if (this._closed)
            return;
        const line = this._lineForSnapshot(records);
        if (!line)
            return;
        const target = currentClipName();
        // A full snapshot supersedes older unsaved snapshots, so never build a large queue.
        this._pending = { target, line };
        this._scheduleFlush();
    }

    _lineForSnapshot(records) {
        const snapshot = {
            type: 'history',
            version: 1,
            writtenAt: GLib.get_real_time(),
            items: sortRecords(records).map(rec => ({
                id: rec.id,
                hash: rec.hash,
                kind: rec.kind,
                mime: rec.mime,
                encoding: rec.encoding ?? (rec.data ? 'base64' : 'utf8'),
                text: rec.text ?? null,
                data: rec.data ?? null,
                uri: rec.uri ?? null,
                bytes: rec.bytes ?? 0,
                preview: rec.preview ?? '',
                createdAt: rec.createdAt,
                usedAt: rec.usedAt,
            })),
        };
        const line = JSON.stringify(snapshot);
        if (line.length > this._opts.clipLineMaxBytes) {
            log.warn(`skipping oversized history snapshot (${line.length} bytes)`);
            return null;
        }
        return line;
    }

    _scheduleFlush() {
        if (this._flushSource)
            return;
        this._flushSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._opts.debounceMs, () => {
                this._flushSource = 0;
                this.flush().catch(e => log.warn(`flush: ${e.message}`));
                return GLib.SOURCE_REMOVE;
            });
    }

    async flush() {
        if (this._closed || !this._pending)
            return;
        if (this._busy) {
            this._scheduleFlush();
            return;
        }
        this._busy = true;
        const batch = this._pending;
        this._pending = null;
        try {
            await this._appendTextAsync(clipPath(this._dir, batch.target), batch.line + '\n');
            this._degraded = false;
        } catch (e) {
            if (!this._degraded) {
                this._degraded = true;
                log.error(`persistence append failed; dropping pending history snapshot: ${e.message}`);
            } else {
                log.warn(`persistence append failed; dropping pending history snapshot: ${e.message}`);
            }
        } finally {
            this._busy = false;
            if (this._pending && !this._closed)
                this._scheduleFlush();
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

    closeSync() {
        this._closed = true;
        if (this._flushSource) {
            GLib.Source.remove(this._flushSource);
            this._flushSource = 0;
        }
        if (this._busy || this._degraded || !this._pending)
            return;
        const pendingBytes = this._pending.line.length + 1;
        if (pendingBytes > FINAL_FLUSH_MAX_BYTES) {
            log.warn(`skipping final flush: ${pendingBytes} pending bytes exceeds safety cap`);
            return;
        }
        const batch = this._pending;
        this._pending = null;
        try {
            const file = Gio.File.new_for_path(clipPath(this._dir, batch.target));
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(_enc.encode(batch.line + '\n'), null);
            stream.close(null);
        } catch (e) {
            log.error(`final flush failed: ${e.message}`);
        }
    }
}
