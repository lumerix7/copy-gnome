import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProgram } from "../src/cli.js";

const TEXT_ITEM = {
  id: "12345678-aaaa-bbbb-cccc-123456789abc",
  kind: "text",
  mime: "text/plain;charset=utf-8",
  bytes: 11,
  preview: "hello world",
  payloads: [{ mime: "text/plain;charset=utf-8", encoding: "utf8", value: "hello world" }],
};

const HTML_ITEM = {
  id: "abcdef12-aaaa-bbbb-cccc-123456789abc",
  kind: "rich",
  mime: "text/html",
  bytes: 42,
  preview: "<b>hello</b>",
  payloads: [
    { mime: "text/html", encoding: "utf8", value: "<b>hello</b>" },
    { mime: "text/plain;charset=utf-8", encoding: "utf8", value: "hello" },
  ],
};

function serviceReply(envelope) {
  return () => envelope;
}

async function runCli(args, opts = {}) {
  const calls = [];
  const serviceCaller = opts.serviceCaller ?? ((method, callArgs = [], callOpts = {}) => {
    calls.push({ method, args: callArgs, opts: callOpts });
    const reply = typeof opts.replies === "function"
      ? opts.replies(method, callArgs, callOpts)
      : opts.replies?.[method];
    return reply ?? { ok: true };
  });

  const program = buildProgram({
    serviceCaller,
    readStdin: opts.readStdin ?? (() => ""),
    statusCollector: opts.statusCollector ?? (() => ({
      node: "v24.0.0",
      shell: { ok: true, version: "GNOME Shell 50.1" },
      session: "wayland",
      extension: { uuid: "copy-gnome@clipboard", installed: true, dir: "/ext", info: { state: "ACTIVE" }, infoOk: true },
      gsettings: { togglePopup: "['<Super>v']" },
      paths: { usedFallback: false, base: "/opt/copy-gnome/u", data: "/opt/copy-gnome/u/data" },
      config: { file: "/opt/copy-gnome/u/config/config.yaml" },
      clips: { file: "/opt/copy-gnome/u/data/clips.jsonl", message: "ok" },
    })),
  });
  program.exitOverride();

  return captureIo(async () => {
    await program.parseAsync(["node", "copy-gnome", ...args], { from: "node" });
  }, calls);
}

async function captureIo(fn, calls) {
  const oldStdoutWrite = process.stdout.write;
  const oldStderrWrite = process.stderr.write;
  const oldExitCode = process.exitCode;
  const stdout = [];
  const stderr = [];
  process.exitCode = undefined;
  process.stdout.write = (chunk, encoding, cb) => captureWrite(stdout, chunk, encoding, cb);
  process.stderr.write = (chunk, encoding, cb) => captureWrite(stderr, chunk, encoding, cb);
  try {
    await fn();
    return { calls, stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode ?? 0 };
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
    process.exitCode = oldExitCode;
  }
}

function captureWrite(buffer, chunk, encoding, cb) {
  buffer.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  if (typeof encoding === "function")
    encoding();
  if (typeof cb === "function")
    cb();
  return true;
}

test("status --json appends the live service status with a short timeout", async () => {
  const r = await runCli(["status", "--json"], {
    replies: { Status: { ok: true, ready: true, count: 7 } },
  });
  assert.deepEqual(r.calls, [{ method: "Status", args: [], opts: { timeoutSec: 3 } }]);
  const status = JSON.parse(r.stdout);
  assert.equal(status.service.ready, true);
  assert.equal(status.service.count, 7);
});

test("list calls List with the requested limit and prints truncation info", async () => {
  const r = await runCli(["list", "--limit", "1"], {
    replies: { List: { ok: true, total: 2, items: [TEXT_ITEM] } },
  });
  assert.deepEqual(r.calls[0], { method: "List", args: [1], opts: {} });
  assert.match(r.stdout, /hello world/);
  assert.match(r.stdout, /\(1 of 2 entries\)/);
});

test("service-backed --json commands print the raw envelope and map exit codes", async () => {
  const r = await runCli(["list", "--json"], {
    replies: { List: { ok: false, code: "not-found", error: "missing" } },
  });
  assert.equal(r.exitCode, 4);
  assert.deepEqual(JSON.parse(r.stdout), { ok: false, code: "not-found", error: "missing" });
});

