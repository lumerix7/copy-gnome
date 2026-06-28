import chalk from "chalk";

// All color is applied through chalk, which auto-disables when stdout is not a
// TTY or when NO_COLOR is set, so machine-readable output stays plain.

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

// Docker-style help: description, a multi-line Usage block, then aligned
// Commands / Arguments / Options sections. Wired via cmd.configureHelp().
export function formatHelp(cmd, helper) {
  const indent = "  ";
  const out = [];

  const description = helper.commandDescription(cmd);
  if (description)
    out.push(description, "");

  out.push(chalk.bold("Usage:"));
  for (const line of usageLines(cmd, helper))
    out.push(indent + line);
  out.push("");

  const argRows = (cmd.registeredArguments || [])
    .filter(arg => arg.description)
    .map(arg => [argTerm(arg), arg.description]);
  const subcommands = helper.visibleCommands(cmd).filter(c => c.name() !== "help");
  const options = helper.visibleOptions(cmd);

  const width = Math.min(30, Math.max(0,
    ...argRows.map(r => r[0].length),
    ...subcommands.map(c => c.name().length),
    ...options.map(o => helper.optionTerm(o).length)));

  if (argRows.length) {
    out.push(chalk.bold("Arguments:"));
    for (const [term, text] of argRows)
      out.push(`${indent}${chalk.cyan(term.padEnd(width))}  ${text}`);
    out.push("");
  }

  if (subcommands.length) {
    out.push(chalk.bold("Commands:"));
    for (const sub of subcommands)
      out.push(`${indent}${chalk.cyan(sub.name().padEnd(width))}  ${helper.subcommandDescription(sub)}`);
    out.push("");
  }

  if (options.length) {
    out.push(chalk.bold("Options:"));
    for (const option of options)
      out.push(`${indent}${chalk.green(helper.optionTerm(option).padEnd(width))}  ${helper.optionDescription(option)}`);
    out.push("");
  }

  if (subcommands.length)
    out.push(chalk.dim(`Run '${fullName(cmd)} <command> --help' for more information on a command.`));

  return `${out.join("\n").trimEnd()}\n`;
}

function usageLines(cmd, helper) {
  const name = fullName(cmd);
  const hasSubcommands = helper.visibleCommands(cmd).some(c => c.name() !== "help");
  if (hasSubcommands)
    return [`${name} <command> [options]`, `${name} <command> -h | --help`];

  const args = (cmd.registeredArguments || []).map(argTerm).join(" ");
  let line = name;
  if (helper.visibleOptions(cmd).length)
    line += " [options]";
  if (args)
    line += ` ${args}`;
  return [line];
}

function argTerm(arg) {
  const base = arg.variadic ? `${arg.name()}...` : arg.name();
  return arg.required ? `<${base}>` : `[${base}]`;
}

function fullName(cmd) {
  const parts = [];
  for (let c = cmd; c; c = c.parent)
    parts.unshift(c.name());
  return parts.join(" ");
}

// Diagnostics go to stderr with a Docker-style "Error:" / "Warning:" prefix.
export function error(message) {
  console.error(`${chalk.red.bold("Error:")} ${message}`);
}

export function warn(message) {
  console.error(`${chalk.yellow.bold("Warning:")} ${message}`);
}

export function success(message) {
  console.log(`${chalk.green("✔")} ${message}`);
}

export function dim(text) {
  return chalk.dim(text);
}

export function heading(text) {
  console.log(chalk.bold(text));
}

// Aligned "  Label:        value" row, Docker `info`-style.
export function field(label, value, opts = {}) {
  const { pad = 13, indent = 2, color } = opts;
  const key = `${label}:`.padEnd(pad);
  const shown = typeof color === "function" ? color(value) : value;
  console.log(`${" ".repeat(indent)}${chalk.dim(key)} ${shown}`);
}

export function yesNo(value) {
  return value ? chalk.green("yes") : chalk.red("no");
}

export function severityLabel(severity) {
  if (severity === "ok")
    return chalk.green("ok");
  if (severity === "info")
    return chalk.blue("info");
  if (severity === "warn")
    return chalk.yellow("warn");
  if (severity === "fail")
    return chalk.red("fail");
  return severity;
}

function stateColor(state) {
  const text = state || "unknown";
  const upper = String(text).toUpperCase();
  if (upper === "ACTIVE" || upper === "ENABLED")
    return chalk.green(text);
  if (upper === "ERROR")
    return chalk.red(text);
  if (upper === "UNKNOWN")
    return chalk.dim(text);
  return chalk.yellow(text);
}

function padSeverity(severity) {
  const colors = { ok: chalk.green, info: chalk.blue, warn: chalk.yellow, fail: chalk.red };
  const paint = colors[severity] || (s => s);
  return paint(severity.toUpperCase().padEnd(4));
}

export function printChecks(report) {
  heading("Diagnostics");
  const idWidth = Math.max(0, ...report.checks.map(c => c.id.length));
  for (const check of report.checks)
    console.log(`  ${padSeverity(check.severity)}  ${chalk.dim(check.id.padEnd(idWidth))}  ${check.message}`);

  console.log("");
  const mark = report.ok ? chalk.green("✔") : chalk.red("✖");
  const verdict = report.ok ? chalk.green.bold("healthy") : chalk.red.bold("unhealthy");
  console.log(`${mark} ${verdict}  ${chalk.dim(summarize(report.checks))}`);

  if (!report.ok) {
    console.log("");
    console.log(chalk.bold("Recovery"));
    for (const cmd of report.recovery)
      console.log(`  ${chalk.cyan(cmd)}`);
  }
}

function summarize(checks) {
  const counts = { ok: 0, info: 0, warn: 0, fail: 0 };
  for (const check of checks)
    if (counts[check.severity] !== undefined)
      counts[check.severity]++;
  const parts = [`${counts.ok} ok`];
  if (counts.info)
    parts.push(`${counts.info} info`);
  if (counts.warn)
    parts.push(`${counts.warn} ${counts.warn === 1 ? "warning" : "warnings"}`);
  if (counts.fail)
    parts.push(`${counts.fail} failed`);
  return parts.join(", ");
}

export function printStatus(status) {
  heading("System");
  field("Node", status.node);
  field("GNOME Shell", status.shell.version || status.shell.error || "unknown");
  field("Session", status.session || "unknown");
  console.log("");

  heading("Extension");
  field("UUID", status.extension.uuid, { color: dim });
  field("Installed", status.extension.installed, { color: yesNo });
  field("Dir", status.extension.dir, { color: dim });
  field("State", status.extension.info?.state || "unknown", { color: stateColor });
  if (status.extension.installed && !status.extension.infoOk)
    field("Discovery", status.session === "wayland"
      ? "not listed by current Shell; log out/in, then enable"
      : "not listed by current Shell", { color: chalk.yellow });
  field("Keybinding", status.gsettings.togglePopup || status.gsettings.error || "unknown");
  console.log("");

  heading("Data");
  const fallback = status.paths.usedFallback ? chalk.dim(" (fallback)") : "";
  field("Home", `${status.paths.base}${fallback}`);
  field("Config", status.config.file || "defaults", { color: status.config.file ? undefined : dim });
  field("Data dir", status.paths.data, { color: dim });
  field("Latest clips", status.clips.file || "none", { color: status.clips.file ? undefined : dim });
  field("Clips health", status.clips.message);
}
