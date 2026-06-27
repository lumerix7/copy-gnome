// Minimal YAML subset loader - enough for copy-gnome's config.
// Supports:
//   - nested block mappings (indent-based)
//   - block sequences ("- item") of scalars, mappings, or nested blocks
//   - inline flow lists  [a, b, c]  and flow maps  {k: v, k2: v2}
//   - scalars: bool / null / int / float / quoted + bare strings
//   - "# comments" (full-line and trailing, outside quotes/brackets)
//
// NOT a full YAML implementation. On anything it can't parse it throws; callers fall
// back to defaults (see core/config.js).

// Remove a trailing/standalone "#..." comment, respecting quotes and [] {} nesting.
function stripLineComment(s) {
    let inS = false, inD = false, depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "'" && !inD) inS = !inS;
        else if (c === '"' && !inS) inD = !inD;
        else if (!inS && !inD && (c === '[' || c === '{')) depth++;
        else if (!inS && !inD && (c === ']' || c === '}')) depth--;
        else if (c === '#' && !inS && !inD && depth === 0 &&
                 (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t'))
            return s.slice(0, i).trimEnd();
    }
    return s;
}

// Split on a top-level separator (',') honoring quotes and [] {} nesting.
function splitTop(s, sep) {
    const out = [];
    let inS = false, inD = false, depth = 0, cur = '';
    for (const c of s) {
        if (c === "'" && !inD) inS = !inS;
        else if (c === '"' && !inS) inD = !inD;
        else if (!inS && !inD && (c === '[' || c === '{')) depth++;
        else if (!inS && !inD && (c === ']' || c === '}')) depth--;
        if (c === sep && depth === 0 && !inS && !inD) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim() !== '') out.push(cur);
    return out;
}

// Index of the first top-level ':' that acts as a key/value separator.
function colonIndex(s) {
    let inS = false, inD = false, depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "'" && !inD) inS = !inS;
        else if (c === '"' && !inS) inD = !inD;
        else if (!inS && !inD && (c === '[' || c === '{')) depth++;
        else if (!inS && !inD && (c === ']' || c === '}')) depth--;
        else if (c === ':' && !inS && !inD && depth === 0 &&
                 (i + 1 >= s.length || s[i + 1] === ' '))
            return i;
    }
    return -1;
}

function parseScalar(raw) {
    let s = raw.trim();
    if (s === '' || s === '~' || s === 'null') return null;

    if (s.startsWith('[') && s.endsWith(']')) {
        const inner = s.slice(1, -1).trim();
        return inner === '' ? [] : splitTop(inner, ',').map(x => parseScalar(x));
    }
    if (s.startsWith('{') && s.endsWith('}')) {
        const inner = s.slice(1, -1).trim();
        const obj = {};
        if (inner === '') return obj;
        for (const pair of splitTop(inner, ',')) {
            const ci = colonIndex(pair);
            if (ci < 0) throw new Error(`bad flow-map entry: ${pair}`);
            obj[pair.slice(0, ci).trim()] = parseScalar(pair.slice(ci + 1));
        }
        return obj;
    }

    if (s.startsWith('"') && s.endsWith('"')) {
        try {
            return JSON.parse(s);
        } catch (e) {
            throw new Error(`bad double-quoted string: ${s}`);
        }
    }
    if (s.startsWith("'") && s.endsWith("'"))
        return s.slice(1, -1);

    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    return s;
}

function indentOf(s) {
    let i = 0;
    while (i < s.length && s[i] === ' ') i++;
    return i;
}

