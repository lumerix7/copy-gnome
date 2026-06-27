import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { log } from './log.js';
import { parseYaml } from '../vendor/yaml.js';

// Defaults mirror docs/05-config.md. The on-disk config.yaml (or config.json) is merged
// over these; missing/invalid values silently fall back so a bad config never breaks the
// shell.
export const DEFAULTS = {
    general: {
        enabled: true,
        watchPrimarySelection: false,
        captureFiles: true,
        captureImages: true,
        clipboardPersistence: true,
    },
    history: {
        maxItems: 30,
        maxTotalBytes: 268435456,   // 256 MiB
        maxItemBytes: 16777216,     // 16 MiB
        maxAgeDays: 0,
        dedup: true,
    },
    storage: {
        backend: 'jsonl',
        inlineMaxBytes: 65536,      // 64 KiB
        inlineBinaryMaxBytes: 16384,  // 16 KiB
        flushIntervalSec: 60,
        debounceMs: 500,
        clipLineMaxBytes: 8388608,  // 8 MiB
        maxLoadedLines: 100,
    },
    privacy: {
        secretMimes: ['x-kde-passwordManagerHint'],
        excludeApps: [],
        excludeRegex: [],
    },
    ui: {
        popupWidth: 640,
        popupMaxHeight: 800,
        popupOffsetX: 0,
        popupOffsetY: 0,
        popupEdgeMargin: 8,
        popupOpacity: 0.82,
        popupMaxRows: 20,
        numberPickTimeoutMs: 800,
        showThumbnails: false,
        autoPaste: true,
        autoPasteDelayMs: 220,
        pasteRestoresFocus: true,
        // wm_class substrings whose paste shortcut is Ctrl+Shift+V (terminals).
        terminalApps: [
            'gnome-terminal', 'org.gnome.Terminal', 'org.gnome.Console', 'kgx',
            'konsole', 'xterm', 'alacritty', 'kitty', 'foot', 'wezterm',
            'tilix', 'terminator', 'Terminal',
        ],
        // Per-app paste combo overrides (checked before terminalApps). Each entry:
        //   { match: '<wm_class substring>', combo: 'ctrl-v'|'ctrl-shift-v'|'shift-insert'|'none' }
        // Use 'none' to only set the clipboard (no keystroke) for an app.
        pasteOverrides: [],
    },
    logging: {
        level: 'info',
    },
};

const LIMITS = {
    'history.maxItems': [1, 100],
    'history.maxTotalBytes': [1024 * 1024, 1024 * 1024 * 1024],
    'history.maxItemBytes': [1024, 64 * 1024 * 1024],
    'history.maxAgeDays': [0, 3650],
    'storage.inlineMaxBytes': [0, 1024 * 1024],
    'storage.inlineBinaryMaxBytes': [0, 1024 * 1024],
    'storage.flushIntervalSec': [5, 3600],
    'storage.debounceMs': [100, 60000],
    'storage.clipLineMaxBytes': [1024, 16 * 1024 * 1024],
    'storage.maxLoadedLines': [1, 5000],
    'ui.popupWidth': [240, 900],
    'ui.popupMaxHeight': [120, 1200],
    'ui.popupOffsetX': [-1000, 1000],
    'ui.popupOffsetY': [-1000, 1000],
    'ui.popupEdgeMargin': [0, 96],
    'ui.popupOpacity': [0.1, 1],
    'ui.popupMaxRows': [1, 100],
    'ui.numberPickTimeoutMs': [100, 5000],
    'ui.autoPasteDelayMs': [0, 5000],
};

const PASTE_COMBOS = new Set(['ctrl-v', 'ctrl-shift-v', 'shift-insert', 'none']);

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `src` over a clone of `base`. Only keys present in `base` are taken from
// `src` (unknown keys are dropped with a warning) so typos can't silently change nothing.
function mergeKnown(base, src, path = '') {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!isObject(src)) return out;
    for (const key of Object.keys(src)) {
        const full = path ? `${path}.${key}` : key;
        if (!(key in base)) {
            log.warn(`unknown config key ignored: ${full}`);
            continue;
        }
        if (isObject(base[key]) && isObject(src[key]))
            out[key] = mergeKnown(base[key], src[key], full);
        else if (Array.isArray(base[key]) && Array.isArray(src[key]))
            out[key] = src[key].slice();
        else if (!Array.isArray(base[key]) && typeof base[key] === typeof src[key])
            out[key] = src[key];
        else
            log.warn(`config key ${full}: type mismatch, keeping default`);
    }
    return out;
}

function readFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) return null;
        const [ok, contents] = file.load_contents(null);
        if (!ok) return null;
        return new TextDecoder().decode(contents);
    } catch (e) {
        log.warn(`failed reading ${path}: ${e.message}`);
        return null;
    }
}

// Loads config from <configDir>/config.yaml (preferred) or config.json. Returns the
// merged config object; always succeeds (defaults on any failure).
export function loadConfig(configDir, opts = {}) {
    const yamlPath = GLib.build_filenamev([configDir, 'config.yaml']);
    const jsonPath = GLib.build_filenamev([configDir, 'config.json']);

    let parsed = null;
    const yamlText = readFile(yamlPath);
    if (yamlText !== null) {
        try {
            parsed = parseYaml(yamlText);
            if (!opts.quiet)
                log.info(`loaded config: ${yamlPath}`);
        } catch (e) {
            log.error(`config.yaml parse error (${e.message}); using defaults`);
        }
    } else {
        const jsonText = readFile(jsonPath);
        if (jsonText !== null) {
            try {
                parsed = JSON.parse(jsonText);
                if (!opts.quiet)
                    log.info(`loaded config: ${jsonPath}`);
            } catch (e) {
                log.error(`config.json parse error (${e.message}); using defaults`);
            }
        }
    }

    if (!parsed) {
        if (!opts.quiet)
            log.info('no config file; using defaults');
        return structuredCloneConfig(DEFAULTS);
    }
    return sanitizeConfig(mergeKnown(DEFAULTS, parsed));
}

function structuredCloneConfig(o) {
    return JSON.parse(JSON.stringify(o));
}

function sanitizeConfig(cfg) {
    for (const [path, [min, max]] of Object.entries(LIMITS))
        clampNumberPath(cfg, path, min, max);

    cfg.storage.backend = cfg.storage.backend === 'gda' ? 'gda' : 'jsonl';
    cfg.logging.level = ['error', 'warn', 'info', 'debug'].includes(cfg.logging.level)
        ? cfg.logging.level : 'info';

    cfg.privacy.secretMimes = stringList(cfg.privacy.secretMimes, DEFAULTS.privacy.secretMimes);
    cfg.privacy.excludeApps = stringList(cfg.privacy.excludeApps, []);
    cfg.privacy.excludeRegex = stringList(cfg.privacy.excludeRegex, []);
    cfg.ui.terminalApps = stringList(cfg.ui.terminalApps, DEFAULTS.ui.terminalApps);
    cfg.ui.pasteOverrides = pasteOverrides(cfg.ui.pasteOverrides);

    return cfg;
}

function clampNumberPath(cfg, path, min, max) {
    const parts = path.split('.');
    const key = parts.pop();
    let obj = cfg;
    for (const p of parts)
        obj = obj[p];
    const value = obj[key];
    if (typeof value !== 'number' || Number.isNaN(value)) {
        obj[key] = getPath(DEFAULTS, path);
        log.warn(`config key ${path}: invalid number, keeping default`);
        return;
    }
    const clamped = Math.max(min, Math.min(value, max));
    if (clamped !== value)
        log.warn(`config key ${path}: clamped to ${clamped}`);
    obj[key] = Number.isInteger(min) && Number.isInteger(max) ? Math.round(clamped) : clamped;
}

function getPath(obj, path) {
    return path.split('.').reduce((cur, key) => cur[key], obj);
}

function stringList(value, fallback) {
    if (!Array.isArray(value))
        return fallback.slice();
    return value
        .filter(v => typeof v === 'string')
        .slice(0, 100);
}

function pasteOverrides(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter(isObject)
        .map(o => ({
            match: typeof o.match === 'string' ? o.match : '',
            combo: PASTE_COMBOS.has(o.combo) ? o.combo : 'ctrl-v',
        }))
        .filter(o => o.match !== '')
        .slice(0, 100);
}
