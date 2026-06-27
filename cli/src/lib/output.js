import chalk from "chalk";

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
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

export function printChecks(report) {
  console.log(`Result: ${report.ok ? chalk.green("ok") : chalk.red("fail")}`);
  for (const check of report.checks)
    console.log(`${severityLabel(check.severity).padEnd(9)} ${check.id}  ${check.message}`);
  if (!report.ok) {
    console.log("\nRecovery:");
    for (const cmd of report.recovery)
      console.log(`  ${cmd}`);
  }
}

export function printStatus(status) {
  console.log("System");
  console.log(`  Node:          ${status.node}`);
  console.log(`  GNOME Shell:   ${status.shell.version || status.shell.error || "unknown"}`);
  console.log(`  Session:       ${status.session || "unknown"}`);
  console.log("");
  console.log("Extension");
  console.log(`  UUID:          ${status.extension.uuid}`);
  console.log(`  Installed:     ${status.extension.installed ? "yes" : "no"}`);
  console.log(`  Dir:           ${status.extension.dir}`);
  console.log(`  State:         ${status.extension.info?.state || "unknown"}`);
  console.log(`  Keybinding:    ${status.gsettings.togglePopup || status.gsettings.error || "unknown"}`);
  console.log("");
  console.log("Data");
  console.log(`  Home:          ${status.paths.base}${status.paths.usedFallback ? " (fallback)" : ""}`);
  console.log(`  Config:        ${status.config.file || "defaults"}`);
  console.log(`  Data dir:      ${status.paths.data}`);
  console.log(`  Latest clips:  ${status.clips.file || "none"}`);
  console.log(`  Clips health:  ${status.clips.message}`);
}
