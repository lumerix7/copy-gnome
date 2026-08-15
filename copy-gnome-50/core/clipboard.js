import GLib from 'gi://GLib';
import St from 'gi://St';

import { log } from './log.js';

// Thin promise wrappers around St.Clipboard for the CLIPBOARD selection.
// Works on Wayland because the extension runs inside the compositor.

const T = St.ClipboardType.CLIPBOARD;
const READ_TIMEOUT_MS = 2000;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_IN_FLIGHT = 2;
let inFlight = 0;

export class ClipboardReadScope {
    constructor() {
        this.retired = false;
        this.waiters = new Set();
    }

    close() {
        this.retired = true;
        for (const expire of this.waiters)
            expire();
        this.waiters.clear();
    }
}

function clip() {
    return St.Clipboard.get_default();
}

/** @returns {Promise<string|null>} */
export function getText(scope = null) {
    return withTimeout('clipboard text read',
        complete => clip().get_text(T, complete),
        text => text ?? null, () => null, scope);
}

/**
 * Read arbitrary content for a mimetype and immediately detach it from GBytes.
 *
 * Some clipboard providers hand Shell a transient GBytes. Keeping that boxed native object
 * across async boundaries can destabilize GJS/Shell, so callers only receive a JS-owned copy.
 *
 * @returns {Promise<{ok: boolean, bytes: Uint8Array|null, reason: string}>}
 */
export function getContentResult(mimetype, maxBytes = MAX_CONTENT_BYTES, scope = null) {
    const failure = reason => ({ ok: false, bytes: null, reason });
    return withTimeout(`clipboard ${mimetype} read`,
        complete => clip().get_content(T, mimetype, complete),
        bytes => {
            const size = bytes?.get_size() ?? 0;
            if (!size)
                return failure('empty');
            if (size > maxBytes) {
                log.warn(`clipboard ${mimetype} skipped: ${size} bytes exceeds cap ${maxBytes} bytes`);
                return failure('oversize');
            }
            return { ok: true, bytes: Uint8Array.from(bytes.get_data()), reason: '' };
        }, failure, scope);
}

/** @returns {Promise<Uint8Array|null>} */
export async function getContent(mimetype, maxBytes = MAX_CONTENT_BYTES) {
    const result = await getContentResult(mimetype, maxBytes);
    return result.ok ? result.bytes : null;
}

function withTimeout(label, start, copy, failure, scope) {
    if (scope?.retired)
        return Promise.resolve(failure('cancelled'));
    if (inFlight >= MAX_IN_FLIGHT) {
        log.debug('clipboard read skipped: native reads still in flight');
        return Promise.resolve(failure('busy'));
    }

    return new Promise(resolve => {
        log.debug(`${label}: started`);
        let done = false;
        let timer = 0;
        let reserved = false;
        const release = () => {
            if (reserved) {
                reserved = false;
                inFlight--;
            }
        };
        const finish = value => {
            if (done)
                return;
            done = true;
            scope?.waiters.delete(expire);
            if (timer) {
                try {
                    GLib.Source.remove(timer);
                } catch (e) {
                    log.error(`${label}: remove deadline`, e);
                }
                timer = 0;
            }
            log.debug(`${label}: finished waiting`);
            resolve(value);
        };
        const expire = () => finish(failure('cancelled'));
        scope?.waiters.add(expire);
        try {
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, READ_TIMEOUT_MS, () => {
                timer = 0;
                log.warn(`${label} timed out`);
                // St has no cancellation handle. Keep the slot until its callback.
                finish(failure('timeout'));
                return GLib.SOURCE_REMOVE;
            });
            inFlight++;
            reserved = true;
            start((_clipboard, value) => {
                if (!reserved)
                    return;
                release();
                if (done)
                    return;
                try {
                    finish(copy(value));
                } catch (error) {
                    log.error(`${label} callback`, error);
                    finish(failure('callback-error'));
                }
            });
        } catch (e) {
            release();
            log.error(`${label} failed`, e);
            finish(failure('read-error'));
        }
    });
}

export function setText(text) {
    try {
        clip().set_text(T, text);
        return true;
    } catch (e) {
        log.error('clipboard text write failed', e);
        return false;
    }
}

/** @param {Uint8Array|GLib.Bytes} bytes */
export function setContent(mimetype, bytes) {
    try {
        const payload = typeof bytes?.get_size === 'function' ? bytes : new GLib.Bytes(bytes);
        clip().set_content(T, mimetype, payload);
        return true;
    } catch (e) {
        log.error(`clipboard ${mimetype} write failed`, e);
        return false;
    }
}
