import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { log } from './log.js';

export const MAX_SNAPSHOT_LINE_BYTES = 64 * 1024 * 1024;
const BLOCK = 64 * 1024;
const APPEND_TIMEOUT_SEC = 30;
const encoder = new TextEncoder();
const newline = new Uint8Array([0x0a]);
const writers = new Map();

Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.File.prototype, 'append_to_async', 'append_to_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

function yieldToShell() {
    return new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function* itemParts(item) {
    // Escape large payload strings in blocks with intact UTF-16 surrogate pairs.
    const { payloads, ...metadata } = item;
    yield JSON.stringify(metadata).slice(0, -1) + ',"payloads":[';
    for (const [index, payload] of payloads.entries()) {
        if (index)
            yield ',';
        const { value, ...fields } = payload;
        yield JSON.stringify(fields).slice(0, -1) + ',"value":"';
        for (let pos = 0; pos < value.length;) {
            let end = Math.min(pos + BLOCK, value.length);
            if (end < value.length && (value.charCodeAt(end - 1) & 0xfc00) === 0xd800)
                end--;
            yield JSON.stringify(value.slice(pos, end)).slice(1, -1);
            pos = end;
        }
        yield '"}';
    }
    yield ']}';
}

async function prepareSnapshot(records) {
    const header = encoder.encode(`{"type":"history","writtenAt":${GLib.get_real_time()},"items":[`);
    const footer = encoder.encode(']}\n');
    const comma = encoder.encode(',');
    const parts = [header];
    let total = header.length + footer.length - 1;
    let kept = 0;
    let sliceEnd = GLib.get_monotonic_time() + 8000;

    for (const rec of records) {
        const item = kept ? [comma] : [];
        let size = kept ? 1 : 0;
        for (const text of itemParts(rec)) {
            if (GLib.get_monotonic_time() >= sliceEnd) {
                await yieldToShell();
                sliceEnd = GLib.get_monotonic_time() + 8000;
            }
            const chunk = encoder.encode(text);
            size += chunk.length;
            if (total + size > MAX_SNAPSHOT_LINE_BYTES)
                break;
            item.push(chunk);
        }
        if (total + size > MAX_SNAPSHOT_LINE_BYTES)
            break;
        total += size;
        for (const part of item)
            parts.push(part);
        kept++;
    }

    if (!kept && records.length)
        throw new Error('newest history item exceeds the snapshot size cap');
    parts.push(footer);
    return { parts, kept };
}

function* outputBlocks(parts) {
    let block = new Uint8Array(256 * 1024);
    let used = 0;
    for (const part of parts) {
        for (let pos = 0; pos < part.length;) {
            const length = Math.min(block.length - used, part.length - pos);
            block.set(part.subarray(pos, pos + length), used);
            pos += length;
            used += length;
            if (used === block.length) {
                yield block;
                block = new Uint8Array(block.length);
                used = 0;
            }
        }
    }
    if (used)
        yield block.subarray(0, used);
}

async function queryFile(file, cancellable) {
    try {
        const info = await file.query_info_async('standard::type,standard::size',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            throw new Error('history destination is not a regular file');
        return info;
    } catch (error) {
        if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw error;
    }
}

async function needsLineSeparator(file, info, cancellable) {
    const size = info?.get_size() ?? 0;
    if (!size)
        return false;
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    try {
        stream.seek(size - 1, GLib.SeekType.SET, cancellable);
        const bytes = await stream.read_bytes_async(1, GLib.PRIORITY_DEFAULT, cancellable);
        return bytes.get_data()[0] !== newline[0];
    } finally {
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    }
}

async function appendSnapshot(path, records) {
    await yieldToShell();
    const { parts, kept } = await prepareSnapshot(records);
    if (kept < records.length)
        log.warn(`[store]: trimmed history snapshot to ${kept} entries to stay under 64 MiB`);

    const file = Gio.File.new_for_path(path);
    const cancellable = new Gio.Cancellable();
    let deadline = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, APPEND_TIMEOUT_SEC, () => {
        deadline = 0;
        log.warn(`[store]: history append timed out path=${path}`);
        try {
            cancellable.cancel();
        } catch (error) {
            log.error('[store]: cancel history append', error);
        }
        return GLib.SOURCE_REMOVE;
    });
    let stream;
    try {
        const info = await queryFile(file, cancellable);
        if (await needsLineSeparator(file, info, cancellable)) {
            log.warn(`[store]: separating new snapshot from an incomplete tail path=${path}`);
            parts.unshift(newline);
        }
        stream = await file.append_to_async(Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_DEFAULT, cancellable);
        for (const chunk of outputBlocks(parts)) {
            const bytes = new GLib.Bytes(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                const data = offset ? GLib.Bytes.new_from_bytes(bytes, offset, chunk.length - offset) : bytes;
                const written = await stream.write_bytes_async(data, GLib.PRIORITY_DEFAULT, cancellable);
                if (written <= 0)
                    throw new Error('history append made no progress');
                offset += written;
            }
        }
        return { status: 'saved', created: info === null, kept };
    } finally {
        try {
            if (stream)
                await stream.close_async(GLib.PRIORITY_DEFAULT, null);
        } finally {
            if (deadline) {
                try {
                    GLib.Source.remove(deadline);
                } catch (error) {
                    log.error('[store]: append deadline cleanup', error);
                }
            }
        }
    }
}

async function run(slot, path, job) {
    log.debug(`[store]: snapshot append started path=${path} records=${job.records.length}`);
    try {
        job.resolve(await appendSnapshot(path, job.records));
    } catch (error) {
        log.error(`[store]: append snapshot ${path}`, error);
        job.resolve({ status: 'failed' });
    } finally {
        log.debug(`[store]: snapshot append finished path=${path}`);
        // Only release after the write and close have actually settled.
        const next = slot.final;
        slot.final = null;
        if (next) {
            void run(slot, path, next);
        } else {
            writers.delete(path);
            for (const notify of slot.waiters)
                notify();
        }
    }
}

export function historyWriterBusy(path) {
    return writers.has(path);
}

// Regular flushes retry on the next tick. A closing store has no next tick, so
// reserve one final slot, replaceable by the last snapshot of a later close.
export function writeHistorySnapshot(path, records, final = false) {
    const current = writers.get(path);
    if (current) {
        if (!final)
            return Promise.resolve({ status: 'busy' });
        return new Promise(resolve => {
            current.final?.resolve({ status: 'superseded' });
            current.final = { records, resolve };
        });
    }
    const slot = { final: null, waiters: new Set() };
    writers.set(path, slot);
    return new Promise(resolve => { void run(slot, path, { records, resolve }); });
}

export function waitForHistoryWriter(path, timeoutMs = 2000) {
    const slot = writers.get(path);
    if (!slot)
        return Promise.resolve(true);
    return new Promise(resolve => {
        const notify = () => {
            slot.waiters.delete(notify);
            try {
                GLib.Source.remove(timeout);
            } catch (error) {
                log.error('[store]: writer wait cleanup', error);
            }
            resolve(true);
        };
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            slot.waiters.delete(notify);
            resolve(false);
            return GLib.SOURCE_REMOVE;
        });
        slot.waiters.add(notify);
    });
}
