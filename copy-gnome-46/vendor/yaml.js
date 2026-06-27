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

    if ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
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
