import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { log } from './log.js';
import * as Clipboard from './clipboard.js';

// Watches Mutter's selection for clipboard-owner changes (the Wayland-correct way; no
// polling). On each change it reads the new contents, classifies them, and hands a
// normalized candidate to `onCapture`.
//
// Candidate shapes:
//   { kind: 'text', mime, text }
//   { kind: 'file', mime: 'text/uri-list', text }   // text = newline-joined uris
//   { kind: 'image', mime, bytes }                  // bytes = JS-owned Uint8Array
//
// Self-write guard: when we restore an entry we call expect(hash); the next capture whose
// hash matches is swallowed so our own writes don't re-enter the history.

const EXPECT_TTL_MS = 2500;
const IMAGE_READ_FAILURE_LIMIT = 3;

function supportedImageMime(mimes) {
    // Keep the Shell-side image path narrow. Screenshots on GNOME normally offer PNG;
    // other image/* targets can have provider-specific behavior and are skipped for now.
    return mimes.includes('image/png') ? 'image/png' : null;
}

export class Monitor {
    constructor({
        onCapture, captureFiles, captureImages, maxItemBytes,
        maxBinaryBytes, secretMimes,
    }) {
        this._onCapture = onCapture;
        this._captureFiles = captureFiles ?? (() => false);
        this._captureImages = captureImages ?? (() => false);
        this._maxItemBytes = maxItemBytes ?? (() => 16 * 1024 * 1024);
        this._maxBinaryBytes = maxBinaryBytes ?? this._maxItemBytes;
        this._secretMimes = secretMimes ?? (() => []);
        this._selection = null;
        this._ownerChangedId = 0;
        this._expected = new Map();   // hash -> GLib source id (timeout)
        this._reading = false;
        this._pendingSource = null;
        this._imageReadFailures = 0;
        this._imageCaptureDisabled = false;
        this._stopped = true;
    }

    start() {
        try {
            this._selection = global.display.get_selection();
            this._ownerChangedId = this._selection.connect('owner-changed',
                (_sel, selType, source) => this._onOwnerChanged(selType, source));
            this._stopped = false;
            log.debug('monitor started');
        } catch (e) {
            this._selection = null;
            this._ownerChangedId = 0;
            this._stopped = true;
            log.warn(`monitor failed to start: ${e.message}`);
        }
    }

    stop() {
        this._stopped = true;
        this._pendingSource = null;
        if (this._ownerChangedId) {
            try {
                this._selection?.disconnect(this._ownerChangedId);
            } catch (e) {
                log.warn(`monitor disconnect failed: ${e.message}`);
            }
            this._ownerChangedId = 0;
        }
        this._selection = null;
        for (const id of this._expected.values()) {
            try {
                GLib.Source.remove(id);
            } catch (e) {
                log.debug(`expected timer cleanup failed: ${e.message}`);
            }
        }
        this._expected.clear();
    }