export function parseYaml(text) {
    // Pre-tokenize into {indent, text} entries, dropping blanks and comments.
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        const stripped = stripLineComment(raw);
        if (stripped.trim() === '') continue;
        const ind = indentOf(stripped);
        lines.push({ indent: ind, text: stripped.slice(ind) });
    }

    let idx = 0;
    const isDash = t => t === '-' || t.startsWith('- ');

    function parseNode(indent) {
        const { text } = lines[idx];
        if (isDash(text)) return parseSeq(indent);
        if (colonIndex(text) >= 0) return parseMap(indent);
        idx++;
        return parseScalar(text);
    }

    function parseSeq(indent) {
        const arr = [];
        while (idx < lines.length &&
               lines[idx].indent === indent && isDash(lines[idx].text)) {
            const rest = lines[idx].text === '-' ? '' : lines[idx].text.slice(2).trim();
            if (rest === '') {
                idx++;
                if (idx < lines.length && lines[idx].indent > indent)
                    arr.push(parseNode(lines[idx].indent));
                else
                    arr.push(null);
            } else {
                // Re-home the inline remainder as a node at indent+2 and let parseNode
                // consume it plus any following lines that belong to this item.
                const itemIndent = indent + 2;
                lines[idx] = { indent: itemIndent, text: rest };
                arr.push(parseNode(itemIndent));
            }
        }
        return arr;
    }

    function parseMap(indent) {
        const obj = {};
        while (idx < lines.length &&
               lines[idx].indent === indent && !isDash(lines[idx].text)) {
            const { text } = lines[idx];
            const ci = colonIndex(text);
            if (ci < 0) throw new Error(`expected "key: value" at: ${text}`);
            const key = text.slice(0, ci).trim();
            const rest = text.slice(ci + 1).trim();
            idx++;
            if (rest === '') {
                if (idx < lines.length && lines[idx].indent > indent)
                    obj[key] = parseNode(lines[idx].indent);
                else
                    obj[key] = null;
            } else {
                obj[key] = parseScalar(rest);
            }
        }
        return obj;
    }

    if (lines.length === 0) return {};
    return parseNode(lines[0].indent);
}

// Minimal YAML serializer that mirrors the subset parseYaml reads: nested block maps, block
// sequences of scalars or of small maps (pasteOverrides), empty [], and scalars
// (bool/int/float/string/null). Strings that YAML would parse as another type, or that contain
// structural/control characters, are double-quoted. Used by the prefs GUI to write config.yaml
// so GUI edits take effect even when a hand-written YAML is present.
// Trade-off: round-tripping through this DROPS human comments and reformats whitespace -
// accepted for a GUI-managed file.
export function serializeYaml(obj) {
    return emitMap(obj, 0).join('\n') + '\n';
}

function emitMap(obj, indent) {
    const pad = '  '.repeat(indent);
    const out = [];
    for (const [key, val] of Object.entries(obj)) {
        if (Array.isArray(val)) {
            if (val.length === 0) {
                out.push(`${pad}${key}: []`);
            } else {
                out.push(`${pad}${key}:`);
                out.push(...emitSeq(val, indent + 1));
            }
        } else if (val !== null && typeof val === 'object') {
            out.push(`${pad}${key}:`);
            out.push(...emitMap(val, indent + 1));
        } else {
            out.push(`${pad}${key}: ${formatScalar(val)}`);
        }
    }
    return out;
}

function emitSeq(arr, indent) {
    const pad = '  '.repeat(indent);
    const out = [];
    for (const item of arr) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            const entries = Object.entries(item);
            if (entries.length === 0) {
                out.push(`${pad}- {}`);
            } else {
                out.push(`${pad}- ${entries[0][0]}: ${formatScalar(entries[0][1])}`);
                for (let i = 1; i < entries.length; i++)
                    out.push(`${pad}  ${entries[i][0]}: ${formatScalar(entries[i][1])}`);
            }
        } else {
            out.push(`${pad}- ${formatScalar(item)}`);
        }
    }
    return out;
}

function formatScalar(v) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (typeof v === 'string') return quoteString(v);
    return quoteString(String(v));
}

// Quote on any doubt: strings that look like bool/number/null, or contain YAML
// structural/control characters, or have leading/trailing whitespace.
function quoteString(s) {
    const quoted = () => JSON.stringify(s);
    if (s === '') return quoted();
    if (/^(?:true|false|null|~|yes|no|on|off)$/i.test(s)) return quoted();
    if (/^[+-]?\d/.test(s)) return quoted();
    if (/[:#&*!|>'"%@`,\[\]{}]/.test(s)) return quoted();
    if (/^\s|\s$/.test(s) || /[\x00-\x1f]/.test(s)) return quoted();
    return s;
}
