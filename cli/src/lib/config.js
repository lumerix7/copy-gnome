import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { existsFile } from "./paths.js";

export const DEFAULTS = {
  general: {
    captureFiles: true,
    captureImages: true,
  },
  history: {
    maxItems: 500,
    maxItemBytes: 4194304,
    maxAgeDays: 3,
    cleanupIntervalSec: 86400,
  },
  storage: {
    backend: "jsonl",
    textMaxBytes: 1024 * 1024,
    binaryMaxBytes: 1024 * 1024,
    flushIntervalSec: 3600,
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
    popupOpacity: 0.92,
    popupTheme: "auto",
    numberPickTimeoutMs: 500,
    showThumbnails: false,
    autoPaste: true,
    autoPasteDelayMs: 220,
    pasteRestoresFocus: true,
    skipClipboardWriteForRecentTopSec: 3,
    fileApps: ["org.gnome.nautilus"],
    richTextApps: ["libreoffice", "soffice"],
    plainTextApps: ["terminal"],
    defaultPasteKeys: ["ctrl", "v"],
    pasteKeybindings: [{ keys: ["ctrl", "shift", "v"], apps: ["terminal"] }],
  },
  logging: {
    level: "info",
  },
};

export const ENUMS = {
  "storage.backend": ["jsonl", "gda"],
  "ui.popupTheme": ["auto", "dark", "light"],
  "logging.level": ["error", "warn", "info", "debug"],
};

export const LIMITS = {
  "history.maxItems": [1, 1000],
  "history.maxItemBytes": [1024, 16 * 1024 * 1024],
  "history.maxAgeDays": [0, 3650],
  "history.cleanupIntervalSec": [15, 864000],
  "storage.textMaxBytes": [0, 15 * 1024 * 1024],
  "storage.binaryMaxBytes": [0, 10 * 1024 * 1024],
  "storage.flushIntervalSec": [5, 8 * 3600],
  "ui.popupWidth": [240, 8000],
  "ui.popupMaxHeight": [120, 8000],
  "ui.popupOffsetX": [-1000, 1000],
  "ui.popupOffsetY": [-1000, 1000],
  "ui.popupEdgeMargin": [0, 96],
  "ui.popupOpacity": [0.1, 1],
  "ui.numberPickTimeoutMs": [100, 5000],
  "ui.autoPasteDelayMs": [0, 5000],
  "ui.skipClipboardWriteForRecentTopSec": [0, 900],
};

export const CONFIG_KEYS = [
  "general.captureFiles",
  "general.captureImages",
  "history.maxItems",
  "history.maxItemBytes",
  "history.maxAgeDays",
  "history.cleanupIntervalSec",
  "storage.backend",
  "storage.textMaxBytes",
  "storage.binaryMaxBytes",
  "storage.flushIntervalSec",
  "privacy.secretMimes",
  "ui.popupWidth",
  "ui.popupMaxHeight",
  "ui.popupOffsetX",
  "ui.popupOffsetY",
  "ui.popupEdgeMargin",
  "ui.popupOpacity",
  "ui.popupTheme",
  "ui.numberPickTimeoutMs",
  "ui.showThumbnails",
  "ui.autoPaste",
  "ui.autoPasteDelayMs",
  "ui.pasteRestoresFocus",
  "ui.skipClipboardWriteForRecentTopSec",
  "ui.fileApps",
  "ui.richTextApps",
  "ui.plainTextApps",
  "ui.defaultPasteKeys",
  "ui.pasteKeybindings",
  "logging.level",
];

const DEPRECATED_KEYS = [
  "storage.inlineMaxBytes",
  "storage.inlineBinaryMaxBytes",
  "storage.clipLineMaxBytes",
  "history.maxTotalBytes",
  "storage.maxLoadedLines",
  "maxLoadedLines",
];

