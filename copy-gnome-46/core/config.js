import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { log } from './log.js';
import { parseYaml, serializeYaml } from '../vendor/yaml.js';

// Defaults mirror docs/05-config.md. The on-disk config.yaml (or config.json) is merged
// over these; missing/invalid values silently fall back so a bad config never breaks the
// shell.
export const DEFAULTS = {
    general: {
        captureFiles: true,
        captureImages: true,
        denyAllMemorySources: true,
        allowMemoryMimes: ['image/*'],
    },
    history: {
        maxItems: 30,
        maxItemBytes: 4194304,      // 4096 KiB (4 MiB)
        maxAgeDays: 3,              // 0 = keep all daily files; N deletes clips-*.jsonl older than N days
        cleanupIntervalSec: 86400,  // periodic expired-file sweep interval (seconds), 15..864000
    },
    storage: {
        backend: 'jsonl',
        textMaxBytes: 65536,        // 64 KiB
        binaryMaxBytes: 16384,      // 16 KiB
        flushIntervalSec: 300,       // append latest snapshot once per N sec (the only disk writer)
    },
    privacy: {
        secretMimes: [],
    },
    ui: {
        popupWidth: 640,
        popupMaxHeight: 800,
        popupOffsetX: 0,
        popupOffsetY: 0,
        popupEdgeMargin: 8,
        popupOpacity: 0.82,
        numberPickTimeoutMs: 500,
        showThumbnails: false,
        autoPaste: true,
        autoPasteDelayMs: 220,
        pasteRestoresFocus: true,
        // wm_class substrings that should receive copied files as text/uri-list.
        // All other apps receive the decoded file path as text/plain.
        fileApps: ['org.gnome.nautilus'],
        // wm_class substrings whose paste shortcut is Ctrl+Shift+V (terminals).
        terminalApps: ['terminal'],
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
    'history.maxItemBytes': [1024, 16 * 1024 * 1024],
    'history.maxAgeDays': [0, 3650],
    'history.cleanupIntervalSec': [15, 864000],
    'storage.textMaxBytes': [0, 1024 * 1024],
    'storage.binaryMaxBytes': [0, 1024 * 1024],
    'storage.flushIntervalSec': [5, 3600],
    'ui.popupWidth': [240, 900],
    'ui.popupMaxHeight': [120, 1200],
    'ui.popupOffsetX': [-1000, 1000],
    'ui.popupOffsetY': [-1000, 1000],
    'ui.popupEdgeMargin': [0, 96],
    'ui.popupOpacity': [0.1, 1],
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
    cfg.general.allowMemoryMimes = stringList(cfg.general.allowMemoryMimes, DEFAULTS.general.allowMemoryMimes);
    cfg.ui.fileApps = lowerStringList(cfg.ui.fileApps, DEFAULTS.ui.fileApps);
    cfg.ui.terminalApps = lowerStringList(cfg.ui.terminalApps, DEFAULTS.ui.terminalApps);
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
        .map(v => v.trim())
        .filter(v => v.length > 0)
        .slice(0, 100);
}

function lowerStringList(value, fallback) {
    return stringList(value, fallback).map(v => v.toLowerCase());
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

// Which config file the loader will pick, by existence (loadConfig parses the winner). Single
// source of truth for the yaml > json > none precedence, used by saveConfig (to pick the write
// format) and the prefs About page.
export function configStatus(configDir) {
    const yamlPresent = Gio.File.new_for_path(
        GLib.build_filenamev([configDir, 'config.yaml'])).query_exists(null);
    const jsonPresent = Gio.File.new_for_path(
        GLib.build_filenamev([configDir, 'config.json'])).query_exists(null);
    return {
        yamlPresent,
        jsonPresent,
        active: yamlPresent ? 'yaml' : (jsonPresent ? 'json' : 'none'),
    };
}

// Write the (already-merged) config back in the active format. YAML is the default: we write
// config.yaml unless a config.json already exists AND no YAML does (the only case we follow an
// existing JSON). So a first-time user (no file at all) gets a config.yaml, matching the
// "YAML first" convention. prefs.js runs out-of-process (not inside gnome-shell), so a
// synchronous write here is fine. Returns { ok, format: 'yaml'|'json', path }.
export function saveConfig(configDir, config) {
    const status = configStatus(configDir);
    const useYaml = status.yamlPresent || !status.jsonPresent;
    try {
        GLib.mkdir_with_parents(configDir, 0o700);
        const path = GLib.build_filenamev([configDir, useYaml ? 'config.yaml' : 'config.json']);
        const text = useYaml ? serializeYaml(config) : `${JSON.stringify(config, null, 2)}\n`;
        const stream = Gio.File.new_for_path(path)
            .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        try {
            stream.write_all(new TextEncoder().encode(text), null);
        } finally {
            stream.close(null);
        }
        return { ok: true, format: useYaml ? 'yaml' : 'json', path };
    } catch (e) {
        log.warn(`saveConfig failed: ${e.message}`);
        return { ok: false, format: useYaml ? 'yaml' : 'json', error: e.message };
    }
}
