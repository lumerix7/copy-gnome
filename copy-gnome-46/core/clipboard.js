import GLib from 'gi://GLib';
import St from 'gi://St';

import { log } from './log.js';

// Thin promise wrappers around St.Clipboard for the CLIPBOARD selection.
// Works on Wayland because the extension runs inside the compositor.

const T = St.ClipboardType.CLIPBOARD;
const READ_TIMEOUT_MS = 2000;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;

function clip() {
    return St.Clipboard.get_default();
}

/** @returns {Promise<string|null>} */
export function getText() {
    return withTimeout('clipboard text read', resolve => {
        try {
            clip().get_text(T, (_c, text) => resolve(text ?? null));
        } catch (e) {
            log.warn(`clipboard text read failed: ${e.message}`);
            resolve(null);
        }
    });
}

/**
 * Read arbitrary content for a mimetype and immediately detach it from GBytes.
 *
 * Some clipboard providers hand Shell a transient GBytes. Keeping that boxed native object
 * across async boundaries can destabilize GJS/Shell, so callers only receive a JS-owned copy.
 *
 * @returns {Promise<{ok: boolean, bytes: Uint8Array|null, reason: string}>}
 */
export function getContentResult(mimetype, maxBytes = MAX_CONTENT_BYTES) {
    return withTimeout(`clipboard ${mimetype} read`, resolve => {
        try {
            clip().get_content(T, mimetype, (_c, bytes) => {
                try {
                    if (!bytes || bytes.get_size() === 0) {
                        resolve({ ok: false, bytes: null, reason: 'empty' });
                        return;
                    }
                    if (bytes.get_size() > maxBytes) {
                        log.warn(`clipboard ${mimetype} skipped: ${bytes.get_size()} bytes exceeds cap ${maxBytes} bytes`);
                        resolve({ ok: false, bytes: null, reason: 'oversize' });
                        return;
                    }
                    resolve({ ok: true, bytes: Uint8Array.from(bytes.get_data()), reason: '' });
                } catch (e) {
                    log.warn(`clipboard ${mimetype} bytes read failed: ${e.message}`);
                    resolve({ ok: false, bytes: null, reason: 'callback-error' });
                }
            });
        } catch (e) {
            log.warn(`clipboard ${mimetype} read failed: ${e.message}`);
            resolve({ ok: false, bytes: null, reason: 'read-error' });
        }
    }, { ok: false, bytes: null, reason: 'timeout' });
}

/** @returns {Promise<Uint8Array|null>} */
export async function getContent(mimetype, maxBytes = MAX_CONTENT_BYTES) {
    const result = await getContentResult(mimetype, maxBytes);
    return result.ok ? result.bytes : null;
}

function withTimeout(label, start, timeoutValue = null) {
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
            if (!done) {
                done = true;
                timer = 0;
                log.warn(`${label} timed out`);
                resolve(timeoutValue);
            }
            return GLib.SOURCE_REMOVE;
        });
        try {
            start(finish);
        } catch (e) {
            log.warn(`${label} failed: ${e.message}`);
            finish(timeoutValue);
        }
    });
}

export function setText(text) {
    try {
        clip().set_text(T, text);
        return true;
    } catch (e) {
        log.warn(`clipboard text write failed: ${e.message}`);
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
        log.warn(`clipboard ${mimetype} write failed: ${e.message}`);
        return false;
    }
}
