import GLib from 'gi://GLib';

import { log } from './log.js';

const _enc = new TextEncoder();
const SLOW_FINGERPRINT_MS = 16;
const SLOW_INDEX_REBUILD_MS = 50;

// In-memory MRU model - the single source of truth for the running session.
//
// Record shape:
//   { id, kind, mime, bytes, contentBytes, contentSha256, createdAt, usedAt, payloads }
//
// Ordering: usedAt descending. Re-selecting an existing entry (write-back) updates its
// usedAt -> floats to top; re-copying instead adds a brand-new record at the top and removes
// older records with exactly the same kind/mime/payloads. Persisted contentBytes and
// contentSha256 fields feed a kind+canonical-length+SHA-256 candidate index; digest matches are
// still compared field-by-field, so a collision cannot delete a different record. `id` is the
// per-record identity (a uuid) used by the UI / store.

function newId() {
    return GLib.uuid_string_random();
}

function updateFramed(checksum, value) {
    const bytes = _enc.encode(String(value));
    const header = _enc.encode(`${bytes.length}:`);
    checksum.update(header);
    checksum.update(bytes);
    return header.length + bytes.length;
}

function contentFingerprint(record) {
    if (!record || typeof record.kind !== 'string' || !Array.isArray(record.payloads))
        return null;
    const checksum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
    let canonicalBytes = 0;
    canonicalBytes += updateFramed(checksum, record.mime);
    canonicalBytes += updateFramed(checksum, record.bytes);
    canonicalBytes += updateFramed(checksum, record.payloads.length);
    for (const payload of record.payloads) {
        if (!payload)
            return null;
        canonicalBytes += updateFramed(checksum, payload.mime);
        canonicalBytes += updateFramed(checksum, payload.encoding);
        canonicalBytes += updateFramed(checksum, payload.bytes);
        canonicalBytes += updateFramed(checksum, payload.value);
    }
    const digest = checksum.get_string();
    return {
        key: `${record.kind}:${canonicalBytes}:${digest}`,
        canonicalBytes,
        digest,
    };
}

function storedFingerprint(record) {
    if (!record || typeof record.kind !== 'string' ||
            !Number.isInteger(record.contentBytes) || record.contentBytes < 0 ||
            typeof record.contentSha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(record.contentSha256))
        return null;
    return {
        key: `${record.kind}:${record.contentBytes}:${record.contentSha256}`,
        canonicalBytes: record.contentBytes,
        digest: record.contentSha256,
    };
}

function sameContent(a, b) {
    if (!a || !b || a.kind !== b.kind || a.mime !== b.mime || a.bytes !== b.bytes)
        return false;
    if (!Array.isArray(a.payloads) || !Array.isArray(b.payloads) ||
            a.payloads.length !== b.payloads.length)
        return false;
    for (let i = 0; i < a.payloads.length; i++) {
        const ap = a.payloads[i];
        const bp = b.payloads[i];
        if (!ap || !bp || ap.mime !== bp.mime || ap.encoding !== bp.encoding ||
                ap.bytes !== bp.bytes || ap.value !== bp.value)
            return false;
    }
    return true;
}

export class History {
    constructor({ opts, store, onChange }) {
        this._opts = opts;             // config.history
        this._store = store;
        this._onChange = onChange ?? (() => {});
        this._records = [];
        this._contentIndex = new Map();
        this._fingerprints = new WeakMap();
        this._gen = 0;          // bumped on every mutation; lets the store detect concurrent
                                // changes and skip a stale trim-sync (see store.flush).
    }

    /** Monotonic change counter. Changes whenever the record set is mutated. */
    get gen() { return this._gen; }

    load(records) {
        this._replaceRecords(records);
        this._sort();
        log.info(`history loaded: ${this._records.length} entries`);
        this._onChange();
    }

    /**
     * Mark the current in-memory snapshot pending without changing any record. Used once at
     * startup, right after load(), when history was recovered from an older day's file
     * (store.recoveredFromOlderFile) so it gets a durable copy in today's file before the
     * retention sweep can delete the file it was just recovered from.
     */
    persistSnapshot() {
        log.debug('history persistSnapshot: forcing current snapshot pending (startup re-home)');
        this._persist();
    }

    trimTo(records) {
        this._replaceRecords(records);
        this._sort();
        this._onChange();
    }

    _replaceRecords(records) {
        this._gen++;
        this._records = records.slice(0, this._opts.maxItems);
        this._rebuildContentIndex();
    }

    _sort() {
        this._records.sort((a, b) => b.usedAt - a.usedAt);
    }

    /**
     * Add a new entry. `rec` carries payloads already resolved by the caller. If `rec.id` is
     * set (the capture event's uuid) it becomes the record id, threading event -> record ->
     * logs; otherwise a fresh uuid is minted. The new record is kept as the head while the
     * persisted fingerprint index selects older exact-content candidates; digest matches are
     * verified field-by-field before batch removal and maxItems eviction. Returns the live record.
     */
    add(rec) {
        const now = GLib.get_real_time();
        const record = {
            createdAt: now,
            usedAt: now,
            payloads: [],
            ...rec,
            id: rec.id ?? newId(),
        };
        // Identity is derived from the normalized record, never trusted from an add() caller.
        delete record.contentBytes;
        delete record.contentSha256;
        const removed = this._dropMatchingQuiet(record);
        this._records.unshift(record);
        this._indexAdd(record);
        this._evict();
        this._sort();
        this._persist();
        this._onChange();
        if (removed > 0)
            log.info(`history deduplicated headId=${record.id} kind=${record.kind} bytes=${record.bytes} removed=${removed}`);
        return record;
    }

