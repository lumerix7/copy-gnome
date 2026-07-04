import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { resolveDataPaths, xdgConfigHome, xdgStateHome } from "../src/lib/paths.js";

let prevConfig;
let prevState;

beforeEach(() => {
  prevConfig = process.env.XDG_CONFIG_HOME;
  prevState = process.env.XDG_STATE_HOME;
});

afterEach(() => {
  for (const [key, val] of [["XDG_CONFIG_HOME", prevConfig], ["XDG_STATE_HOME", prevState]]) {
    if (val === undefined)
      delete process.env[key];
    else
      process.env[key] = val;
  }
});

test("writable durable home is used for config and state XDG dirs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-paths-"));
  try {
    const p = resolveDataPaths({ preferredHome: home });
    assert.equal(p.usedFallback, false);
    assert.equal(p.base, home);
    assert.equal(p.preferred, home);
    assert.equal(p.config, path.join(home, ".config", "copy-gnome"));
    assert.equal(p.data, path.join(home, ".local", "state", "copy-gnome"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("falls back to real-home XDG config/state dirs when durable home is unusable", () => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "cg-real-home-"));
  try {
    const missing = path.join(os.tmpdir(), `cg-missing-${process.pid}-${Date.now()}`, "child");
    const p = resolveDataPaths({ preferredHome: missing, fallbackHome: realHome });
    assert.equal(p.usedFallback, true);
    assert.equal(p.base, realHome);
    assert.equal(p.config, path.join(realHome, ".config", "copy-gnome"));
    assert.equal(p.data, path.join(realHome, ".local", "state", "copy-gnome"));
  } finally {
    fs.rmSync(realHome, { recursive: true, force: true });
  }
});

test("falls back when a preferred app dir cannot be created", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-paths-"));
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "cg-real-home-"));
  try {
    fs.writeFileSync(path.join(home, ".config"), "not a dir", "utf8");
    const p = resolveDataPaths({ preferredHome: home, fallbackHome: realHome });
    assert.equal(p.usedFallback, true);
    assert.equal(p.base, realHome);
    assert.equal(p.config, path.join(realHome, ".config", "copy-gnome"));
    assert.equal(p.data, path.join(realHome, ".local", "state", "copy-gnome"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(realHome, { recursive: true, force: true });
  }
});

test("fallback respects XDG_CONFIG_HOME and XDG_STATE_HOME", () => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "cg-real-home-"));
  try {
    process.env.XDG_CONFIG_HOME = "/some/config";
    process.env.XDG_STATE_HOME = "/some/state";
    const missing = path.join(os.tmpdir(), `cg-missing-${process.pid}-${Date.now()}`, "child");
    const p = resolveDataPaths({ preferredHome: missing, fallbackHome: realHome });
    assert.equal(p.config, path.join("/some/config", "copy-gnome"));
    assert.equal(p.data, path.join("/some/state", "copy-gnome"));
  } finally {
    fs.rmSync(realHome, { recursive: true, force: true });
  }
});

test("XDG helpers default under the given home", () => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
  assert.equal(xdgConfigHome("/home/u"), path.join("/home/u", ".config"));
  assert.equal(xdgStateHome("/home/u"), path.join("/home/u", ".local", "state"));
});
