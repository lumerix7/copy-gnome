// Leveled logging. Prefixes everything so `journalctl --user -f | grep copy-gnome`
// surfaces our output.

const PREFIX = '[copy-gnome]';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_FIELD_CHARS = 1600;

let currentLevel = LEVELS.info;

export function setLevel(name) {
    if (Object.hasOwn(LEVELS, name))
        currentLevel = LEVELS[name];
}

export function errorMessage(error) {
    try {
        return String(error?.message ?? error);
    } catch {
        return 'unknown error';
    }
}

function errorStack(error) {
    try {
        const stack = error?.stack;
        if (typeof stack === 'string' && stack)
            return stack;
    } catch {
        // Thrown values need not have usable property getters.
    }
    return new Error().stack ?? '';
}

function emit(level, args) {
    if (LEVELS[level] > currentLevel)
        return;
    try {
        const label = level.toUpperCase().padStart(5);
        const fields = level === 'error' && args.length === 2
            ? [`${args[0]}:`, errorMessage(args[1]), `\n${errorStack(args[1])}`]
            : args;
        const msg = fields.slice(0, 3).map(value => {
            const text = value instanceof Error ? `${errorMessage(value)}\n${errorStack(value)}` : String(value);
            return text.slice(0, MAX_FIELD_CHARS);
        }).join(' ');
        console.log(`${PREFIX} ${label}: ${msg}`);
    } catch {
        // Logging must not replace the failure being handled.
    }
}

export const log = {
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
};
