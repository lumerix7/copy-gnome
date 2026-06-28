import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function runGjsPreview(version) {
  const modulePath = path.join(repoRoot, `copy-gnome-${version}`, "core", "preview.js");
  const script = [
    `import { POPUP_PREVIEW_CHARS, recordPreview } from 'file://${modulePath}';`,
    "function assertEq(actual, expected, msg) { if (actual !== expected) throw new Error(`${msg}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }",
    "const long = 'a'.repeat(POPUP_PREVIEW_CHARS + 20);",
    "const textRec = { kind: 'text', payloads: [{ mime: 'text/plain;charset=utf-8', encoding: 'utf8', value: `  hello\\n\\t${long}`, bytes: long.length + 8 }] };",
    "const textPreview = recordPreview(textRec, { max: POPUP_PREVIEW_CHARS });",
    "if (textPreview.length !== POPUP_PREVIEW_CHARS) throw new Error(`bounded preview length: ${textPreview.length}`);",
    "if (!textPreview.startsWith('hello a')) throw new Error(`normalized whitespace: ${textPreview}`);",
    "const oldRec = { kind: 'text', preview: 'legacy preview' };",
    "assertEq(recordPreview(oldRec), '[text]', 'legacy top-level preview ignored');",
    "const fileRec = { kind: 'file', payloads: [{ mime: 'text/uri-list', encoding: 'uri-list', value: 'file:///tmp/a%20b.txt\\nfile:///tmp/c.txt', bytes: 42 }] };",
    "assertEq(recordPreview(fileRec), '/tmp/a b.txt (+more)', 'file preview');",
    "const singleFileRec = { kind: 'file', payloads: [{ mime: 'text/uri-list', encoding: 'uri-list', value: 'file:///tmp/one.txt\\n', bytes: 20 }] };",
    "assertEq(recordPreview(singleFileRec), '/tmp/one.txt', 'single file trailing newline');",
  ].join("\n");

  const scriptPath = path.join(os.tmpdir(), `copy-gnome-preview-${process.pid}-${version}.mjs`);
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    return spawnSync("gjs", ["-m", scriptPath], { encoding: "utf8" });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

test("recordPreview derives bounded display text from payloads", { skip: !hasGjs() }, () => {
  for (const version of ["46", "50"]) {
    const r = runGjsPreview(version);
    assert.equal(r.status, 0, `GNOME ${version} preview failed\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
});

function hasGjs() {
  return spawnSync("gjs", ["--version"], { encoding: "utf8" }).status === 0;
}
