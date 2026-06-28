const _enc = new TextEncoder();

export const PLAIN_TEXT_MIME = 'text/plain;charset=utf-8';
export const HTML_MIME = 'text/html';
export const RTF_MIME = 'text/rtf';
export const RICHTEXT_MIME = 'text/richtext';
export const MARKDOWN_MIME = 'text/markdown';
export const URI_LIST_MIME = 'text/uri-list';

const TEXT_MIMES = [PLAIN_TEXT_MIME, 'text/plain', 'UTF8_STRING'];
export const RICH_TEXT_MIMES = [HTML_MIME, RTF_MIME, RICHTEXT_MIME, MARKDOWN_MIME];
const RICH_COMPARABLE_SEPARATOR = '\u0000';

export function textBytes(text) {
    return _enc.encode(String(text ?? '')).length;
}

export function makePayload(mime, encoding, value, bytes = null) {
    const stringValue = String(value ?? '');
    return {
        mime,
        encoding,
        value: stringValue,
        bytes: Number.isFinite(bytes) ? bytes : textBytes(stringValue),
    };
}

export function makeTextPayload(mime, text, bytes = null) {
    return makePayload(mime || PLAIN_TEXT_MIME, 'utf8', text, bytes);
}

export function primaryPayload(rec) {
    return Array.isArray(rec?.payloads) ? rec.payloads[0] ?? null : null;
}

export function payloadByMime(rec, mime) {
    if (!Array.isArray(rec?.payloads))
        return null;
    return rec.payloads.find(p => p?.mime === mime) ?? null;
}

export function firstPayload(rec, predicate) {
    if (!Array.isArray(rec?.payloads))
        return null;
    return rec.payloads.find(predicate) ?? null;
}

export function plainTextPayload(rec) {
    if (!Array.isArray(rec?.payloads))
        return null;
    for (const mime of TEXT_MIMES) {
        const payload = payloadByMime(rec, mime);
        if (payload)
            return payload;
    }
    return firstPayload(rec, p => typeof p?.mime === 'string' && p.mime.startsWith('text/plain'));
}

export function htmlPayload(rec) {
    return payloadByMime(rec, HTML_MIME);
}

export function richPayload(rec) {
    const primary = primaryPayload(rec);
    if (primary && RICH_TEXT_MIMES.includes(primary.mime))
        return primary;
    return firstPayload(rec, p => RICH_TEXT_MIMES.includes(p?.mime));
}

export function uriListPayload(rec) {
    return payloadByMime(rec, URI_LIST_MIME);
}

export function binaryPayload(rec) {
    return firstPayload(rec, p => p?.encoding === 'base64') ?? primaryPayload(rec);
}

export function payloadValue(rec, mime) {
    return payloadByMime(rec, mime)?.value ?? null;
}

export function payloadBytesTotal(payloads) {
    if (!Array.isArray(payloads))
        return 0;
    return payloads.reduce((sum, p) => sum + (Number.isFinite(p?.bytes) ? p.bytes : 0), 0);
}

export function isRichRecord(rec) {
    return rec?.kind === 'rich' && !!richPayload(rec) && !!plainTextPayload(rec);
}

export function richComparableValue(rich, plain) {
    return `${String(rich ?? '')}${RICH_COMPARABLE_SEPARATOR}${String(plain ?? '')}`;
}

export function recordComparableValue(rec) {
    if (!rec)
        return null;
    if (rec.kind === 'rich') {
        const rich = richPayload(rec)?.value;
        const plain = plainTextPayload(rec)?.value;
        return typeof rich === 'string' && typeof plain === 'string'
            ? richComparableValue(rich, plain)
            : null;
    }
    if (rec.kind === 'text')
        return plainTextPayload(rec)?.value ?? null;
    if (rec.kind === 'file')
        return uriListPayload(rec)?.value ?? null;
    if (rec.kind === 'image' || rec.kind === 'binary')
        return binaryPayload(rec)?.value ?? null;
    return null;
}

export function recordComparableType(rec) {
    return rec?.kind ?? null;
}
