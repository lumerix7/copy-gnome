import { spawnSync } from "node:child_process";

export function run(cmd, args = [], opts = {}) {
  const timeout = opts.timeout ?? 10000;
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  try {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      env,
    });
    return {
      ok: r.status === 0,
      status: r.status,
      signal: r.signal,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      error: r.error ?? null,
      cmd,
      args,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error,
      cmd,
      args,
    };
  }
}

export function commandLine(cmd, args = []) {
  return [cmd, ...args].map(shellQuote).join(" ");
}

export function shellQuote(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s))
    return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function resultText(r) {
  if (r.error)
    return r.error.message;
  const text = `${r.stderr || ""}${r.stdout || ""}`.trim();
  return text || `exit ${r.status ?? "unknown"}`;
}
