// UTF-8 helpers for size checks and clipboard write-back.

const _encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function byteLength(text) {
    return _encoder.encode(text).length;
}

export function encodeUtf8(text) {
    return _encoder.encode(text);
}
