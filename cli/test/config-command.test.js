import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS } from "../src/lib/config.js";
import {
  getConfigValue,
  setConfigValue,
  showConfig,
  validateConfig,
} from "../src/lib/config-command.js";

// Point config-command at throwaway paths so tests never touch /opt/home/$USER
// or the caller's real XDG config/state dirs.
let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function pathsOpt() {
  return {
    paths: {
      base: home,
      config: path.join(home, ".config", "copy-gnome"),
      data: path.join(home, ".local", "state", "copy-gnome"),
    },
  };
}

function writeConfig(content) {
  const cfgDir = path.join(home, ".config", "copy-gnome");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.yaml"), content, "utf8");
}

function readConfig() {
  return fs.readFileSync(path.join(home, ".config", "copy-gnome", "config.yaml"), "utf8");
}

test("getConfigValue rejects an unknown key", () => {
  const r = getConfigValue("nope.badkey", pathsOpt());
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown or unsupported config key/);
});

test("getConfigValue returns the default when no file exists", () => {
  const r = getConfigValue("history.maxItems", pathsOpt());
  assert.equal(r.ok, true);
  assert.equal(r.value, DEFAULTS.history.maxItems);
});

test("setConfigValue round-trips a boolean and writes config.yaml", () => {
  const set = setConfigValue("general.captureImages", "false", pathsOpt());
  assert.equal(set.ok, true);
  assert.equal(set.value, false);

  const got = getConfigValue("general.captureImages", pathsOpt());
  assert.equal(got.ok, true);
  assert.equal(got.value, false);

  assert.match(readConfig(), /captureImages: false/);
});

test("setConfigValue rejects an out-of-range number", () => {
  const r = setConfigValue("history.maxItems", "1001", pathsOpt());
  assert.equal(r.ok, false);
  assert.match(r.error, /must be between 1 and 1000/);
});

test("setConfigValue rejects a bad enum value", () => {
  const r = setConfigValue("logging.level", "trace", pathsOpt());
  assert.equal(r.ok, false);
  assert.match(r.error, /expects one of: error, warn, info, debug/);
});

test("setConfigValue accepts popupTheme enum values", () => {
  const set = setConfigValue("ui.popupTheme", "dark", pathsOpt());
  assert.equal(set.ok, true);
  assert.equal(set.value, "dark");
  assert.equal(getConfigValue("ui.popupTheme", pathsOpt()).value, "dark");
});

test("setConfigValue accepts and writes a valid number", () => {
  const set = setConfigValue("ui.popupOffsetX", "12", pathsOpt());
  assert.equal(set.ok, true);
  assert.equal(set.value, 12);
  assert.equal(getConfigValue("ui.popupOffsetX", pathsOpt()).value, 12);
});

test("setConfigValue accepts large popup dimensions up to monitor-clamped max", () => {
  const width = setConfigValue("ui.popupWidth", "8000", pathsOpt());
  assert.equal(width.ok, true);
  assert.equal(width.value, 8000);

  const height = setConfigValue("ui.popupMaxHeight", "8000", pathsOpt());
  assert.equal(height.ok, true);
  assert.equal(height.value, 8000);
});

test("setConfigValue rejects popup dimensions above max", () => {
  const r = setConfigValue("ui.popupWidth", "8001", pathsOpt());
  assert.equal(r.ok, false);
  assert.match(r.error, /must be between 240 and 8000/);
});

test("setConfigValue parses YAML flow arrays", () => {
  const set = setConfigValue("ui.fileApps", "[Foo, Bar]", pathsOpt());
  assert.equal(set.ok, true);
  assert.deepEqual(set.value, ["foo", "bar"]); // lower-cased by sanitize
});

test("setConfigValue preserves comments, key order, and untouched keys", () => {
  writeConfig("# top comment\n# second line\nhistory:\n  maxItems: 10\n");
  const set = setConfigValue("general.captureImages", "false", pathsOpt());
  assert.equal(set.ok, true);

  const written = readConfig();
  assert.match(written, /# top comment/);
  assert.match(written, /# second line/);
  assert.match(written, /captureImages: false/);
  assert.match(written, /maxItems: 10/);
});

test("setConfigValue refuses to write when current config is unparseable", () => {
  writeConfig("history: [1, 2\n");
  const r = setConfigValue("general.captureImages", "false", pathsOpt());
  assert.equal(r.ok, false);
  assert.match(r.error, /refusing to write/);
});

test("validateConfig passes with no file (defaults)", () => {
  const r = validateConfig(pathsOpt());
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
});

test("validateConfig fails on an unparseable file", () => {
  writeConfig("history: [1, 2\n");
  const r = validateConfig(pathsOpt());
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

test("showConfig returns the config object, and with meta includes diagnostics", () => {
  const cfg = showConfig(pathsOpt());
  assert.equal(cfg.history.maxItems, DEFAULTS.history.maxItems);

  const meta = showConfig({ ...pathsOpt(), withMeta: true });
  assert.ok("config" in meta);
  assert.ok("warnings" in meta);
  assert.ok("errors" in meta);
});
