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

// config-command resolves its config dir from COPY_GNOME_HOME; point it at a
// throwaway home per test so nothing touches the real /opt/copy-gnome/$USER.
let home;
let prevHome;

beforeEach(() => {
  prevHome = process.env.COPY_GNOME_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  process.env.COPY_GNOME_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined)
    delete process.env.COPY_GNOME_HOME;
  else
    process.env.COPY_GNOME_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(content) {
  const cfgDir = path.join(home, "config");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.yaml"), content, "utf8");
}

function readConfig() {
  return fs.readFileSync(path.join(home, "config", "config.yaml"), "utf8");
}

test("getConfigValue rejects an unknown key", () => {
  const r = getConfigValue("nope.badkey");
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown or unsupported config key/);
});

test("getConfigValue returns the default when no file exists", () => {
  const r = getConfigValue("history.maxItems");
  assert.equal(r.ok, true);
  assert.equal(r.value, DEFAULTS.history.maxItems);
});

test("setConfigValue round-trips a boolean and writes config.yaml", () => {
  const set = setConfigValue("general.captureImages", "false");
  assert.equal(set.ok, true);
  assert.equal(set.value, false);

  const got = getConfigValue("general.captureImages");
  assert.equal(got.ok, true);
  assert.equal(got.value, false);

  assert.match(readConfig(), /captureImages: false/);
});

test("setConfigValue rejects an out-of-range number", () => {
  const r = setConfigValue("history.maxItems", "999");
  assert.equal(r.ok, false);
  assert.match(r.error, /must be between 1 and 100/);
});

test("setConfigValue rejects a bad enum value", () => {
  const r = setConfigValue("logging.level", "trace");
  assert.equal(r.ok, false);
  assert.match(r.error, /expects one of: error, warn, info, debug/);
});

test("setConfigValue accepts and writes a valid number", () => {
  const set = setConfigValue("ui.popupOffsetX", "12");
  assert.equal(set.ok, true);
  assert.equal(set.value, 12);
  assert.equal(getConfigValue("ui.popupOffsetX").value, 12);
});

test("setConfigValue parses YAML flow arrays", () => {
  const set = setConfigValue("ui.fileApps", "[Foo, Bar]");
  assert.equal(set.ok, true);
  assert.deepEqual(set.value, ["foo", "bar"]); // lower-cased by sanitize
});

test("setConfigValue preserves comments, key order, and untouched keys", () => {
  writeConfig("# top comment\n# second line\nhistory:\n  maxItems: 10\n");
  const set = setConfigValue("general.captureImages", "false");
  assert.equal(set.ok, true);

  const written = readConfig();
  assert.match(written, /# top comment/);
  assert.match(written, /# second line/);
  assert.match(written, /captureImages: false/);
  assert.match(written, /maxItems: 10/);
});

test("setConfigValue refuses to write when current config is unparseable", () => {
  writeConfig("history: [1, 2\n");
  const r = setConfigValue("general.captureImages", "false");
  assert.equal(r.ok, false);
  assert.match(r.error, /refusing to write/);
});

test("validateConfig passes with no file (defaults)", () => {
  const r = validateConfig();
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
});

test("validateConfig fails on an unparseable file", () => {
  writeConfig("history: [1, 2\n");
  const r = validateConfig();
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

test("showConfig returns the config object, and with meta includes diagnostics", () => {
  const cfg = showConfig();
  assert.equal(cfg.history.maxItems, DEFAULTS.history.maxItems);

  const meta = showConfig({ withMeta: true });
  assert.ok("config" in meta);
  assert.ok("warnings" in meta);
  assert.ok("errors" in meta);
});