test("search passes query and limit to Search", async () => {
  const r = await runCli(["search", "hello", "--limit", "3"], {
    replies: { Search: { ok: true, total: 1, items: [TEXT_ITEM] } },
  });
  assert.deepEqual(r.calls[0], { method: "Search", args: ["hello", 3], opts: {} });
  assert.match(r.stdout, /hello world/);
});

test("get prints the plain text payload by default", async () => {
  const r = await runCli(["get", "abcdef12"], {
    replies: { Get: { ok: true, item: HTML_ITEM } },
  });
  assert.deepEqual(r.calls[0], { method: "Get", args: ["abcdef12"], opts: {} });
  assert.equal(r.stdout, "hello");
});

test("get --raw decodes base64 payloads", async () => {
  const raw = "raw\0bytes";
  const r = await runCli(["get", "img1", "--raw"], {
    replies: {
      Get: {
        ok: true,
        item: {
          id: "img1",
          kind: "image",
          payloads: [{ mime: "image/png", encoding: "base64", value: Buffer.from(raw).toString("base64") }],
        },
      },
    },
  });
  assert.equal(r.stdout, raw);
});

test("get without --raw refuses binary-only entries", async () => {
  const r = await runCli(["get", "img1"], {
    replies: { Get: { ok: true, item: { id: "img1", kind: "image", payloads: [] } } },
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /use --raw/);
});

test("use validates mode before calling Use", async () => {
  const bad = await runCli(["use", "abc1", "--mode", "html"], {
    replies: { Use: { ok: true, id: "abc1", kind: "rich" } },
  });
  assert.equal(bad.exitCode, 2);
  assert.equal(bad.calls.length, 0);
  assert.match(bad.stderr, /invalid --mode/);

  const good = await runCli(["use", "abc1", "--mode", "plain"], {
    replies: { Use: { ok: true, id: "abc1", kind: "rich" } },
  });
  assert.deepEqual(good.calls[0], { method: "Use", args: ["abc1", "plain"], opts: {} });
  assert.match(good.stdout, /restored abc1 \(rich\)/);
});

test("copy sends joined arguments as CopyText", async () => {
  const r = await runCli(["copy", "hello", "world"], {
    replies: { CopyText: { ok: true, id: "new1", bytes: 11 } },
  });
  assert.deepEqual(r.calls[0], { method: "CopyText", args: ["hello world"], opts: {} });
  assert.match(r.stdout, /copied 11 bytes/);
});

test("copy can read stdin and refuses empty input", async () => {
  const stdin = await runCli(["copy", "-"], {
    readStdin: () => "from stdin",
    replies: { CopyText: { ok: true, id: "stdin1", bytes: 10 } },
  });
  assert.deepEqual(stdin.calls[0], { method: "CopyText", args: ["from stdin"], opts: {} });

  const empty = await runCli(["copy"], { readStdin: () => "" });
  assert.equal(empty.exitCode, 2);
  assert.equal(empty.calls.length, 0);
  assert.match(empty.stderr, /nothing to copy/);
});

test("paste prints clipboard text and reports an empty clipboard", async () => {
  const text = await runCli(["paste"], {
    replies: { GetClipboardText: { ok: true, hasText: true, text: "clip text" } },
  });
  assert.deepEqual(text.calls[0], { method: "GetClipboardText", args: [], opts: {} });
  assert.equal(text.stdout, "clip text");

  const empty = await runCli(["paste"], {
    replies: { GetClipboardText: { ok: true, hasText: false, text: "" } },
  });
  assert.equal(empty.exitCode, 1);
  assert.match(empty.stderr, /no text on the clipboard/);
});

test("rm, clear, and popup call the expected service methods", async () => {
  const rm = await runCli(["rm", "1234"], {
    replies: { Remove: { ok: true, id: "1234" } },
  });
  assert.deepEqual(rm.calls[0], { method: "Remove", args: ["1234"], opts: {} });
  assert.match(rm.stdout, /removed 1234/);

  const refused = await runCli(["clear"]);
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.calls.length, 0);
  assert.match(refused.stderr, /without --yes/);

  const clear = await runCli(["clear", "--yes"], {
    replies: { Clear: { ok: true, cleared: 4 } },
  });
  assert.deepEqual(clear.calls[0], { method: "Clear", args: [], opts: {} });
  assert.match(clear.stdout, /cleared 4 entries/);

  const popup = await runCli(["popup"], {
    replies: { Popup: { ok: true } },
  });
  assert.deepEqual(popup.calls[0], { method: "Popup", args: [], opts: {} });
  assert.match(popup.stdout, /popup toggled/);
});
