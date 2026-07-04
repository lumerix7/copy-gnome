import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { CONFIG_KEYS, DEFAULTS, ENUMS, LIMITS, loadConfig } from "./config.js";
import { existsFile, resolveDataPaths } from "./paths.js";
import { shellQuote } from "./shell.js";

export function configContext(opts = {}) {
  const paths = opts.paths || resolveDataPaths(opts.pathsOptions);
  const loaded = loadConfig(paths.config);
  return { paths, loaded };
}

export function configPathInfo(opts = {}) {
  const { paths, loaded } = configContext(opts);
  return {
    configDir: paths.config,
    activeFile: loaded.file,
    format: loaded.format,
    exists: loaded.exists,
    preferredYaml: `${paths.config}/config.yaml`,
    fallbackJson: `${paths.config}/config.json`,
  };
}

export function validateConfig(opts = {}) {
  const { loaded } = configContext(opts);
  return {
    ok: loaded.errors.length === 0,
    file: loaded.file,
    format: loaded.format,
    exists: loaded.exists,
    errors: loaded.errors,
    warnings: loaded.warnings,
  };
}

export function showConfig(opts = {}) {
  const { loaded } = configContext(opts);
  return opts.withMeta ? {
    file: loaded.file,
    format: loaded.format,
    exists: loaded.exists,
    warnings: loaded.warnings,
    errors: loaded.errors,
    config: loaded.config,
  } : loaded.config;
}

export function getConfigValue(key, opts = {}) {
  if (!CONFIG_KEYS.includes(key))
    return { ok: false, error: `unknown or unsupported config key: ${key}`, keys: CONFIG_KEYS };
  const { loaded } = configContext(opts);
  const value = getPath(loaded.config, key);
  return {
    ok: true,
    key,
    value,
    file: loaded.file,
    warnings: loaded.warnings,
    errors: loaded.errors,
  };
}

export function setConfigValue(key, rawValue, opts = {}) {
  if (!CONFIG_KEYS.includes(key))
    return { ok: false, error: `unknown or unsupported config key: ${key}`, keys: CONFIG_KEYS };
  const parsed = parseConfigValue(key, rawValue);
  if (!parsed.ok)
    return parsed;

  const { paths, loaded } = configContext(opts);
  if (loaded.errors.length) {
    return {
      ok: false,
      error: `refusing to write: current ${path.basename(loaded.file)} could not be parsed (${loaded.errors.join("; ")}); fix it or run 'copy-gnome config edit'`,
    };
  }

  const next = clone(loaded.config);
  setPath(next, key, parsed.value);
  const checked = sanitizeCandidateConfig(next);
  const finalValue = getPath(checked.config, key);

  try {
    const written = writeConfigKey(paths.config, loaded, key, finalValue);
    return {
      ok: true,
      key,
      requested: parsed.value,
      value: finalValue,
      path: written.path,
      warnings: checked.warnings,
      errors: checked.errors,
    };
  } catch (error) {
    return { ok: false, error: `failed to write config.yaml: ${error.message}` };
  }
}

