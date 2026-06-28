import {
    binaryPayload,
    plainTextPayload,
    uriListPayload,
} from './payloads.js';

export const DEFAULT_PREVIEW_CHARS = 100;
export const POPUP_PREVIEW_CHARS = 512;

export function compactTextPrefix(text, max = DEFAULT_PREVIEW_CHARS) {
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (limit === 0)
        return '';

    let out = '';
    let pendingSpace = false;
    let started = false;
    for (const ch of String(text ?? '')) {
        if (/\s/.test(ch)) {
            if (started)
                pendingSpace = true;
            continue;
        }
        if (pendingSpace && out.length < limit)
            out += ' ';
        pendingSpace = false;
        started = true;
        if (out.length >= limit)
            break;
        out += ch;
        if (out.length >= limit)
            break;
    }
    return out;
}

function fileUriPath(uri) {
    const text = String(uri ?? '');
    if (!text.startsWith('file://'))
        return text;
    try {
        return decodeURIComponent(text.slice('file://'.length));
    } catch (e) {
        return text.slice('file://'.length);
    }
}

function firstUriListLine(uriList) {
    const text = String(uriList ?? '');
    let pos = 0;
    while (pos < text.length) {
        const end = text.indexOf('\n', pos);
        const lineEnd = end < 0 ? text.length : end;
        const line = text.slice(pos, lineEnd).trim();
        if (line)
            return { line, hasMore: end >= 0 && hasNonEmptyLineAfter(text, end + 1) };
        if (end < 0)
            break;
        pos = end + 1;
    }
    return { line: '', hasMore: false };
}

function hasNonEmptyLineAfter(text, pos) {
    for (let i = pos; i < text.length; i++) {
        if (!/\s/.test(text[i]))
            return true;
    }
    return false;
}

function filePreview(uriList, max) {
    const { line, hasMore } = firstUriListLine(uriList);
    const first = fileUriPath(line);
    const label = hasMore ? `${first} (+more)` : first;
    return compactTextPrefix(label, max);
}

function sizePreview(kind, bytes) {
    const size = Number(bytes);
    const kb = Number.isFinite(size) && size >= 0 ? Math.round(size / 1024) : 0;
    return `[${kind || 'binary'} ${kb} KB]`;
}

export function recordPreview(rec, { max = DEFAULT_PREVIEW_CHARS } = {}) {
    const plain = plainTextPayload(rec)?.value;
    if (plain)
        return compactTextPrefix(plain, max);

    const uriList = uriListPayload(rec)?.value;
    if (uriList)
        return filePreview(uriList, max);

    if (rec?.kind === 'image' || rec?.kind === 'binary') {
        const payload = binaryPayload(rec);
        return sizePreview(rec.kind, payload?.bytes ?? rec.bytes);
    }

    return `[${rec?.kind ?? 'unknown'}]`;
}