    /** Mark a hash as self-induced so the resulting capture is ignored. */
    expect(hash) {
        if (this._expected.has(hash))
            GLib.Source.remove(this._expected.get(hash));
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EXPECT_TTL_MS, () => {
            this._expected.delete(hash);
            return GLib.SOURCE_REMOVE;
        });
        this._expected.set(hash, id);
    }

    /** @returns {boolean} true if `hash` was expected (and consumes it). */
    consumeExpected(hash) {
        if (!this._expected.has(hash)) return false;
        GLib.Source.remove(this._expected.get(hash));
        this._expected.delete(hash);
        return true;
    }

    _onOwnerChanged(selType, source) {
        if (this._stopped)
            return;

        try {
            // Only the CLIPBOARD selection is monitored (PRIMARY / middle-click capture removed).
            if (selType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
            if (!source) return;   // selection cleared

            this._read(source).catch(e => log.warn(`read failed: ${e.message}`));
        } catch (e) {
            log.warn(`owner change ignored: ${e.message}`);
        }
    }

    // Remember the newest owner and ensure exactly one read loop runs. A change that arrives
    // while a read is in flight updates _pendingSource instead of being dropped, so the
    // newest clipboard contents always reach the history. (Previously rapid successive copies
    // during an in-flight async read were lost and the latest item never showed up.)
    _read(source) {
        this._pendingSource = source;
        if (this._reading)
            return Promise.resolve();
        return this._drain();
    }

    async _drain() {
        this._reading = true;
        try {
            while (this._pendingSource && !this._stopped) {
                const source = this._pendingSource;
                this._pendingSource = null;
                await this._readOnce(source);
            }
        } finally {
            this._reading = false;
        }
    }

    async _readOnce(source) {
        try {
            let mimes = [];
            try {
                mimes = (source.get_mimetypes() ?? []).filter(m => typeof m === 'string');
            } catch (e) {
                mimes = [];
            }

            const has = m => mimes.includes(m);

            // Privacy: skip password-manager / concealed selections.
            const secret = this._secretMimes();
            if (secret.length && mimes.some(m => secret.includes(m))) {
                log.debug('skipping concealed selection');
                return;
            }

            const imageMime = supportedImageMime(mimes);
            const hasUnsupportedImage = !imageMime && mimes.some(m => m.startsWith('image/'));

            if (has('text/uri-list') || has('x-special/gnome-copied-files')) {
                if (!this._captureFiles()) {
                    log.debug('skipping file selection; file capture disabled');
                    return;
                }
                const bytes = await Clipboard.getContent('text/uri-list', this._maxItemBytes());
                if (this._stopped) return;
                const text = bytes ? new TextDecoder().decode(bytes).trim() : null;
                if (text)
                    this._onCapture({ kind: 'file', mime: 'text/uri-list', text });
                return;
            }

            // Prefer text when offered; many apps offer both text and image targets.
            // If this is image-only but not a supported image target, skip it below instead
            // of probing text APIs unnecessarily.
            if (has('text/plain;charset=utf-8') || has('text/plain') || has('UTF8_STRING') ||
                    (!imageMime && !hasUnsupportedImage)) {
                const text = await Clipboard.getText();
                if (this._stopped) return;
                if (text && text.length > 0) {
                    this._onCapture({ kind: 'text', mime: 'text/plain;charset=utf-8', text });
                    return;
                }
            }

            if (imageMime || hasUnsupportedImage) {
                if (!this._captureImages()) {
                    log.debug('skipping image selection; image capture disabled');
                    return;
                }
                if (this._imageCaptureDisabled) {
                    log.debug('skipping image selection; image capture disabled after read failures');
                    return;
                }
                if (!imageMime) {
                    log.warn('skipping image selection; no supported image/png target');
                    return;
                }
                const maxBytes = this._maxBinaryBytes();
                if (maxBytes <= 0) {
                    log.debug('skipping image selection; inline binary cap is zero');
                    return;
                }
                const result = await Clipboard.getContentResult(imageMime, maxBytes);
                if (this._stopped) return;
                if (!result.ok) {
                    this._noteImageReadFailure(result.reason, imageMime);
                    return;
                }
                this._imageReadFailures = 0;
                this._onCapture({ kind: 'image', mime: imageMime, bytes: result.bytes });
                return;
            }
        } catch (e) {
            log.warn(`read failed: ${e.message}`);
        }
    }

    _noteImageReadFailure(reason, mime) {
        if (reason === 'empty' || reason === 'oversize')
            return;
        this._imageReadFailures += 1;
        if (this._imageReadFailures >= IMAGE_READ_FAILURE_LIMIT) {
            this._imageCaptureDisabled = true;
            log.error(`image capture disabled for this session after ${this._imageReadFailures} read failures`);
            return;
        }
        log.warn(`image clipboard read failed (${mime}, ${reason}); failure ${this._imageReadFailures}/${IMAGE_READ_FAILURE_LIMIT}`);
    }
}
