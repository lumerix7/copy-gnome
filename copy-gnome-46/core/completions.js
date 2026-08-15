import GLib from 'gi://GLib';

import { errorMessage, log } from './log.js';

let nextId = 0;
const pending = new Map();

function invoke(stage, callback, ...args) {
    try {
        return callback?.(...args);
    } catch (error) {
        log.error(stage, error);
    }
}

function delivery(id, result) {
    return () => {
        const entry = pending.get(id);
        if (entry) {
            const idleSource = entry.idleSource;
            if (idleSource)
                entry.idleSource = 0;
            if (!entry.repeat) {
                pending.delete(id);
                entry.ids.delete(id);
            }
            invoke(entry.stage, entry.complete, result);
            if (idleSource)
                log.debug(`${entry.stage}: idle update finished`);
        }
        return GLib.SOURCE_REMOVE;
    };
}

function post(id, result) {
    if (!pending.has(id))
        return;
    try {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, delivery(id, result));
    } catch (error) {
        log.error('completion dispatch', error);
    }
}

// Promise continuations only carry a scalar ID and work data. Synchronous Shell
// callbacks live in the registry and are removed before their owner is destroyed.
function observe(id, stage, work) {
    void Promise.resolve(work).then(
        value => post(id, { ok: true, value }),
        error => {
            log.error(stage, error);
            post(id, { ok: false, error: errorMessage(error) });
        });
}

function publisher(id) {
    return value => post(id, value);
}

function signalHandler(id, stopped) {
    return (...args) => {
        const entry = pending.get(id);
        if (entry)
            return invoke(entry.stage, entry.complete, ...args) ?? stopped;
        return stopped;
    };
}

function cancelPending(id) {
    const entry = pending.get(id);
    if (!entry)
        return;
    pending.delete(id);
    entry.ids.delete(id);
    invoke(entry.stage, entry.cancel);
}

// A signal publisher carries only a registry ID and coalesces events until dispatch.
function idlePublisher(id) {
    return () => {
        const entry = pending.get(id);
        if (!entry || entry.idleSource)
            return;
        try {
            entry.idleSource = GLib.idle_add(GLib.PRIORITY_DEFAULT, delivery(id));
            log.debug(`${entry.stage}: idle update scheduled`);
        } catch (error) {
            log.error(entry.stage, error);
        }
    };
}

function timerCallback(id) {
    return () => {
        const entry = pending.get(id);
        if (!entry)
            return GLib.SOURCE_REMOVE;
        const stage = entry.stage;
        try {
            log.debug(`${stage}: tick`);
            void Promise.resolve(entry.complete()).then(
                () => log.debug(`${stage}: finished`),
                error => log.error(stage, error));
        } catch (error) {
            log.error(stage, error);
        }
        return GLib.SOURCE_CONTINUE;
    };
}

export class Completions {
    constructor() {
        this._ids = new Set();
        this._closed = false;
    }

    add(stage, work, complete, cancel = null) {
        if (this._closed) {
            invoke(stage, cancel);
            observe(0, stage, work);
            return;
        }
        const id = ++nextId;
        this._ids.add(id);
        pending.set(id, { stage, complete, cancel, ids: this._ids });
        observe(id, stage, work);
    }

    _registerListener(stage, complete) {
        const id = ++nextId;
        if (!this._closed) {
            this._ids.add(id);
            pending.set(id, { stage, complete, ids: this._ids, repeat: true });
        }
        return id;
    }

    listen(stage, complete) {
        return publisher(this._registerListener(stage, complete));
    }

    onSignal(stage, complete, stopped = undefined) {
        return signalHandler(this._registerListener(stage, complete), stopped);
    }

    onIdle(stage, complete) {
        const id = ++nextId;
        if (!this._closed) {
            const entry = { stage, complete, repeat: true, idleSource: 0 };
            entry.cancel = () => {
                if (entry.idleSource)
                    GLib.Source.remove(entry.idleSource);
            };
            pending.set(id, entry);
            this._ids.add(id);
        }
        return idlePublisher(id);
    }

    after(stage, milliseconds, complete) {
        if (this._closed)
            return null;
        const id = ++nextId;
        try {
            const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, delivery(id));
            pending.set(id, { stage, complete, cancel: () => GLib.Source.remove(source), ids: this._ids });
            this._ids.add(id);
            return () => cancelPending(id);
        } catch (error) {
            log.error(`${stage}: timeout setup`, error);
            return null;
        }
    }

    addTimer(stage, seconds, complete) {
        if (this._closed)
            return;
        const id = ++nextId;
        try {
            const source = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, timerCallback(id));
            this._ids.add(id);
            pending.set(id, { stage, complete, cancel: () => GLib.Source.remove(source), ids: this._ids });
            log.debug(`${stage}: timer added seconds=${seconds}`);
        } catch (error) {
            log.error(`${stage}: timer setup`, error);
        }
    }

    close() {
        this._closed = true;
        const entries = [];
        for (const id of this._ids) {
            entries.push(pending.get(id));
            pending.delete(id);
        }
        this._ids.clear();
        for (const entry of entries)
            invoke(entry.stage, entry.cancel);
    }
}
