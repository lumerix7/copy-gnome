export function pasteKeybindingsValue(value) {
    if (!Array.isArray(value))
        return { ok: false, error: 'expected JSON array' };
    const out = [];
    for (let idx = 0; idx < value.length; idx++) {
        const item = value[idx];
        if (item === null || typeof item !== 'object' || Array.isArray(item))
            return { ok: false, error: `item ${idx + 1}: expected object` };
        const keys = nonEmptyStringArray(item.keys, `item ${idx + 1}.keys`);
        if (!keys.ok)
            return keys;
        const apps = nonEmptyStringArray(item.apps, `item ${idx + 1}.apps`);
        if (!apps.ok)
            return apps;
        out.push({ keys: keys.value, apps: apps.value });
    }
    return { ok: true, value: out };
}

function nonEmptyStringArray(value, path) {
    if (!Array.isArray(value))
        return { ok: false, error: `${path}: expected string array` };
    const out = value
        .map(v => {
            if (typeof v !== 'string')
                return null;
            return v.trim();
        })
        .filter(v => v !== null)
        .filter(v => v.length > 0);
    if (out.length !== value.length)
        return { ok: false, error: `${path}: expected string array` };
    if (out.length === 0)
        return { ok: false, error: `${path}: expected at least one value` };
    return { ok: true, value: out };
}