export function editConfig(opts = {}) {
  const { paths, loaded } = configContext(opts);
  fs.mkdirSync(paths.config, { recursive: true, mode: 0o700 });

  const yamlPath = path.join(paths.config, "config.yaml");
  const source = fs.existsSync(yamlPath)
    ? fs.readFileSync(yamlPath, "utf8")
    : `${formatYaml(loaded.config)}\n`;
  const tmpPath = path.join(os.tmpdir(), `copy-gnome-config-${process.pid}-${Date.now()}.yaml`);
  fs.writeFileSync(tmpPath, source, { mode: 0o600 });

  const editor = opts.editor || process.env.VISUAL || process.env.EDITOR || "editor";
  const command = `${editor} ${shellQuote(tmpPath)}`;
  const result = spawnSync(command, {
    shell: true,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    removeFile(tmpPath);
    return {
      ok: false,
      error: result.error?.message || `editor exited with ${result.status ?? result.signal ?? "unknown"}`,
      editor,
    };
  }

  const text = fs.readFileSync(tmpPath, "utf8");
  const valid = validateYamlText(text);
  if (!valid.ok) {
    removeFile(tmpPath);
    return {
      ok: false,
      error: valid.error,
      editor,
    };
  }

  try {
    const written = writeYamlText(paths.config, text);
    removeFile(tmpPath);
    const reloaded = loadConfig(paths.config);
    return {
      ok: reloaded.errors.length === 0,
      path: written.path,
      editor,
      warnings: reloaded.warnings,
      errors: reloaded.errors,
    };
  } catch (error) {
    removeFile(tmpPath);
    return { ok: false, error: `failed to write config.yaml: ${error.message}`, editor };
  }
}

export function formatYaml(value) {
  return YAML.stringify(value).trimEnd();
}

export function formatScalar(value) {
  if (typeof value === "string")
    return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  return JSON.stringify(value, null, 2);
}

function getPath(obj, key) {
  return key.split(".").reduce((cur, part) => cur?.[part], obj);
}

function setPath(obj, key, value) {
  const parts = key.split(".");
  const leaf = parts.pop();
  let cur = obj;
  for (const part of parts)
    cur = cur[part];
  cur[leaf] = value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseConfigValue(key, rawValue) {
  const expected = getPath(DEFAULTS, key);
  try {
    if (typeof expected === "boolean")
      return parseBoolean(key, rawValue);
    if (typeof expected === "number")
      return parseNumber(key, rawValue, Number.isInteger(expected), LIMITS[key]);
    if (typeof expected === "string")
      return parseString(key, rawValue);
    if (Array.isArray(expected)) {
      const value = YAML.parse(rawValue);
      if (!Array.isArray(value))
        return { ok: false, error: `config key ${key} expects an array value` };
      return { ok: true, value };
    }
    const value = YAML.parse(rawValue);
    if (!isPlainObject(value))
      return { ok: false, error: `config key ${key} expects an object value` };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: `failed to parse value for ${key}: ${error.message}` };
  }
}

function parseBoolean(key, rawValue) {
  const value = String(rawValue).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value))
    return { ok: true, value: true };
  if (["false", "0", "no", "off"].includes(value))
    return { ok: true, value: false };
  return { ok: false, error: `config key ${key} expects true or false` };
}

function parseNumber(key, rawValue, integer, range) {
  const value = Number(String(rawValue).trim());
  if (rawValue === "" || !Number.isFinite(value))
    return { ok: false, error: `config key ${key} expects a finite number` };
  if (integer && !Number.isInteger(value))
    return { ok: false, error: `config key ${key} expects an integer` };
  if (range && (value < range[0] || value > range[1]))
    return { ok: false, error: `config key ${key} must be between ${range[0]} and ${range[1]}` };
  return { ok: true, value };
}

function parseString(key, rawValue) {
  const value = String(rawValue);
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(value))
    return { ok: false, error: `config key ${key} expects one of: ${allowed.join(", ")}` };
  return { ok: true, value };
}

function validateYamlText(text) {
  try {
    const parsed = YAML.parse(text);
    if (!isPlainObject(parsed))
      return { ok: false, error: "edited config must be a YAML mapping at the top level" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `edited config is not valid YAML: ${error.message}` };
  }
}

function writeConfigKey(configDir, loaded, key, value) {
  let doc;
  if (loaded.format === "yaml" && loaded.file && existsFile(loaded.file)) {
    // Edit the user's existing document in place so comments, key order, and
    // any keys this CLI doesn't know about survive a single-key set.
    doc = YAML.parseDocument(fs.readFileSync(loaded.file, "utf8"));
    if (doc.errors.length)
      doc = new YAML.Document(loaded.config);
  } else {
    // No YAML file yet (defaults, or migrating from config.json): materialize
    // the full known config.
    doc = new YAML.Document(loaded.config);
  }
  doc.setIn(key.split("."), value);
  return writeYamlText(configDir, `${doc.toString().trimEnd()}\n`);
}

function sanitizeCandidateConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-gnome-config-check-"));
  try {
    fs.writeFileSync(path.join(dir, "config.yaml"), `${formatYaml(config)}\n`, { mode: 0o600 });
    return loadConfig(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeYamlText(configDir, text) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const yamlPath = path.join(configDir, "config.yaml");
  const tmpPath = path.join(configDir, `.config.yaml.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, text, { mode: 0o600 });
    fs.renameSync(tmpPath, yamlPath);
    return { path: yamlPath };
  } catch (error) {
    removeFile(tmpPath);
    throw error;
  }
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Best effort cleanup.
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
