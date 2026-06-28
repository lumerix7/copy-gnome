// Leveled logging. Prefixes everything so `journalctl --user -f | grep copy-gnome`
// surfaces our output.

const PREFIX = '[copy-gnome]';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS.info;

export function setLevel(name) {
    if (name in LEVELS)
        currentLevel = LEVELS[name];
}

function emit(level, args) {
    if (LEVELS[level] > currentLevel)
        return;
    const label = level.toUpperCase().padStart(5);
    const msg = args
        .map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a)))
        .join(' ');
    // console.* is available in GJS and routes to the journal.
    console.log(`${PREFIX} ${label}: ${msg}`);
}

export const log = {
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
};
