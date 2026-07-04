import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { log } from './log.js';
import { encodeUtf8 } from './utf8.js';
import { binaryPayload, plainTextPayload, richPayload } from './payloads.js';

// Save-as support for history records (docs/07-ui.md) - every kind except `file`, which
// only holds URI references. GTK dialogs cannot run inside gnome-shell, so the dialog is
// the XDG desktop portal's FileChooser.SaveFile - a separate portal process draws it;
// this module only speaks DBus and writes the bytes to the returned target. Fail-closed:
// every failure resolves to null/false and logs with the `[save]:` prefix; nothing here
// may throw into the Shell.

const PORTAL_BUS = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const FILECHOOSER_IFACE = 'org.freedesktop.portal.FileChooser';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
// A dialog left open past this is treated as cancelled so the signal subscription and
// timer can't leak forever if the portal never answers.
const RESPONSE_TIMEOUT_SEC = 600;

function existingDirectory(path) {
    try {
        return typeof path === 'string' && path && GLib.file_test(path, GLib.FileTest.IS_DIR);
    } catch (e) {
        log.debug(`[save]: directory check failed path=${path ?? '(none)'}: ${e.message}`);
        return false;
    }
}

function pathVariant(path) {
    return new GLib.Variant('ay', [...encodeUtf8(path), 0]);
}

export function defaultSaveDirectory() {
    const candidates = [
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD),
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS),
        GLib.get_home_dir(),
    ];
    return candidates.find(existingDirectory) ?? null;
}

const MIME_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/avif': 'avif',
    'image/heif': 'heif',
    'image/heic': 'heic',
};

function sniffImageExtension(bytes) {
    const b = bytes;
    if (!b || b.length < 12)
        return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
        return 'png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return 'jpg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
        return 'gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
        return 'webp';
    if (b[0] === 0x42 && b[1] === 0x4d)
        return 'bmp';
    return null;
}

// Suffix policy for binary payloads (docs/07-ui.md): the record's stored mime wins; an
// unknown mime falls back to magic-byte sniffing of the decoded payload; if both fail,
// `.bin` - never guess.
export function binaryFileExtension(mime, bytes) {
    return MIME_EXTENSIONS[String(mime ?? '').toLowerCase()] ??
        sniffImageExtension(bytes) ??
        'bin';
}

const RICH_EXTENSIONS = {
    'text/html': 'html',
    'text/rtf': 'rtf',
    'text/richtext': 'rtf',
    'text/markdown': 'md',
};

/**
 * What to write for a record, or null when it is not saveable (`file` records hold only
 * URI references; damaged records have no usable payload). Per kind: text saves the
 * plain payload as `.txt`; rich saves the primary rich payload (`.html`/`.rtf`/`.md` by
 * mime, plain fallback `.txt`); image and other binary payloads decode the base64 value
 * and take the suffix from binaryFileExtension().
 *
 * @returns {{bytes: Uint8Array, extension: string}|null}
 */
export function savePlan(rec) {
    try {
        if (!rec || rec.kind === 'file')
            return null;
        if (rec.kind === 'text') {
            const payload = plainTextPayload(rec);
            return payload ? { bytes: encodeUtf8(payload.value), extension: 'txt' } : null;
        }
        if (rec.kind === 'rich') {
            const rich = richPayload(rec);
            if (rich)
                return { bytes: encodeUtf8(rich.value), extension: RICH_EXTENSIONS[rich.mime] ?? 'txt' };
            const plain = plainTextPayload(rec);
            return plain ? { bytes: encodeUtf8(plain.value), extension: 'txt' } : null;
        }
        const payload = binaryPayload(rec);
        if (!payload)
            return null;
        if (payload.encoding === 'base64') {
            const u8 = GLib.base64_decode(payload.value);
            if (!u8 || u8.length === 0)
                return null;
            return { bytes: u8, extension: binaryFileExtension(rec.mime, u8) };
        }
        return typeof payload.value === 'string' && payload.value
            ? { bytes: encodeUtf8(payload.value), extension: 'txt' }
            : null;
    } catch (e) {
        log.warn(`[save]: plan failed recordId=${rec?.id ?? '(none)'}: ${e.message}`);
        return null;
    }
}

