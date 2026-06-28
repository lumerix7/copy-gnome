import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG_KEYS } from "../src/lib/config.js";
import { commandNames, generateCompletion } from "../src/lib/completion.js";

test("commandNames covers the known command surface", () => {
  const names = commandNames();
  for (const n of [
    "status", "doctor", "logs", "enable", "disable", "restart",
    "extension-status", "paths", "config", "repair",
    "list", "search", "get", "use", "copy", "paste", "rm", "clear", "popup",
  ])
    assert.ok(names.includes(n), `missing command ${n}`);
  assert.equal(names.length, 19);
});

test("generateCompletion rejects non-bash shells", () => {
  for (const shell of ["zsh", "fish", "", "powershell"])
    assert.throws(() => generateCompletion(shell), /unsupported shell for completion/);
});

test("generateCompletion('bash') produces a well-formed bash completion script", () => {
  const out = generateCompletion("bash");
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
  assert.ok(out.includes("_copy_gnome_complete()"));
  assert.ok(out.includes("complete -F _copy_gnome_complete copy-gnome"));
});

test("completion references every command name", () => {
  const out = generateCompletion("bash");
  for (const name of commandNames())
    assert.ok(out.includes(name), `completion missing command ${name}`);
});

test("completion references every known config key (config get/set)", () => {
  const out = generateCompletion("bash");
  for (const key of CONFIG_KEYS)
    assert.ok(out.includes(key), `completion missing config key ${key}`);
});

test("completion references config subcommands", () => {
  const out = generateCompletion("bash");
  assert.ok(out.includes("path validate show get set edit"));
});

test("completion uses file completion for --file", () => {
  assert.ok(generateCompletion("bash").includes("compgen -f"));
});

test("completion uses fixed choices for --since and --editor", () => {
  const out = generateCompletion("bash");
  assert.ok(out.includes('compgen -W "30m 1h 2h 1d"'), "--since choice words");
  assert.ok(out.includes('compgen -W "vim nano"'), "--editor choice words");
});

test("completion completes 'bash' after --completion", () => {
  const out = generateCompletion("bash");
  assert.ok(out.includes("--completion)"));
  assert.ok(out.includes('compgen -W "bash"'));
});
