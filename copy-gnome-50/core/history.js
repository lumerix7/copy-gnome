import GLib from 'gi://GLib';

import { log } from './log.js';

// In-memory MRU model - the single source of truth for the running session.
//
// Record shape:
//   { id, hash, kind, mime, encoding, text|null, data|null, uri|null,
//     bytes, preview, createdAt, usedAt }
//
// Ordering: usedAt descending. Re-copying / re-selecting updates usedAt -> floats to top.

let _seq = 0;

function newId() {
    return `${GLib.get_real_time().toString(36)}-${(_seq++).toString(36)}`;
}

export class History {
    constructor({ opts, store, onChange }) {
        this._opts = opts;             // config.history
        this._store = store;
        this._onChange = onChange ?? (() => {});
        this._records = [];
        this._byHash = new Map();
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
        const loaded = [];
        const seen = new Set();
        for (const r of records) {
            if (this._opts.dedup && seen.has(r.hash))
                continue;
            seen.add(r.hash);
            loaded.push(r);
            if (loaded.length >= this._opts.maxItems)
                break;
        }
        this._records = loaded;
        this._byHash.clear();
        for (const r of this._records)
            this._byHash.set(r.hash, r);
    }

    _sort() {
        this._records.sort((a, b) => b.usedAt - a.usedAt);
    }

    /**
     * Add/refresh an entry. `rec` carries content fields already resolved by the caller
     * (text/data/uri, preview, bytes, hash, kind, mime).
     * Returns the live record.
     */
    add(rec) {
        const now = GLib.get_real_time();
        const existing = this._byHash.get(rec.hash);
        if (existing && this._opts.dedup) {
            existing.usedAt = now;
            this._sort();
            this._persist();
            this._onChange();
            return existing;
        }

        const record = {
            id: newId(),
            createdAt: now,
            usedAt: now,
            encoding: rec.data ? 'base64' : 'utf8',
            text: null,
            data: null,
            uri: null,
            ...rec,
        };
        this._records.push(record);
        this._byHash.set(record.hash, record);
        this._evict();
        this._sort();
        this._persist();
        this._onChange();
        return record;
    }

    /** Promote an existing record to the top (used on restore). */
    touch(record) {
        record.usedAt = GLib.get_real_time();
        this._sort();
        this._persist();
        this._onChange();
    }

    remove(id) {
        const i = this._records.findIndex(r => r.id === id);
        if (i < 0) return;
        const [r] = this._records.splice(i, 1);
        this._byHash.delete(r.hash);
        this._persist();
        this._onChange();
    }

    clear() {
        this._records = [];
        this._byHash.clear();
        this._persist();
        this._onChange();
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
        if (o.maxAgeDays > 0) {
            const cutoff = GLib.get_real_time() - o.maxAgeDays * 86400 * 1e6;
            for (const r of this._records.slice())
                if (r.usedAt < cutoff) this._dropQuiet(r.id);
        }

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
        const [r] = this._records.splice(i, 1);
        this._byHash.delete(r.hash);
    }
}