/** Default dialog name: clip-<kind>-YYYYMMDD_HHMMSS.<ext> from the record's local capture time. */
export function defaultSaveName(kind, createdAtUs, extension) {
    const kindPart = String(kind ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'item';
    let stamp = null;
    try {
        const us = Number.isFinite(createdAtUs) && createdAtUs > 0
            ? createdAtUs
            : GLib.get_real_time();
        stamp = GLib.DateTime.new_from_unix_local(Math.floor(us / 1000000))?.format('%Y%m%d_%H%M%S') ?? null;
    } catch (e) {
        log.debug(`[save]: name stamp failed: ${e.message}`);
    }
    return stamp ? `clip-${kindPart}-${stamp}.${extension}` : `clip-${kindPart}.${extension}`;
}

let _tokenCounter = 0;

/**
 * Open the portal save dialog. Resolves with the chosen target URI, or null on
 * cancel/failure/timeout. Never rejects.
 */
export function saveFileDialog({
    title = 'Save clipboard item',
    suggestedName = 'clip.bin',
    currentFolder = defaultSaveDirectory(),
} = {}) {
    return new Promise(resolve => {
        const connection = Gio.DBus.session;
        let done = false;
        let signalId = 0;
        let timerId = 0;
        const finish = uri => {
            if (done)
                return;
            done = true;
            if (signalId) {
                try {
                    connection.signal_unsubscribe(signalId);
                } catch (e) {
                    log.debug(`[save]: unsubscribe failed: ${e.message}`);
                }
                signalId = 0;
            }
            if (timerId) {
                try {
                    GLib.Source.remove(timerId);
                } catch (e) {
                    log.debug(`[save]: timer cleanup failed: ${e.message}`);
                }
                timerId = 0;
            }
            resolve(uri);
        };
        const subscribe = handlePath => connection.signal_subscribe(
            PORTAL_BUS, REQUEST_IFACE, 'Response', handlePath, null,
            Gio.DBusSignalFlags.NONE,
            (_c, _sender, _path, _iface, _signal, params) => {
                try {
                    const [response, results] = params.deepUnpack();
                    if (response !== 0) {
                        log.debug(`[save]: dialog closed response=${response}`);
                        finish(null);
                        return;
                    }
                    const uris = results?.uris?.deepUnpack?.() ?? [];
                    finish(typeof uris[0] === 'string' && uris[0] ? uris[0] : null);
                } catch (e) {
                    log.warn(`[save]: portal response parse failed: ${e.message}`);
                    finish(null);
                }
            });

        try {
            // Predictable request path per the portal spec: subscribe before calling so the
            // Response can't race the reply; verify the returned handle and resubscribe if an
            // older portal returns a different one.
            const token = `copygnome${++_tokenCounter}`;
            const sender = connection.get_unique_name().slice(1).replace(/\./g, '_');
            const expectedHandle = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
            signalId = subscribe(expectedHandle);

            const options = {
                handle_token: new GLib.Variant('s', token),
                current_name: new GLib.Variant('s', suggestedName),
            };
            if (existingDirectory(currentFolder))
                options.current_folder = pathVariant(currentFolder);
            connection.call(
                PORTAL_BUS, PORTAL_PATH, FILECHOOSER_IFACE, 'SaveFile',
                new GLib.Variant('(ssa{sv})', ['', title, options]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => {
                    try {
                        const [handle] = conn.call_finish(res).deepUnpack();
                        if (handle !== expectedHandle && !done) {
                            try {
                                connection.signal_unsubscribe(signalId);
                            } catch (e) {
                                log.debug(`[save]: resubscribe cleanup failed: ${e.message}`);
                            }
                            signalId = subscribe(handle);
                        }
                    } catch (e) {
                        log.warn(`[save]: portal SaveFile failed: ${e.message}`);
                        finish(null);
                    }
                });

            timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESPONSE_TIMEOUT_SEC, () => {
                timerId = 0;
                log.warn('[save]: portal response timed out');
                finish(null);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            log.warn(`[save]: portal call setup failed: ${e.message}`);
            finish(null);
        }
    });
}

/** Write bytes to a portal-returned URI. Resolves true/false, never rejects. */
export function writeBytesToUri(uri, u8) {
    return new Promise(resolve => {
        try {
            const file = Gio.File.new_for_uri(uri);
            file.replace_contents_bytes_async(
                new GLib.Bytes(u8), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                        resolve(true);
                    } catch (e) {
                        log.warn(`[save]: write failed uri=${uri}: ${e.message}`);
                        resolve(false);
                    }
                });
        } catch (e) {
            log.warn(`[save]: write setup failed uri=${uri}: ${e.message}`);
            resolve(false);
        }
    });
}

/** Human path for notifications: filesystem path when the URI has one, else the URI. */
export function uriDisplayPath(uri) {
    try {
        return Gio.File.new_for_uri(uri).get_path() ?? uri;
    } catch (e) {
        log.debug(`[save]: display path failed: ${e.message}`);
        return uri;
    }
}
