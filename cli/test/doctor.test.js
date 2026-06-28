import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS } from "../src/lib/config.js";
import { runDoctor } from "../src/lib/doctor.js";

const OK_LOGS = { ok: true, lines: [], since: "30m" };

// Build a fixture status pointing at throwaway extension + data dirs so doctor's
// check logic runs without touching the real install. Baseline is healthy.
function makeFixture(overrides = {}) {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ext-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "cg-data-"));
  for (const d of ["core", "ui", "vendor", "schemas"])
    fs.mkdirSync(path.join(ext, d), { recursive: true });
  fs.writeFileSync(path.join(ext, "metadata.json"), JSON.stringify({ uuid: "copy-gnome@clipboard" }), "utf8");
  fs.writeFileSync(path.join(ext, "extension.js"), "// stub\n", "utf8");
  fs.writeFileSync(path.join(ext, "schemas", "gschemas.compiled"), "", "utf8");

  const baseConfig = structuredClone(DEFAULTS);
  baseConfig.general.captureImages = false; // baseline: no risky-setting warnings

  const status = {
    node: "v24",
    session: "wayland",
    desktop: "ubuntu:GNOME",
    shell: { ok: true, version: "GNOME Shell 50", major: 50, supported: true, error: null },
    extension: {
      uuid: "copy-gnome@clipboard",
      installed: true,
      dir: ext,
      sourceDir: ext,
      metadata: { "version-name": "0.1.0" },
      infoOk: true,
      info: { state: "ACTIVE", enabled: "Yes", version: "0.1.0 (1)" },
      infoError: null,
    },
    gsettings: { schema: "org.gnome.shell.extensions.copy-gnome", schemaDir: ext, togglePopup: "['<Super>v']", ok: true, error: null },
    paths: { explicit: null, preferred: data, fallback: data, base: data, usedFallback: false, config: path.join(data, "config"), data },
    config: { file: path.join(data, "config", "config.yaml"), format: "yaml", exists: true, config: baseConfig, warnings: [], errors: [] },
    clips: { file: path.join(data, "clips.jsonl"), ok: true, exists: true, message: "latest snapshot ok (1 items)" },
    ...overrides,
  };
  const cleanup = () => {
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  };
  return { status, ext, cleanup };
}

function check(report, id) {
  return report.checks.find(c => c.id === id);
}

test("healthy fixture -> ok with no fail checks, and extension.files ok", () => {
  const f = makeFixture();
  try {
    const r = runDoctor({}, { status: f.status, logs: OK_LOGS });
    assert.equal(r.ok, true);
    assert.ok(!r.checks.some(c => c.severity === "fail"));
    assert.equal(check(r, "extension.files").severity, "ok");
  } finally {
    f.cleanup();
  }
});

test("missing extension.js -> extension.files fails and names it", () => {
  const f = makeFixture();
  try {
    fs.unlinkSync(path.join(f.ext, "extension.js"));
    const r = runDoctor({}, { status: f.status, logs: OK_LOGS });
    assert.equal(r.ok, false);
    assert.equal(check(r, "extension.files").severity, "fail");
    assert.match(check(r, "extension.files").message, /extension\.js/);
  } finally {
    f.cleanup();
  }
});

test("missing gschemas.compiled -> extension.files fails and names it", () => {
  const f = makeFixture();
  try {
    fs.unlinkSync(path.join(f.ext, "schemas", "gschemas.compiled"));
    const r = runDoctor({}, { status: f.status, logs: OK_LOGS });
    assert.equal(check(r, "extension.files").severity, "fail");
    assert.match(check(r, "extension.files").message, /gschemas\.compiled/);
  } finally {
    f.cleanup();
  }
});

test("empty toggle-popup keybinding -> gsettings.toggle-popup warns", () => {
  const f = makeFixture();
  f.status.gsettings = { schema: "x", schemaDir: f.ext, togglePopup: "@as []", ok: true, error: null };
  try {
    const r = runDoctor({}, { status: f.status, logs: OK_LOGS });
    const g = check(r, "gsettings.toggle-popup");
    assert.equal(g.severity, "warn");
    assert.match(g.message, /empty/i);
  } finally {
    f.cleanup();
  }
});

test("--require-active fails when the extension is not ACTIVE", () => {
  const f = makeFixture();
  f.status.extension.info = { state: "DISABLED", enabled: "No" };
  try {
    const r = runDoctor({ requireActive: true }, { status: f.status, logs: OK_LOGS });
    assert.equal(r.ok, false);
    assert.equal(check(r, "extension.active").severity, "fail");
  } finally {
    f.cleanup();
  }
});

test("captureImages enabled -> config.capture-images warns", () => {
  const f = makeFixture();
  f.status.config.config.general.captureImages = true;
  try {
    const r = runDoctor({}, { status: f.status, logs: OK_LOGS });
    assert.equal(check(r, "config.capture-images").severity, "warn");
  } finally {
    f.cleanup();
  }
});

test("unparseable config -> config.parse fails", () => {
  const f = makeFixture();
  f.status.config.errors = ["config.yaml parse failed: bad map"];
  try {
    const r = runDoctor({}, { status: f.status, logs: OK_LOGS });
    assert.equal(r.ok, false);
    assert.equal(check(r, "config.parse").severity, "fail");
  } finally {
    f.cleanup();
  }
});

test("unsupported GNOME major -> system.gnome-shell warns", () => {
  const f = makeFixture();
  f.status.shell = { ok: true, version: "GNOME Shell 99", major: 99, supported: false, error: null };
  try {
    const r = runDoctor({}, { status: f.status, logs: OK_LOGS });
    assert.equal(check(r, "system.gnome-shell").severity, "warn");
  } finally {
    f.cleanup();
  }
});

test("signal 11 in gnome-shell logs -> logs.gnome-shell warns", () => {
  const f = makeFixture();
  const logs = { ok: true, lines: ["Jun 30 host gnome-shell[123]: signal 11 (SIGSEGV)"], since: "30m" };
  try {
    const r = runDoctor({}, { status: f.status, logs });
    assert.equal(check(r, "logs.gnome-shell").severity, "warn");
  } finally {
    f.cleanup();
  }
});
