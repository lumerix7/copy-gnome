import GLib from 'gi://GLib';

import { getContentResult, getText } from './clipboard.js';
import { log } from './log.js';
import { PLAIN_TEXT_MIME, RICH_TEXT_MIMES, richComparableValue } from './payloads.js';

const TEXT_MIMES = [PLAIN_TEXT_MIME, 'text/plain', 'UTF8_STRING'];

function normalizeFileUri(line) {
    if (line.startsWith('file://'))
        return line;
    if (/^file:\/(?!\/)/.test(line))
        return `file://${line.slice('file:'.length)}`;
    return line;
}

// Canonical form for a uri-list: drop CRs/blank lines and trim each entry. Used as the
// file entry's stored content. Accept authority-less file:/absolute/path input but store
// standard file:///absolute/path output.
function normalizeUriList(text) {
    return text
        .split('\n')
        .map(line => line.replace(/\r$/, '').trim())
        .filter(Boolean)
        .map(normalizeFileUri)
        .join('\n');
}

function parseSpecialCopiedFiles(text) {
    const lines = text
        .split('\n')
        .map(line => line.replace(/\r$/, '').trim())
        .filter(Boolean);
    let action = 'unknown';
    if (lines.length > 0 && ['copy', 'cut'].includes(lines[0])) {
        action = lines.shift();
    }
    return {
        action,
        uriList: normalizeUriList(lines.join('\n')),
    };
}

// Each job contains only JS-owned owner metadata and primitive policy values.
// The scope belongs to the read, and has no link to the monitor or the Shell view.
async function readBytes(mime, limit, scope) {
    if (scope.retired)
        return { ok: false, reason: 'cancelled' };
    if (!(Number.isFinite(limit) && limit > 0))
        return { ok: false, reason: 'oversize' };
    if (TEXT_MIMES.includes(mime) || mime.startsWith('text/plain')) {
        const text = await getText(scope);
        if (scope.retired || !text)
            return { ok: false, reason: scope.retired ? 'cancelled' : 'empty' };
        if (text.length > limit)
            return { ok: false, reason: 'oversize' };
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > limit)
            return { ok: false, reason: 'oversize', bytesRead: bytes.length };
        return { ok: true, bytes };
    }
    return getContentResult(mime, limit, scope);
}

async function readFile(job, scope, ctx) {
    if (!job.captureFiles) {
        log.debug(`${ctx}: file capture skipped reason=disabled`);
        return null;
    }
    const offered = ['x-special/gnome-copied-files', 'text/uri-list'].filter(mime => job.mimes.includes(mime));
    for (const mime of offered) {
        const result = await readBytes(mime, job.maxItemBytes, scope);
        if (scope.retired)
            return null;
        if (!result.ok) {
            log.warn(`${ctx}: file clipboard read failed mime=${mime} reason=${result.reason} cap=${job.maxItemBytes}`);
            continue;
        }
        const raw = new TextDecoder().decode(result.bytes);
        const special = mime === 'x-special/gnome-copied-files' ? parseSpecialCopiedFiles(raw) : null;
        const text = special ? special.uriList : normalizeUriList(raw);
        log.debug(`${ctx}: file payload parsed sourceMime=${mime} fileAction=${special?.action ?? 'unknown'} bytes=${result.bytes.length}`);
        if (!text)
            return null;
        return { record: { kind: 'file', mime: 'text/uri-list', text }, value: text };
    }
    return null;
}

async function readCompanions(job, primaryMime, remaining, scope, ctx) {
    const payloads = [];
    for (const mime of RICH_TEXT_MIMES) {
        if (remaining <= 0 || scope.retired)
            break;
        if (mime === primaryMime || !job.mimes.includes(mime))
            continue;
        const result = await readBytes(mime, remaining, scope);
        if (scope.retired)
            break;
        if (!result.ok) {
            log.debug(`${ctx}: rich companion skipped mime=${mime} reason=${result.reason}`);
            continue;
        }
        const value = new TextDecoder().decode(result.bytes);
        if (value) {
            const bytes = result.bytes.length;
            payloads.push({ mime, encoding: 'utf8', value, bytes });
            remaining -= bytes;
            log.debug(`${ctx}: rich companion captured mime=${mime} bytes=${bytes}`);
        }
    }
    return payloads;
}

