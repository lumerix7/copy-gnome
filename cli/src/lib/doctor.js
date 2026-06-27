import fs from "node:fs";
import path from "node:path";

import { RECOVERY_COMMANDS, SUPPORTED_GNOME_MAJORS } from "./constants.js";
import { collectLogs } from "./logs.js";
import { canWriteDir } from "./paths.js";
import { collectStatus } from "./status.js";

export function runDoctor(opts = {}) {
  const status = collectStatus();
  const checks = [];

  add(checks, "system.node", "ok", `Node ${status.node}`);
  add(checks, "system.session", status.session === "wayland" ? "ok" : "warn",
    `Session: ${status.session || "unknown"}`);

  if (!status.shell.ok) {
    add(checks, "system.gnome-shell", "warn", `gnome-shell --version failed: ${status.shell.error}`);
  } else if (!status.shell.supported) {
    add(checks, "system.gnome-shell", "warn",
      `${status.shell.version}; current extension build is tested for GNOME ${SUPPORTED_GNOME_MAJORS.join(", ")}`);
  } else {
    add(checks, "system.gnome-shell", "ok", status.shell.version);
  }

  add(checks, "extension.installed", status.extension.installed ? "ok" : "fail",
    status.extension.installed ? `Installed at ${status.extension.dir}` : `Missing install dir: ${status.extension.dir}`);
  add(checks, "extension.info", status.extension.infoOk ? "ok" : "warn",
    status.extension.infoOk ? extensionSummary(status) : `gnome-extensions info failed: ${status.extension.infoError}`);

  const state = String(status.extension.info?.state || "").trim().toUpperCase();
  const active = state === "ACTIVE";
  const enabled = /enabled/i.test(status.extension.info?.state || "") ||
    /^(true|yes|1)$/i.test(status.extension.info?.enabled || "");
  if (opts.requireActive && !active)
    add(checks, "extension.active", "fail", `Extension is not ACTIVE (state: ${status.extension.info?.state || "unknown"})`);
  else
    add(checks, "extension.active", active ? "ok" : "warn",
      `State: ${status.extension.info?.state || "unknown"}${enabled ? "" : " (may be disabled)"}`);

  add(checks, "gsettings.toggle-popup", status.gsettings.ok ? "ok" : "warn",
    status.gsettings.ok ? `toggle-popup: ${status.gsettings.togglePopup}` : status.gsettings.error);

  add(checks, "paths.data-home", status.paths.usedFallback ? "warn" : "ok",
    status.paths.usedFallback
      ? `Using fallback data home: ${status.paths.base}; preferred ${status.paths.preferred} is not writable`
      : `Data home: ${status.paths.base}`);

  if (fs.existsSync(status.paths.data))
    add(checks, "paths.data-dir", canWriteDir(status.paths.data) ? "ok" : "fail", `Data dir: ${status.paths.data}`);
  else
    add(checks, "paths.data-dir", "warn", `Data dir does not exist yet: ${status.paths.data}`);

  if (status.config.errors.length > 0) {
    for (const error of status.config.errors)
      add(checks, "config.parse", "fail", error);
  } else {
    add(checks, "config.parse", "ok", status.config.file ? `Config: ${status.config.file}` : "No config file; defaults apply");
  }
  for (const warning of status.config.warnings)
    add(checks, "config.warning", "warn", warning);
  if (status.config.config.general.captureImages)
    add(checks, "config.capture-images", "warn", "general.captureImages is enabled; image clipboard paths are higher risk");
  if (status.config.config.logging.level === "debug")
    add(checks, "config.log-level", "warn", "logging.level is debug; logs may be noisy");

  add(checks, "clips.latest", status.clips.ok ? "ok" : "fail",
    status.clips.file ? `${status.clips.message}: ${status.clips.file}` : status.clips.message);

  const logs = collectLogs({ since: opts.since || "30m" });
  if (!logs.ok) {
    add(checks, "logs.read", "warn", logs.error);
  } else {
    const copyWarnings = logs.lines.filter(line => /copy-gnome/i.test(line) && /\b(WARN|ERROR|JS ERROR|signal 11)\b/i.test(line));
    const shellCrash = logs.lines.filter(line => /gnome-shell/i.test(line) && /signal 11|segfault|JS ERROR/i.test(line));
    add(checks, "logs.copy-gnome", copyWarnings.length ? "warn" : "ok",
      `${copyWarnings.length} recent copy-gnome warning/error lines since ${logs.since}`);
    add(checks, "logs.gnome-shell", shellCrash.length ? "warn" : "ok",
      `${shellCrash.length} recent shell crash/error lines since ${logs.since}`);
  }

  const ok = !checks.some(c => c.severity === "fail");
  return {
    ok,
    summary: ok ? "ok" : "fail",
    checks,
    recovery: RECOVERY_COMMANDS,
    status,
  };
}

function add(checks, id, severity, message, details = undefined) {
  checks.push({ id, severity, message, ...(details ? { details } : {}) });
}

function extensionSummary(status) {
  const state = status.extension.info?.state || "unknown";
  const version = status.extension.metadata?.["version-name"] || status.extension.metadata?.version || "?";
  return `State: ${state}; version: ${version}`;
}
