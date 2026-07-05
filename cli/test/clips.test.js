import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inspectClipFile,
  inspectLatestClip,
  latestClipFile,
  listClipFiles,
  repairLatestClip,
} from "../src/lib/clips.js";

const textItem = id => ({
  id,
  kind: "text",
  mime: "text/plain;charset=utf-8",
  bytes: 5,
  contentBytes: 76,
  contentSha256: "e79cc3efa4f0614fba20437f0317646990b53021365116ccd404cfe421b95b57",
  createdAt: 1,
  usedAt: 1,
  payloads: [
    { mime: "text/plain;charset=utf-8", encoding: "utf8", value: "hello", bytes: 5 },
  ],
});
const snap = (items = []) => JSON.stringify({ type: "history", writtenAt: 1, items });

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cg-clips-"));
}

test("listClipFiles filters to clips-*.jsonl and sorts by date", () => {
  const dir = dataDir();
  try {
    fs.writeFileSync(path.join(dir, "clips-20260629.jsonl"), `${snap([textItem("a")])}\n`, "utf8");
    fs.writeFileSync(path.join(dir, "clips-20260630.jsonl"), `${snap([textItem("b")])}\n`, "utf8");
    fs.writeFileSync(path.join(dir, "other.txt"), "nope\n", "utf8");
    const names = listClipFiles(dir).map(f => path.basename(f));
    assert.deepEqual(names, ["clips-20260629.jsonl", "clips-20260630.jsonl"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("latestClipFile returns the newest by filename date", () => {
  const dir = dataDir();
  try {
    fs.writeFileSync(path.join(dir, "clips-20260629.jsonl"), `${snap()}\n`, "utf8");
    fs.writeFileSync(path.join(dir, "clips-20260701.jsonl"), `${snap()}\n`, "utf8");
    assert.equal(path.basename(latestClipFile(dir)), "clips-20260701.jsonl");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listClipFiles returns [] for a missing directory", () => {
  assert.deepEqual(listClipFiles(path.join(os.tmpdir(), `cg-no-such-${process.pid}`)), []);
});

test("inspectLatestClip reports a clean 'no file' state when empty", () => {
  const dir = dataDir();
  try {
    const r = inspectLatestClip(dir);
    assert.equal(r.ok, true);
    assert.equal(r.exists, false);
    assert.equal(r.file, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectClipFile: valid latest line is ok with item count", () => {
  const dir = dataDir();
  const f = path.join(dir, "clips-20260630.jsonl");
  try {
    fs.writeFileSync(f, `${snap([textItem("a")])}\n${snap([textItem("b")])}\n`, "utf8");
    const r = inspectClipFile(f);
    assert.equal(r.ok, true);
    assert.equal(r.exists, true);
    assert.equal(r.count, 1); // only the last line is inspected
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectClipFile: a trailing newline after a multi-chunk snapshot is not an empty line", () => {
  const dir = dataDir();
  const f = path.join(dir, "clips-20260630.jsonl");
  const value = "x".repeat(1024 * 1024);
  const item = {
    ...textItem("large"),
    bytes: value.length,
    payloads: [{
      mime: "text/plain;charset=utf-8",
      encoding: "utf8",
      value,
      bytes: value.length,
    }],
  };
  try {
    const line = snap([item]);
    assert.ok(Buffer.byteLength(line) > 1024 * 1024);
    fs.writeFileSync(f, `${line}\n`, "utf8");
    const result = inspectClipFile(f);
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(result.lineBytes, Buffer.byteLength(line));
    assert.doesNotMatch(result.message, /empty clips file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectClipFile: persisted content identity is accepted", () => {
  const dir = dataDir();
  const f = path.join(dir, "clips-20260630.jsonl");
  try {
    const item = {
      ...textItem("indexed"),
      contentBytes: 123,
      contentSha256: "a".repeat(64),
    };
    fs.writeFileSync(f, `${snap([item])}\n`, "utf8");
    const result = inspectClipFile(f);
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectClipFile: partial or malformed content identity is invalid", () => {
  const dir = dataDir();
  const f = path.join(dir, "clips-20260630.jsonl");
  try {
    const partial = textItem("partial");
    delete partial.contentSha256;
    fs.writeFileSync(f, `${snap([partial])}\n`, "utf8");
    let result = inspectClipFile(f);
    assert.equal(result.ok, false);
    assert.match(result.message, /invalid content identity/);

    fs.writeFileSync(f, `${snap([{
      ...textItem("malformed"),
      contentBytes: 123,
      contentSha256: "A".repeat(64),
    }])}\n`, "utf8");
    result = inspectClipFile(f);
    assert.equal(result.ok, false);
    assert.match(result.message, /invalid content identity/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectClipFile: empty file is ok with count 0", () => {
  const dir = dataDir();
  const f = path.join(dir, "clips-20260630.jsonl");
  try {
    fs.writeFileSync(f, "", "utf8");
    const r = inspectClipFile(f);
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
    assert.match(r.message, /empty clips file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectClipFile: invalid envelope is not ok", () => {
  const dir = dataDir();
  const f = path.join(dir, "clips-20260630.jsonl");
  try {
    fs.writeFileSync(f, `${JSON.stringify({ foo: "bar" })}\n`, "utf8");
    const r = inspectClipFile(f);
    assert.equal(r.ok, false);
    assert.match(r.message, /invalid envelope/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repairLatestClip: no file -> ok and unchanged", () => {
  const dir = dataDir();
  try {
    const r = repairLatestClip(dir);
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repairLatestClip: valid file -> no repair needed", () => {
  const dir = dataDir();
  try {
    fs.writeFileSync(path.join(dir, "clips-20260630.jsonl"), `${snap([textItem("a")])}\n`, "utf8");
    const r = repairLatestClip(dir);
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.match(r.message, /no repair needed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repairLatestClip dry-run plans but does not modify the file", () => {
  const dir = dataDir();
  const f = path.join(dir, "clips-20260630.jsonl");
  const valid = snap([textItem("a")]);
  const garbage = `{"type":"history","writtenAt":1,"items":[{"id":"c`;
  try {
    fs.writeFileSync(f, `${valid}\n${garbage}`, "utf8");
    const before = fs.readFileSync(f, "utf8");
    const r = repairLatestClip(dir); // dry-run (no yes)
    assert.equal(r.ok, false);
    assert.equal(r.changed, false);
    assert.ok(r.backup);
    assert.equal(typeof r.truncateTo, "number");
    assert.equal(fs.readFileSync(f, "utf8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repairLatestClip --yes backs up, truncates the bad line, and restores health", () => {
  const dir = dataDir();
  const f = path.join(dir, "clips-20260630.jsonl");
  const line1 = snap([textItem("a")]);
  const line2 = snap([textItem("b")]);
  const garbage = `{"type":"history","writtenAt":1,"items":[{"id":"c`;
  try {
    fs.writeFileSync(f, `${line1}\n${line2}\n${garbage}`, "utf8");
    const r = repairLatestClip(dir, { yes: true });
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.ok(fs.existsSync(r.backup), "backup file was created");

    const after = fs.readFileSync(f, "utf8");
    assert.ok(!after.includes('"id":"c'), "garbage was truncated away");

    const re = inspectClipFile(f);
    assert.equal(re.ok, true);
    assert.equal(re.count, 1); // last line is now the previous valid snapshot
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