async function readText(job, plainMime, scope, ctx) {
    const limit = Math.min(job.maxTextBytes, job.maxItemBytes);
    const richMime = RICH_TEXT_MIMES.find(mime => job.mimes.includes(mime));
    let plain;
    if (richMime) {
        const rich = await readBytes(richMime, limit, scope);
        if (scope.retired)
            return null;
        if (rich.ok) {
            plain = await readBytes(plainMime, limit, scope);
            if (scope.retired)
                return null;
            if (plain.ok && rich.bytes.length + plain.bytes.length <= limit) {
                const richText = new TextDecoder().decode(rich.bytes);
                const text = new TextDecoder().decode(plain.bytes);
                if (richText && text) {
                    const companions = await readCompanions(job, richMime, limit - rich.bytes.length - plain.bytes.length, scope, ctx);
                    if (scope.retired)
                        return null;
                    log.debug(`${ctx}: rich payload read mime=${richMime} richBytes=${rich.bytes.length} textBytes=${plain.bytes.length}`);
                    return {
                        record: { kind: 'rich', mime: richMime, rich: richText, richBytes: rich.bytes.length,
                            text, textMime: PLAIN_TEXT_MIME, textBytes: plain.bytes.length, companionPayloads: companions },
                        value: richComparableValue(richText, text),
                    };
                }
            } else {
                log.warn(`${ctx}: rich capture fallback reason=${plain.ok ? 'combined-cap' : plain.reason} cap=${limit}`);
            }
        } else {
            log.warn(`${ctx}: rich capture fallback mime=${richMime} reason=${rich.reason}`);
        }
    }
    // A rich fallback reuses either result of the original plain read.
    plain ??= await readBytes(plainMime, limit, scope);
    if (scope.retired)
        return null;
    if (!plain.ok) {
        log.warn(`${ctx}: text clipboard read skipped mime=${plainMime} reason=${plain.reason} cap=${limit}`);
        return null;
    }
    const text = new TextDecoder().decode(plain.bytes);
    // An empty decoded plain payload may still fall through to an offered image.
    if (!text)
        return undefined;
    log.debug(`${ctx}: plain payload read mime=${plainMime} bytes=${plain.bytes.length}`);
    return { record: { kind: 'text', mime: PLAIN_TEXT_MIME, text }, value: text, sourceMime: plainMime };
}

export async function readCapture(job, scope, imageDisabled) {
    const ctx = `[${job.id},${job.seq}]`;
    log.debug(`${ctx}: capture read started mimes=${job.mimes.join(',')}`);
    try {
        if (scope.retired)
            return null;
        if (job.mimes.includes('text/uri-list') || job.mimes.includes('x-special/gnome-copied-files'))
            return await readFile(job, scope, ctx);
        const plainMime = TEXT_MIMES.find(mime => job.mimes.includes(mime)) ??
            job.mimes.find(mime => mime.startsWith('text/plain'));
        if (plainMime) {
            const result = await readText(job, plainMime, scope, ctx);
            if (result !== undefined || scope.retired)
                return result;
        }
        if (job.mimes.some(mime => mime.startsWith('image/'))) {
            if (!job.captureImages || imageDisabled) {
                log.debug(`${ctx}: image capture skipped reason=${imageDisabled ? 'disabled-after-failures' : 'disabled'}`);
                return null;
            }
            if (!job.mimes.includes('image/png')) {
                log.warn(`${ctx}: image clipboard read skipped reason=unsupported-mime supported=image/png`);
                return null;
            }
            const limit = Math.min(job.maxItemBytes, job.maxBinaryBytes);
            if (!limit) {
                log.warn(`${ctx}: image clipboard read skipped reason=binary-cap-zero`);
                return null;
            }
            const result = await readBytes('image/png', limit, scope);
            if (scope.retired)
                return null;
            if (!result.ok) {
                log.debug(`${ctx}: image clipboard read skipped reason=${result.reason} cap=${limit}`);
                return { imageFailure: result.reason };
            }
            log.debug(`${ctx}: image payload read mime=image/png bytes=${result.bytes.length}`);
            return { record: { kind: 'image', mime: 'image/png', bytes: result.bytes }, value: GLib.base64_encode(result.bytes) };
        }
        log.debug(`${ctx}: capture skipped reason=unsupported-mime`);
        return null;
    } finally {
        log.debug(`${ctx}: capture read finished`);
    }
}