export function loadConfig(configDir) {
  const yamlPath = path.join(configDir, "config.yaml");
  const jsonPath = path.join(configDir, "config.json");
  const warnings = [];
  const errors = [];
  let file = null;
  let format = null;
  let parsed = null;
  let raw = "";

  if (existsFile(yamlPath)) {
    file = yamlPath;
    format = "yaml";
  } else if (existsFile(jsonPath)) {
    file = jsonPath;
    format = "json";
  }

  if (file) {
    try {
      raw = fs.readFileSync(file, "utf8");
      parsed = format === "yaml" ? YAML.parse(raw) : JSON.parse(raw);
    } catch (error) {
      errors.push(`${path.basename(file)} parse failed: ${error.message}`);
      parsed = null;
    }
  }

  for (const key of DEPRECATED_KEYS) {
    if (raw.includes(key.split(".").at(-1)))
      warnings.push(`deprecated config key may be present: ${key}`);
  }

  const merge = mergeKnown(DEFAULTS, parsed, "", warnings);
  const config = sanitizeConfig(merge, warnings);
  return {
    file,
    format,
    exists: Boolean(file),
    config,
    warnings,
    errors,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeKnown(base, src, prefix, warnings) {
  const out = clone(base);
  if (!isPlainObject(src))
    return out;

  for (const [key, value] of Object.entries(src)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (!(key in base)) {
      warnings.push(`unknown config key ignored: ${full}`);
      continue;
    }
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      out[key] = mergeKnown(base[key], value, full, warnings);
    } else if (Array.isArray(base[key]) && Array.isArray(value)) {
      out[key] = value.slice();
    } else if (!Array.isArray(base[key]) && typeof base[key] === typeof value) {
      out[key] = value;
    } else {
      warnings.push(`config key ${full}: type mismatch, keeping default`);
    }
  }
  return out;
}

function sanitizeConfig(config, warnings) {
  for (const [field, [min, max]] of Object.entries(LIMITS))
    clampNumber(config, field, min, max, warnings);

  for (const [field, allowed] of Object.entries(ENUMS)) {
    const value = getPath(config, field);
    if (allowed.includes(value))
      continue;
    const fallback = getPath(DEFAULTS, field);
    warnings.push(`${field} ${JSON.stringify(value)} ignored; using ${fallback}`);
    setPath(config, field, fallback);
  }

  config.privacy.secretMimes = stringList(config.privacy.secretMimes, []);
  config.ui.fileApps = lowerStringList(config.ui.fileApps, DEFAULTS.ui.fileApps);
  config.ui.richTextApps = lowerStringList(config.ui.richTextApps, DEFAULTS.ui.richTextApps);
  config.ui.plainTextApps = lowerStringList(config.ui.plainTextApps, DEFAULTS.ui.plainTextApps);
  config.ui.defaultPasteKeys = pasteKeys(config.ui.defaultPasteKeys, DEFAULTS.ui.defaultPasteKeys, "ui.defaultPasteKeys", warnings);
  config.ui.pasteKeybindings = pasteKeybindings(config.ui.pasteKeybindings, warnings);
  return config;
}

function clampNumber(config, field, min, max, warnings) {
  const parts = field.split(".");
  const key = parts.pop();
  let obj = config;
  for (const part of parts)
    obj = obj[part];
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`config key ${field}: invalid number, keeping default`);
    obj[key] = getPath(DEFAULTS, field);
    return;
  }
  const next = Math.min(max, Math.max(min, value));
  if (next !== value)
    warnings.push(`config key ${field}: clamped ${value} -> ${next}`);
  obj[key] = next;
}

function getPath(obj, field) {
  return field.split(".").reduce((cur, part) => cur[part], obj);
}

function setPath(obj, field, value) {
  const parts = field.split(".");
  const key = parts.pop();
  let cur = obj;
  for (const part of parts)
    cur = cur[part];
  cur[key] = value;
}

function stringList(value, fallback) {
  return Array.isArray(value)
    ? value
      .filter(x => typeof x === "string")
      .map(x => x.trim())
      .filter(x => x.length > 0)
      .slice(0, 100)
    : fallback.slice();
}

function lowerStringList(value, fallback) {
  return stringList(value, fallback).map(x => x.toLowerCase());
}

const MODIFIER_KEYS = new Set(["ctrl", "shift", "alt", "super"]);
const NAMED_KEYS = new Set([
  ...MODIFIER_KEYS,
  "backspace",
  "delete",
  "down",
  "end",
  "enter",
  "escape",
  "home",
  "insert",
  "left",
  "page-down",
  "page-up",
  "right",
  "space",
  "tab",
  "up",
]);

function normalizePasteKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (key === "control")
    return "ctrl";
  if (key === "return")
    return "enter";
  if (key === "esc")
    return "escape";
  if (key === "pgdn")
    return "page-down";
  if (key === "pgup")
    return "page-up";
  if (/^[a-z0-9]$/.test(key) || /^f([1-9]|1[0-2])$/.test(key) || NAMED_KEYS.has(key))
    return key;
  return "";
}

function pasteKeys(value, fallback, field, warnings) {
  if (!Array.isArray(value)) {
    warnings.push(`config key ${field}: invalid paste keys${fallback ? ", keeping default" : ""}`);
    return fallback ? fallback.slice() : null;
  }
  const keys = [];
  for (const item of value.slice(0, 8)) {
    const key = normalizePasteKey(item);
    if (!key) {
      warnings.push(`config key ${field}: invalid paste key ignored: ${String(item)}`);
      continue;
    }
    keys.push(key);
  }
  return keys;
}

function pasteKeybindings(value, warnings) {
  if (!Array.isArray(value))
    return [];
  const out = [];
  for (const item of value.slice(0, 100)) {
    if (!isPlainObject(item)) {
      warnings.push(`invalid paste keybinding ignored: ${JSON.stringify(item)}`);
      continue;
    }
    const apps = lowerStringList(item.apps, []);
    if (apps.length === 0) {
      warnings.push("invalid paste keybinding ignored: apps must be a non-empty string list");
      continue;
    }
    const keys = pasteKeys(item.keys, null, "ui.pasteKeybindings.keys", warnings);
    if (keys == null || (item.keys.length > 0 && keys.length === 0)) {
      warnings.push("invalid paste keybinding ignored: keys must be a valid paste key list");
      continue;
    }
    out.push({ keys, apps });
  }
  return out;
}
