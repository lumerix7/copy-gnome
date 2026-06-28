import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SERVICE_BUS_NAME,
  SERVICE_INTERFACE,
  SERVICE_OBJECT_PATH,
  callService,
  serviceExitCode,
} from "../src/lib/ipc.js";

function busctlReply(envelope) {
  return {
    ok: true,
    status: 0,
    signal: null,
    stdout: `${JSON.stringify({ type: "s", data: [JSON.stringify(envelope)] })}\n`,
    stderr: "",
    error: null,
  };
}

function busctlFailure(overrides = {}) {
  return {
    ok: false,
    status: 1,
    signal: null,
    stdout: "",
    stderr: "",
    error: null,
    ...overrides,
  };
}

function capture(reply) {
  const calls = [];
  const runner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return reply;
  };
  return { calls, runner };
}

test("callService parses the JSON envelope out of busctl --json=short output", () => {
  const { runner } = capture(busctlReply({ ok: true, total: 2, items: [] }));
  const result = callService("List", [20], { runner });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
});

test("callService builds the busctl argv with signature and stringified args", () => {
  const { calls, runner } = capture(busctlReply({ ok: true }));
  callService("Search", ["hello world", 5], { runner, timeoutSec: 4 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "busctl");
  assert.deepEqual(calls[0].args, [
    "--user",
    "--json=short",
    "--timeout=4",
    "call",
    SERVICE_BUS_NAME,
    SERVICE_OBJECT_PATH,
    SERVICE_INTERFACE,
    "Search",
    "su",
    "hello world",
    "5",
  ]);
});

test("callService omits the signature for no-arg methods", () => {
  const { calls, runner } = capture(busctlReply({ ok: true }));
  callService("Status", [], { runner });
  assert.deepEqual(calls[0].args.slice(-1), ["Status"]);
});

test("callService rejects unknown methods without spawning busctl", () => {
  const { calls, runner } = capture(busctlReply({ ok: true }));
  const result = callService("Nope", [], { runner });
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-args");
  assert.equal(calls.length, 0);
});

test("a missing bus name maps to service-unavailable", () => {
  const { runner } = capture(busctlFailure({
    stderr: "Call failed: The name org.gnome.Shell.Extensions.CopyGnome was not provided by any .service files\n",
  }));
  const result = callService("List", [0], { runner });
  assert.equal(result.ok, false);
  assert.equal(result.code, "service-unavailable");
  assert.equal(serviceExitCode(result), 3);
});

test("a missing busctl binary maps to no-busctl", () => {
  const { runner } = capture(busctlFailure({ error: Object.assign(new Error("spawn busctl ENOENT"), { code: "ENOENT" }) }));
  const result = callService("List", [0], { runner });
  assert.equal(result.code, "no-busctl");
  assert.equal(serviceExitCode(result), 3);
});

test("a spawn timeout maps to timeout", () => {
  const { runner } = capture(busctlFailure({
    signal: "SIGTERM",
    error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
  }));
  const result = callService("List", [0], { runner });
  assert.equal(result.code, "timeout");
  assert.equal(serviceExitCode(result), 3);
});

test("unparseable busctl output maps to bad-reply", () => {
  const { runner } = capture({ ok: true, status: 0, signal: null, stdout: "not json", stderr: "", error: null });
  const result = callService("List", [0], { runner });
  assert.equal(result.code, "bad-reply");
});

test("an envelope that is not a JSON object maps to bad-reply", () => {
  const { runner } = capture({
    ok: true,
    status: 0,
    signal: null,
    stdout: JSON.stringify({ type: "s", data: ["[1,2]"] }),
    stderr: "",
    error: null,
  });
  const result = callService("List", [0], { runner });
  assert.equal(result.code, "bad-reply");
});

test("serviceExitCode maps envelope codes to docs/12-cli exit codes", () => {
  assert.equal(serviceExitCode({ ok: true }), 0);
  assert.equal(serviceExitCode({ ok: false, code: "not-found" }), 4);
  assert.equal(serviceExitCode({ ok: false, code: "ambiguous" }), 2);
  assert.equal(serviceExitCode({ ok: false, code: "bad-args" }), 2);
  assert.equal(serviceExitCode({ ok: false, code: "not-ready" }), 3);
  assert.equal(serviceExitCode({ ok: false, code: "service-unavailable" }), 3);
  assert.equal(serviceExitCode({ ok: false, code: "restore-failed" }), 1);
  assert.equal(serviceExitCode({ ok: false }), 1);
});
