import { spawn } from "node:child_process";
import readline from "node:readline";

import { journalSince } from "./duration.js";
import { run } from "./shell.js";

const EXTENSION_PATTERNS = [
  /\[copy-gnome\]/i,
  /copy-gnome@clipboard/i,
  /org\.gnome\.shell\.extensions\.copy-gnome/i,
  /org\.gnome\.Shell\.Extensions.*copy-gnome/i,
];

const SHELL_PATTERNS = [
  /JS ERROR/i,
  /signal 11/i,
  /segfault/i,
  /clipboard read failed/i,
  /popup show failed/i,
  /modal release failed/i,
  /Xwayland/i,
];

export function collectLogs(opts = {}) {
  const since = journalSince(opts.since || "30m");
  const args = ["--user", "-b", "0", "--since", since, "--no-pager"];
  if (opts.tail)
    args.push("-n", String(opts.tail));

  const r = run("journalctl", args, {
    timeout: opts.timeout ?? 15000,
    maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
  });
  if (!r.ok)
    return { ok: false, since, lines: [], error: r.stderr || r.stdout || r.error?.message || "journalctl failed" };

  let lines = r.stdout.split(/\r?\n/).filter(line => matchesLogLine(line, opts.patterns));
  if (opts.tail)
    lines = lines.slice(-opts.tail);
  return { ok: true, since, lines, error: null };
}

export async function followLogs(opts = {}) {
  const since = journalSince(opts.since || "30m");
  const args = ["--user", "-b", "0", "--since", since, "--no-pager"];
  if (opts.tail)
    args.push("-n", String(opts.tail));
  args.push("-f");

  const child = spawn("journalctl", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", chunk => process.stderr.write(chunk));

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", line => {
    if (matchesLogLine(line, opts.patterns))
      console.log(line);
  });

  const stop = () => {
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  return await new Promise(resolve => {
    child.on("error", error => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve({ ok: false, since, error: error.message });
    });
    child.on("close", (code, signal) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve({ ok: code === 0 || signal === "SIGTERM", since, code, signal });
    });
  });
}

function matchesLogLine(line, extraPatterns = null) {
  if (!line)
    return false;
  if (extraPatterns?.some(p => p.test(line)))
    return true;
  if (EXTENSION_PATTERNS.some(p => p.test(line)))
    return true;
  if (/gnome-shell/i.test(line) && SHELL_PATTERNS.some(p => p.test(line)))
    return true;
  return false;
}