    /** Promote/refresh an existing record to the top (used on restore and suppressed repeats). */
    touch(record) {
        record.usedAt = GLib.get_real_time();
        this._sort();
        this._persist();
        this._onChange();
    }

    remove(id) {
        const i = this._records.findIndex(r => r.id === id);
        if (i < 0) return;
        const [removed] = this._records.splice(i, 1);
        this._indexRemove(removed);
        this._persist();
        this._onChange();
        log.info(`history removed id=${removed.id} kind=${removed.kind} bytes=${removed.bytes}`);
    }

    clear() {
        const count = this._records.length;
        this._records = [];
        this._contentIndex.clear();
        this._fingerprints = new WeakMap();
        this._persist();
        this._onChange();
        log.info(`history cleared count=${count}`);
    }

    getById(id) {
        return this._records.find(r => r.id === id) ?? null;
    }

    /** @returns {Array} sorted copy (MRU first). */
    list(limit = 0) {
        const out = this._records.slice();
        return limit > 0 ? out.slice(0, limit) : out;
    }

    serialize() {
        return this.list();
    }

    _persist() {
        this._gen++;
        this._store.appendSnapshot(this.list(), this._gen);
    }

    _evict() {
        const o = this._opts;
        // In-memory history is bounded only by maxItems. Age-based retention is a disk-level
        // policy: the store's bounded sweep deletes old clips-*.jsonl files and never touches
        // this in-memory set (see store.sweepOldFiles / docs/06-history-model.md).
        const byOldest = () =>
            this._records.slice().sort((a, b) => a.usedAt - b.usedAt);

        while (this._records.length > o.maxItems) {
            const victim = byOldest()[0];
            if (!victim) break;
            this._dropQuiet(victim.id);
        }
    }

    _dropQuiet(id) {
        const i = this._records.findIndex(r => r.id === id);
        if (i < 0) return;
        const [removed] = this._records.splice(i, 1);
        this._indexRemove(removed);
    }

    _dropMatchingQuiet(head) {
        const fingerprint = this._fingerprint(head);
        if (!fingerprint)
            return 0;
        const bucket = this._contentIndex.get(fingerprint.key);
        if (!bucket || bucket.size === 0)
            return 0;
        const matches = new Set();
        for (const record of bucket) {
            if (sameContent(head, record))
                matches.add(record);
        }
        if (matches.size === 0)
            return 0;
        for (const record of matches)
            this._indexRemove(record);
        this._records = this._records.filter(record => !matches.has(record));
        return matches.size;
    }

    _fingerprint(record) {
        const cached = this._fingerprints.get(record);
        if (cached)
            return cached;
        const stored = storedFingerprint(record);
        if (stored) {
            this._fingerprints.set(record, stored);
            return stored;
        }
        const started = GLib.get_monotonic_time();
        try {
            const fingerprint = contentFingerprint(record);
            if (!fingerprint)
                return null;
            record.contentBytes = fingerprint.canonicalBytes;
            record.contentSha256 = fingerprint.digest;
            this._fingerprints.set(record, fingerprint);
            const elapsedMs = (GLib.get_monotonic_time() - started) / 1000;
            if (elapsedMs >= SLOW_FINGERPRINT_MS) {
                log.warn(`history fingerprint slow recordId=${record.id ?? '(none)'} kind=${record.kind ?? '(none)'} bytes=${record.bytes ?? 0} canonicalBytes=${fingerprint.canonicalBytes} elapsedMs=${elapsedMs.toFixed(1)}`);
            }
            return fingerprint;
        } catch (e) {
            log.warn(`history fingerprint skipped recordId=${record?.id ?? '(none)'} kind=${record?.kind ?? '(none)'} reason=${String(e?.message ?? e)}`);
            return null;
        }
    }

    _indexAdd(record) {
        const fingerprint = this._fingerprint(record);
        if (!fingerprint)
            return;
        let bucket = this._contentIndex.get(fingerprint.key);
        if (!bucket) {
            bucket = new Set();
            this._contentIndex.set(fingerprint.key, bucket);
        }
        bucket.add(record);
    }

    _indexRemove(record) {
        const fingerprint = this._fingerprint(record);
        if (!fingerprint)
            return;
        const bucket = this._contentIndex.get(fingerprint.key);
        if (!bucket)
            return;
        bucket.delete(record);
        if (bucket.size === 0)
            this._contentIndex.delete(fingerprint.key);
    }

    _rebuildContentIndex() {
        const started = GLib.get_monotonic_time();
        this._contentIndex = new Map();
        this._fingerprints = new WeakMap();
        let canonicalBytes = 0;
        for (const record of this._records) {
            this._indexAdd(record);
            canonicalBytes += this._fingerprints.get(record)?.canonicalBytes ?? 0;
        }
        const elapsedMs = (GLib.get_monotonic_time() - started) / 1000;
        const message = `history content index rebuilt records=${this._records.length} keys=${this._contentIndex.size} canonicalBytes=${canonicalBytes} elapsedMs=${elapsedMs.toFixed(1)}`;
        if (elapsedMs >= SLOW_INDEX_REBUILD_MS)
            log.warn(message);
        else
            log.debug(message);
    }
}
