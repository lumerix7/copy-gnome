import GLib from 'gi://GLib';

import { log } from './log.js';

// In-memory MRU model - the single source of truth for the running session.
//
// Record shape:
//   { id, kind, mime, bytes, createdAt, usedAt, payloads }
//
// Ordering: usedAt descending. Re-selecting an existing entry (write-back) updates its
// usedAt -> floats to top; re-copying instead adds a brand-new record at the top.
// Every capture is kept as its own entry; identical content is intentionally NOT merged,
// so the history preserves the user's actual copy actions as-is. `id` is the per-record
// identity (a uuid) used by the UI / store. There is no content hash: the self-write guard
// matches on the raw clipboard content directly.

function newId() {
    return GLib.uuid_string_random();
}

export class History {
    constructor({ opts, store, onChange }) {
        this._opts = opts;             // config.history
        this._store = store;
        this._onChange = onChange ?? (() => {});
        this._records = [];
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

    trimTo(records) {
        this._replaceRecords(records);
        this._sort();
        this._onChange();
    }

    _replaceRecords(records) {
        this._gen++;
        this._records = records.slice(0, this._opts.maxItems);
    }

    _sort() {
        this._records.sort((a, b) => b.usedAt - a.usedAt);
    }

    /**
     * Add a new entry. `rec` carries payloads already resolved by the caller. If `rec.id` is
     * set (the capture event's uuid) it becomes the record id, threading event -> record ->
     * logs; otherwise a fresh uuid is minted. Every call creates a distinct record; identical
     * content is intentionally not merged. Returns the live record.
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
        this._records.push(record);
        this._evict();
        this._sort();
        this._persist();
        this._onChange();
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
        this._persist();
        this._onChange();
        log.info(`history removed id=${removed.id} kind=${removed.kind} bytes=${removed.bytes}`);
    }

    clear() {
        const count = this._records.length;
        this._records = [];
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
        // policy: the store's periodic sweep deletes old clips-*.jsonl files and never touches
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
        this._records.splice(i, 1);
    }
}
