import GLib from 'gi://GLib';

// sha256 over raw bytes. Used as the in-memory dedup key and a diagnostic content id.
// Collision resistance still matters -> sha256, not sha1 (see docs/04-storage.md).

const _encoder = new TextEncoder();

/** @param {Uint8Array} u8 */
export function sha256Bytes(u8) {
    return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, u8);
}

/** @param {string} text */
export function sha256Text(text) {
    return sha256Bytes(_encoder.encode(text));
}

/** UTF-8 byte length of a string. */
export function byteLength(text) {
    return _encoder.encode(text).length;
}

export function encodeUtf8(text) {
    return _encoder.encode(text);
}
