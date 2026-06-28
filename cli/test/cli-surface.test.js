import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProgram } from "../src/cli.js";
import { COMMANDS } from "../src/lib/completion.js";

// Guards against cli.js (commander, source of truth) and completion.js
// (hand-mirrored) drifting apart - the same hand-maintained-parallel problem
// check-sync.sh solves for the extension trees. If a command or option is added
// to the CLI but not completion, these fail.

function realTopLevelCommands() {
  return buildProgram().commands.filter(c => c.name() !== "help");
}

test("completion registers exactly the CLI's top-level commands", () => {
  const real = realTopLevelCommands().map(c => c.name()).sort();
  const declared = COMMANDS.map(c => c.name).sort();
  assert.deepEqual(real, declared);
});

test("completion covers every option each CLI command defines", () => {
  const byName = new Map(COMMANDS.map(c => [c.name, c]));
  for (const cmd of realTopLevelCommands()) {
    const entry = byName.get(cmd.name());
    assert.ok(entry, `no completion entry for command ${cmd.name()}`);
    const declared = new Set(entry.options);
    for (const opt of cmd.options) {
      if (opt.long === "--help") continue; // commander adds help automatically
      for (const flag of [opt.short, opt.long].filter(Boolean))
        assert.ok(declared.has(flag), `completion missing ${flag} on ${cmd.name()}`);
    }
  }
});

test("completion's config subcommands match the CLI's config subcommands", () => {
  const configCmd = buildProgram().commands.find(c => c.name() === "config");
  const real = configCmd.commands.filter(c => c.name() !== "help").map(c => c.name()).sort();
  const declared = Object.keys(COMMANDS.find(c => c.name === "config").subcommands).sort();
  assert.deepEqual(real, declared);
});
