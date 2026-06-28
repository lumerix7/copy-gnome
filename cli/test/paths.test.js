import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { resolveDataPaths, xdgDataHome } from "../src/lib/paths.js";

let prevHome;
let prevXdg;

beforeEach(() => {
  prevHome = process.env.COPY_GNOME_HOME;
  prevXdg = process.env.XDG_DATA_HOME;
});

afterEach(() => {
  for (const [key, val] of [["COPY_GNOME_HOME", prevHome], ["XDG_DATA_HOME", prevXdg]]) {
    if (val === undefined)
      delete process.env[key];
    else
      process.env[key] = val;
  }
});

test("explicit writable COPY_GNOME_HOME is used as base, data lives under base/data", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-paths-"));
  try {
    process.env.COPY_GNOME_HOME = home;
    const p = resolveDataPaths();
    assert.equal(p.usedFallback, false);
    assert.equal(p.base, home);
    assert.equal(p.explicit, home);
    assert.equal(p.config, path.join(home, "config"));
    assert.equal(p.data, path.join(home, "data"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("falls back to XDG_DATA_HOME/copy-gnome when the preferred home is unusable", () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "cg-xdg-"));
  try {
    // two missing levels: the parent does not exist, so canUseDataHome is false
    process.env.COPY_GNOME_HOME = path.join(os.tmpdir(), `cg-missing-${process.pid}-${Date.now()}`, "child");
    process.env.XDG_DATA_HOME = xdg;
    const p = resolveDataPaths();
    assert.equal(p.usedFallback, true);
    assert.equal(p.base, path.join(xdg, "copy-gnome"));
    assert.equal(p.config, path.join(p.base, "config"));
    assert.equal(p.data, p.base); // fallback asymmetry: data dir IS the base, not base/data
  } finally {
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test("xdgDataHome respects XDG_DATA_HOME", () => {
  process.env.XDG_DATA_HOME = "/some/xdg";
  assert.equal(xdgDataHome(), "/some/xdg");
});

test("xdgDataHome defaults to ~/.local/share when unset", () => {
  delete process.env.XDG_DATA_HOME;
  assert.equal(xdgDataHome(), path.join(os.homedir(), ".local", "share"));
});
