import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function runGjsValidation(version) {
  const modulePath = path.join(repoRoot, `copy-gnome-${version}`, "core", "prefs-validation.js");
  const script = [
    `import { pasteKeybindingsValue } from 'file://${modulePath}';`,
    "function assertOk(r, msg) { if (!r.ok) throw new Error(`${msg}: ${r.error}`); }",
    "function assertFail(r, pattern, msg) { if (r.ok || !pattern.test(r.error)) throw new Error(`${msg}: ${JSON.stringify(r)}`); }",
    "const valid = pasteKeybindingsValue([{ keys: [' ctrl ', 'shift', 'v'], apps: ['Terminal', 'org.gnome.Ptyxis'] }]);",
    "assertOk(valid, 'valid binding');",
    "if (JSON.stringify(valid.value) !== JSON.stringify([{ keys: ['ctrl', 'shift', 'v'], apps: ['Terminal', 'org.gnome.Ptyxis'] }])) throw new Error('valid binding normalized unexpectedly');",
    "assertFail(pasteKeybindingsValue({}), /expected JSON array/, 'top-level object');",
    "assertFail(pasteKeybindingsValue([null]), /item 1: expected object/, 'null item');",
    "assertFail(pasteKeybindingsValue([{ keys: 'ctrl,shift,v', apps: ['terminal'] }]), /item 1\\.keys: expected string array/, 'string keys');",
    "assertFail(pasteKeybindingsValue([{ keys: ['ctrl', 'shift', 'v'], apps: 'terminal' }]), /item 1\\.apps: expected string array/, 'string apps');",
    "assertFail(pasteKeybindingsValue([{ keys: [], apps: ['terminal'] }]), /item 1\\.keys: expected at least one value/, 'empty keys');",
    "assertFail(pasteKeybindingsValue([{ keys: ['ctrl'], apps: [] }]), /item 1\\.apps: expected at least one value/, 'empty apps');",
  ].join("\n");

  const scriptPath = path.join(os.tmpdir(), `copy-gnome-prefs-validation-${process.pid}-${version}.mjs`);
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    return spawnSync("gjs", ["-m", scriptPath], { encoding: "utf8" });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

test("prefs pasteKeybindings validation rejects malformed nested arrays", { skip: !hasGjs() }, () => {
  for (const version of ["46", "50"]) {
    const r = runGjsValidation(version);
    assert.equal(r.status, 0, `GNOME ${version} validation failed\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
});

function hasGjs() {
  return spawnSync("gjs", ["--version"], { encoding: "utf8" }).status === 0;
}
