import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, loadConfig } from "../src/lib/config.js";

function cfgDir(content, name = "config.yaml") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cfg-"));
  if (content != null)
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("no config file -> defaults, no warnings or errors", () => {
  const dir = cfgDir(null);
  try {
    const r = loadConfig(dir);
    assert.equal(r.exists, false);
    assert.equal(r.file, null);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.config, DEFAULTS);
  } finally {
    cleanup(dir);
  }
});

test("yaml overrides defaults; untouched keys keep defaults", () => {
  const dir = cfgDir("history:\n  maxItems: 7\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.format, "yaml");
    assert.equal(r.exists, true);
    assert.equal(r.config.history.maxItems, 7);
    assert.equal(r.config.history.maxAgeDays, DEFAULTS.history.maxAgeDays);
  } finally {
    cleanup(dir);
  }
});

test("json config is parsed when no yaml is present", () => {
  const dir = cfgDir(JSON.stringify({ history: { maxItems: 5 } }), "config.json");
  try {
    const r = loadConfig(dir);
    assert.equal(r.format, "json");
    assert.equal(r.config.history.maxItems, 5);
  } finally {
    cleanup(dir);
  }
});

test("yaml takes precedence over json when both exist", () => {
  const dir = cfgDir("history:\n  maxItems: 9\n");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ history: { maxItems: 1 } }), "utf8");
  try {
    const r = loadConfig(dir);
    assert.equal(r.format, "yaml");
    assert.equal(r.config.history.maxItems, 9);
  } finally {
    cleanup(dir);
  }
});

test("unknown key is ignored with a warning", () => {
  const dir = cfgDir("bogus:\n  x: 1\n");
  try {
    const r = loadConfig(dir);
    assert.deepEqual(r.config, DEFAULTS);
    assert.ok(r.warnings.some(w => /unknown config key ignored: bogus/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("type mismatch keeps the default with a warning", () => {
  const dir = cfgDir("history:\n  maxItems: \"not-a-number\"\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.history.maxItems, DEFAULTS.history.maxItems);
    assert.ok(r.warnings.some(w => /type mismatch/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("numeric value above max is clamped", () => {
  const dir = cfgDir("history:\n  maxItems: 500\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.history.maxItems, 100);
    assert.ok(r.warnings.some(w => /clamped 500 -> 100/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("numeric value below min is clamped", () => {
  const dir = cfgDir("history:\n  maxItems: 0\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.history.maxItems, 1);
    assert.ok(r.warnings.some(w => /clamped 0 -> 1/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("in-range number passes through silently", () => {
  const dir = cfgDir("history:\n  maxItems: 25\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.history.maxItems, 25);
    assert.ok(!r.warnings.some(w => /clamped/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("invalid storage.backend enum falls back to jsonl", () => {
  const dir = cfgDir("storage:\n  backend: sqlite\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.storage.backend, "jsonl");
    assert.ok(r.warnings.some(w => /storage\.backend.*ignored.*jsonl/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("invalid logging.level enum falls back to info", () => {
  const dir = cfgDir("logging:\n  level: trace\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.logging.level, "info");
    assert.ok(r.warnings.some(w => /logging\.level.*ignored.*info/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("invalid popupTheme enum falls back to auto", () => {
  const dir = cfgDir("ui:\n  popupTheme: neon\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.ui.popupTheme, "auto");
    assert.ok(r.warnings.some(w => /ui\.popupTheme.*ignored.*auto/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("valid enum value passes through", () => {
  const dir = cfgDir("logging:\n  level: debug\nui:\n  popupTheme: light\n");
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.logging.level, "debug");
    assert.equal(r.config.ui.popupTheme, "light");
  } finally {
    cleanup(dir);
  }
});

test("secretMimes: non-strings dropped, values trimmed, empties removed", () => {
  const dir = cfgDir("privacy:\n  secretMimes: [\"  x-kde  \", 5, \"\"]\n");
  try {
    const r = loadConfig(dir);
    assert.deepEqual(r.config.privacy.secretMimes, ["x-kde"]);
  } finally {
    cleanup(dir);
  }
});

test("non-array secretMimes falls back to default", () => {
  const dir = cfgDir("privacy:\n  secretMimes: \"nope\"\n");
  try {
    const r = loadConfig(dir);
    assert.deepEqual(r.config.privacy.secretMimes, []);
  } finally {
    cleanup(dir);
  }
});

test("fileApps are lower-cased", () => {
  const dir = cfgDir("ui:\n  fileApps: [\"Foo\", \"BAR\"]\n");
  try {
    const r = loadConfig(dir);
    assert.deepEqual(r.config.ui.fileApps, ["foo", "bar"]);
  } finally {
    cleanup(dir);
  }
});

test("pasteOverrides: invalid entries dropped with warnings, valid kept", () => {
  const yaml = [
    "ui:",
    "  pasteOverrides:",
    "    - match: Emacs",
    "      combo: none",
    "    - match: BadCombo",
    "      combo: bogus",
    "    - combo: ctrl-v",
    "",
  ].join("\n");
  const dir = cfgDir(yaml);
  try {
    const r = loadConfig(dir);
    assert.deepEqual(r.config.ui.pasteOverrides, [{ match: "Emacs", combo: "none" }]);
    const overrideWarnings = r.warnings.filter(w => /invalid paste override/.test(w));
    assert.equal(overrideWarnings.length, 2);
  } finally {
    cleanup(dir);
  }
});

test("deprecated key presence is flagged", () => {
  const dir = cfgDir("storage:\n  inlineMaxBytes: 1024\n");
  try {
    const r = loadConfig(dir);
    assert.ok(r.warnings.some(w => /deprecated config key may be present: storage\.inlineMaxBytes/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("unparseable yaml records an error and keeps defaults", () => {
  const dir = cfgDir("history: [1, 2\n");
  try {
    const r = loadConfig(dir);
    assert.ok(r.errors.length >= 1);
    assert.deepEqual(r.config, DEFAULTS);
  } finally {
    cleanup(dir);
  }
});
