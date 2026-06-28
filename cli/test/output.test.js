import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import {
  dim,
  error,
  field,
  formatHelp,
  printChecks,
  printJson,
  printStatus,
  severityLabel,
  success,
  warn,
  yesNo,
} from "../src/lib/output.js";

// Capture console.log / console.error so we can assert on what the writers emit.
// chalk may wrap output in ANSI codes depending on the run environment, so color
// assertions use .includes() (ANSI-tolerant) rather than exact equality.
function captureConsole() {
  const calls = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => calls.push(["out", a.join(" ")]);
  console.error = (...a) => calls.push(["err", a.join(" ")]);
  return {
    calls,
    out() { return calls.filter(c => c[0] === "out").map(c => c[1]); },
    err() { return calls.filter(c => c[0] === "err").map(c => c[1]); },
    restore() { console.log = origLog; console.error = origErr; },
  };
}

test("printJson writes pretty JSON to stdout", () => {
  const cap = captureConsole();
  try {
    printJson({ a: 1 });
    assert.deepEqual(cap.out(), ['{\n  "a": 1\n}']);
  } finally {
    cap.restore();
  }
});

test("dim returns a string containing the input", () => {
  assert.ok(dim("hello").includes("hello"));
});

test("error writes to stderr with an Error: prefix", () => {
  const cap = captureConsole();
  try {
    error("boom");
    assert.ok(cap.err().some(l => l.includes("Error:") && l.includes("boom")));
  } finally {
    cap.restore();
  }
});

test("warn writes to stderr with a Warning: prefix", () => {
  const cap = captureConsole();
  try {
    warn("careful");
    assert.ok(cap.err().some(l => l.includes("Warning:") && l.includes("careful")));
  } finally {
    cap.restore();
  }
});

test("success writes to stdout with the message", () => {
  const cap = captureConsole();
  try {
    success("done");
    assert.ok(cap.out().some(l => l.includes("done")));
  } finally {
    cap.restore();
  }
});

test("yesNo returns yes / no text", () => {
  assert.ok(yesNo(true).includes("yes"));
  assert.ok(yesNo(false).includes("no"));
});

test("severityLabel returns the severity text, passing unknowns through", () => {
  for (const s of ["ok", "info", "warn", "fail"])
    assert.ok(severityLabel(s).includes(s));
  assert.equal(severityLabel("bogus"), "bogus");
});

test("field writes an aligned row containing label and value", () => {
  const cap = captureConsole();
  try {
    field("Node", "v24");
    const rows = cap.out();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].includes("Node"));
    assert.ok(rows[0].includes("v24"));
  } finally {
    cap.restore();
  }
});

test("formatHelp renders description, usage, and commands for a program with subcommands", () => {
  const program = new Command("copy-gnome").description("CLI for copy-gnome");
  program.command("status").description("show status");
  program.command("doctor").description("run diagnostics");
  const out = formatHelp(program, program.createHelp());
  assert.ok(out.includes("CLI for copy-gnome"));
  assert.ok(out.includes("Usage:"));
  assert.ok(out.includes("Commands:"));
  assert.ok(out.includes("status"));
  assert.ok(out.includes("doctor"));
  assert.ok(/for more information on a command/.test(out));
});

test("formatHelp renders arguments and options for a leaf command (no subcommand hint)", () => {
  const leaf = new Command("get").description("get one value");
  leaf.argument("<key>", "the config key");
  leaf.option("--json", "print json");
  const out = formatHelp(leaf, leaf.createHelp());
  assert.ok(out.includes("Usage:"));
  assert.ok(out.includes("Arguments:"));
  assert.ok(out.includes("<key>"));
  assert.ok(out.includes("Options:"));
  assert.ok(out.includes("--json"));
  assert.ok(!/for more information on a command/.test(out));
});

test("printStatus prints System / Extension / Data sections without throwing", () => {
  const status = {
    node: "v24",
    session: "wayland",
    shell: { version: "GNOME Shell 50", error: null },
    extension: { uuid: "copy-gnome@clipboard", installed: true, dir: "/d", info: { state: "ACTIVE" }, infoOk: true },
    gsettings: { togglePopup: "['<Super>v']", error: null },
    paths: { usedFallback: false, base: "/opt/cg", data: "/opt/cg/data" },
    config: { file: "/opt/cg/config/config.yaml" },
    clips: { file: "/opt/cg/data/clips.jsonl", message: "latest snapshot ok (3 items)" },
  };
  const cap = captureConsole();
  try {
    printStatus(status);
    const out = cap.out();
    assert.ok(out.some(l => l.includes("System")));
    assert.ok(out.some(l => l.includes("Extension")));
    assert.ok(out.some(l => l.includes("Data")));
    assert.ok(out.some(l => l.includes("v24")));
  } finally {
    cap.restore();
  }
});

test("printChecks prints Diagnostics, each check id, and a verdict", () => {
  const report = {
    ok: true,
    checks: [
      { id: "system.node", severity: "ok", message: "Node v24" },
      { id: "config.risky", severity: "warn", message: "captureImages on" },
    ],
    recovery: [],
  };
  const cap = captureConsole();
  try {
    printChecks(report);
    const out = cap.out();
    assert.ok(out.some(l => l.includes("Diagnostics")));
    assert.ok(out.some(l => l.includes("system.node")));
    assert.ok(out.some(l => l.includes("config.risky")));
    assert.ok(out.some(l => l.includes("healthy")));
  } finally {
    cap.restore();
  }
});

test("printChecks prints a Recovery section when the report is not ok", () => {
  const report = {
    ok: false,
    checks: [{ id: "x", severity: "fail", message: "broken" }],
    recovery: ["gnome-extensions disable copy-gnome@clipboard"],
  };
  const cap = captureConsole();
  try {
    printChecks(report);
    const out = cap.out();
    assert.ok(out.some(l => l.includes("unhealthy")));
    assert.ok(out.some(l => l.includes("Recovery")));
    assert.ok(out.some(l => l.includes("gnome-extensions disable")));
  } finally {
    cap.restore();
  }
});
