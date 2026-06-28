import { run } from "./shell.js";

// Thin client for the extension's DBus control service (docs/14-ipc). Calls go through
// `busctl --user --json=short`, keeping the no-GJS design boundary: this file only needs
// Node plus a stable external command. Every method returns one JSON envelope string;
// this client parses it and normalizes transport failures into the same envelope shape.

export const SERVICE_BUS_NAME = "org.gnome.Shell.Extensions.CopyGnome";
export const SERVICE_OBJECT_PATH = "/org/gnome/Shell/Extensions/CopyGnome";
export const SERVICE_INTERFACE = SERVICE_BUS_NAME;

const METHOD_SIGNATURES = {
  List: "u",
  Get: "s",
  Use: "ss",
  CopyText: "s",
  GetClipboardText: "",
  Search: "su",
  Remove: "s",
  Clear: "",
  Popup: "",
  Status: "",
};

export function callService(method, args = [], opts = {}) {
  const signature = METHOD_SIGNATURES[method];
  if (signature === undefined)
    return failure("bad-args", `unknown service method: ${method}`);
  const runner = opts.runner ?? run;
  const timeoutSec = opts.timeoutSec ?? 10;
  const argv = [
    "--user",
    "--json=short",
    `--timeout=${timeoutSec}`,
    "call",
    SERVICE_BUS_NAME,
    SERVICE_OBJECT_PATH,
    SERVICE_INTERFACE,
    method,
  ];
  if (signature)
    argv.push(signature, ...args.map(String));
  const r = runner("busctl", argv, { timeout: timeoutSec * 1000 + 2000 });
  if (!r.ok)
    return classifyCallFailure(r);

  let reply;
  try {
    reply = JSON.parse(r.stdout);
  } catch {
    return failure("bad-reply", `unparseable busctl reply: ${truncate(r.stdout)}`);
  }
  const payload = reply?.data?.[0];
  if (typeof payload !== "string")
    return failure("bad-reply", `unexpected busctl reply shape: ${truncate(r.stdout)}`);
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    return failure("bad-reply", `service returned invalid JSON: ${truncate(payload)}`);
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    return failure("bad-reply", "service returned a non-object envelope");
  return envelope;
}

// docs/12-cli exit codes: 0 ok, 1 failed, 2 bad args, 3 service unavailable, 4 not found.
export function serviceExitCode(envelope) {
  if (envelope?.ok)
    return 0;
  switch (envelope?.code) {
    case "not-found":
      return 4;
    case "service-unavailable":
    case "no-busctl":
    case "timeout":
    case "not-ready":
      return 3;
    case "bad-args":
    case "ambiguous":
      return 2;
    default:
      return 1;
  }
}

function classifyCallFailure(r) {
  if (r.error?.code === "ENOENT")
    return failure("no-busctl", "busctl not found; install systemd tools");
  if (r.error?.code === "ETIMEDOUT")
    return failure("timeout", "service call timed out");
  const stderr = String(r.stderr || "");
  if (/ServiceUnknown|NameHasNoOwner|name .* was not provided|Failed to connect/i.test(stderr))
    return failure("service-unavailable",
      "copy-gnome service not available - is the extension enabled and running?");
  if (/timed out|timeout/i.test(stderr))
    return failure("timeout", "service call timed out");
  const detail = stderr.trim() || r.error?.message || `busctl exited with ${r.status ?? r.signal}`;
  return failure("call-failed", `service call failed: ${truncate(detail)}`);
}

function failure(code, message) {
  return { ok: false, code, error: message };
}

function truncate(text, max = 200) {
  const s = String(text ?? "").trim();
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}
