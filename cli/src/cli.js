import { Command } from "commander";
import fs from "node:fs";

import { UUID } from "./lib/constants.js";
import { generateCompletion } from "./lib/completion.js";
import {
  configPathInfo,
  editConfig,
  formatScalar,
  formatYaml,
  getConfigValue,
  setConfigValue,
  showConfig,
  validateConfig,
} from "./lib/config-command.js";
import { repairLatestClip } from "./lib/clips.js";
import { collectLogs, followLogs } from "./lib/logs.js";
import { dim, error, field, formatHelp, printChecks, printJson, printStatus, success, warn } from "./lib/output.js";
import { resolveDataPaths } from "./lib/paths.js";
import { commandLine, resultText, run } from "./lib/shell.js";
import { runDoctor } from "./lib/doctor.js";
import { collectStatus } from "./lib/status.js";

export async function main(argv) {
  const completion = completionShellFromArgv(argv);
  if (completion) {
    try {
      process.stdout.write(generateCompletion(completion));
    } catch (err) {
      error(err.message);
      process.exitCode = 2;
    }
    return;
  }

  const program = new Command();
  program
    .name("copy-gnome")
    .description("CLI for the copy-gnome clipboard manager")
    .version("0.1.0")
    .option("--completion <shell>", "print a shell completion script, then exit (bash)");

  program.command("status")
    .description("Show extension, config, and storage status")
    .option("--json", "print JSON")
    .action(opts => {
      const status = collectStatus();
      if (opts.json)
        printJson(status);
      else
        printStatus(status);
    });

  program.command("doctor")
    .description("Run offline diagnostics; useful even when the extension is broken")
    .option("--json", "print JSON")
    .option("--since <duration>", "journal lookback, e.g. 30m, 2h, 1d", "30m")
    .option("--require-active", "fail if the extension is not ACTIVE")
    .action(opts => {
      const report = runDoctor(opts);
      if (opts.json)
        printJson(report);
      else
        printChecks(report);
      process.exitCode = report.ok ? 0 : 1;
    });

  program.command("logs")
    .description("Print recent copy-gnome / gnome-shell diagnostic log lines")
    .option("--since <duration>", "journal lookback, e.g. 30m, 2h, 1d", "30m")
    .option("-n, --tail <lines>", "limit to the last N journal lines before filtering", parsePositiveInt)
    .option("-f, --follow", "follow matching journal lines")
    .option("--json", "print JSON")
    .action(async opts => {
      if (opts.json && opts.follow) {
        error("logs --json cannot be combined with --follow");
        process.exitCode = 2;
        return;
      }
      if (opts.follow) {
        const result = await followLogs(opts);
        if (!result.ok) {
          error(result.error || `journalctl exited with ${result.code ?? result.signal}`);
          process.exitCode = 1;
        }
        return;
      }
      const logs = collectLogs(opts);
      if (opts.json) {
        printJson(logs);
      } else if (!logs.ok) {
        error(logs.error);
        process.exitCode = 1;
      } else {
        for (const line of logs.lines)
          console.log(line);
      }
    });

  program.command("enable")
    .description("Enable the Shell extension with gnome-extensions")
    .action(() => runExtensionCommand("enable"));

  program.command("disable")
    .description("Disable the Shell extension with gnome-extensions")
    .option("--hard", "also rename the installed extension directory as a last-resort escape hatch")
    .option("-y, --yes", "do not prompt for --hard")
    .action(opts => {
      runExtensionCommand("disable");
      if (opts.hard)
        hardDisable(opts);
    });

  program.command("restart")
    .description("Disable then enable the extension")
    .action(() => {
      runExtensionCommand("disable", { allowFailure: true });
      runExtensionCommand("enable");
    });

  program.command("extension-status")
    .description("Raw gnome-extensions info output")
    .action(() => {
      const r = run("gnome-extensions", ["info", UUID], { timeout: 8000 });
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      process.exitCode = r.ok ? 0 : 1;
    });

  program.command("paths")
    .description("Print resolved copy-gnome paths")
    .option("--json", "print JSON")
    .action(opts => {
      const paths = resolveDataPaths();
      if (opts.json) {
        printJson(paths);
      } else {
        field("home", `${paths.base}${paths.usedFallback ? dim(" (fallback)") : ""}`, { pad: 7, indent: 0 });
        field("config", paths.config, { pad: 7, indent: 0, color: dim });
        field("data", paths.data, { pad: 7, indent: 0, color: dim });
      }
    });

  const config = program.command("config")
    .description("Inspect copy-gnome config");

  config.command("path")
    .description("Print the active config path")
    .option("--json", "print JSON")
    .action(opts => {
      const info = configPathInfo();
      if (opts.json) {
        printJson(info);
      } else {
        console.log(info.activeFile || info.preferredYaml);
      }
    });

  config.command("validate")
    .description("Validate config syntax and known keys")
    .option("--json", "print JSON")
    .action(opts => {
      const result = validateConfig();
      if (opts.json) {
        printJson(result);
      } else {
        if (result.ok)
          success(`config is valid ${dim(`(${result.file || "defaults"})`)}`);
        else
          error(`config is invalid ${dim(`(${result.file || "defaults"})`)}`);
        for (const warning of result.warnings)
          warn(warning);
        for (const message of result.errors)
          error(message);
      }
      process.exitCode = result.ok ? 0 : 1;
    });

  config.command("show")
    .description("Show the sanitized effective config")
    .option("--json", "print JSON")
    .option("--meta", "include file, warnings, and errors")
    .action(opts => {
      const value = showConfig({ withMeta: opts.meta });
      if (opts.json)
        printJson(value);
      else
        console.log(formatYaml(value));
    });

  config.command("get")
    .description("Get one sanitized config value")
    .argument("<key>", "config key, e.g. general.captureImages")
    .option("--json", "print JSON")
    .action((key, opts) => {
      const result = getConfigValue(key);
      if (opts.json) {
        printJson(result);
      } else if (result.ok) {
        console.log(formatScalar(result.value));
      } else {
        error(result.error);
      }
      process.exitCode = result.ok ? 0 : 2;
    });

  config.command("set")
    .description("Set one config value in config.yaml")
    .argument("<key>", "config key, e.g. general.captureImages")
    .argument("<value...>", "value; arrays/objects use YAML or JSON flow syntax")
    .option("--json", "print JSON")
    .action((key, values, opts) => {
      const result = setConfigValue(key, values.join(" "));
      if (opts.json) {
        printJson(result);
      } else if (result.ok) {
        success(`${result.key} = ${formatScalar(result.value)}`);
        console.log(dim(`  ${result.path}`));
        for (const warning of result.warnings)
          warn(warning);
      } else {
        error(result.error);
      }
      process.exitCode = result.ok ? 0 : 2;
    });

  config.command("edit")
    .description("Edit config.yaml with --editor, $VISUAL, $EDITOR, or editor")
    .option("--editor <command>", "editor command to run instead of $VISUAL/$EDITOR/editor")
    .option("--json", "print JSON")
    .action(opts => {
      const result = editConfig(opts);
      if (opts.json) {
        printJson(result);
      } else if (result.ok) {
        success("config saved");
        console.log(dim(`  ${result.path}`));
        for (const warning of result.warnings)
          warn(warning);
      } else {
        error(result.error);
      }
      process.exitCode = result.ok ? 0 : 2;
    });

  program.command("repair")
    .description("Repair the latest clips JSONL by backing it up and truncating a bad tail line")
    .option("--file <path>", "repair this clips file instead of the latest data file")
    .option("--yes", "write changes; without this, repair is dry-run")
    .option("--json", "print JSON")
    .action(opts => {
      const paths = resolveDataPaths();
      const result = repairLatestClip(paths.data, { file: opts.file, yes: opts.yes });
      if (opts.json)
        printJson(result);
      else
        console.log(result.message);
      process.exitCode = result.ok ? 0 : 1;
    });

  applyHelpFormat(program);
  await program.parseAsync(argv);
}

function applyHelpFormat(cmd) {
  cmd.configureHelp({ formatHelp });
  for (const sub of cmd.commands)
    applyHelpFormat(sub);
}

function completionShellFromArgv(argv) {
  const idx = argv.indexOf("--completion");
  if (idx < 0)
    return null;
  return argv[idx + 1] || "";
}

function parsePositiveInt(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1)
    throw new Error(`invalid positive integer: ${value}`);
  return n;
}

function runExtensionCommand(action, opts = {}) {
  const args = [action, UUID];
  const r = run("gnome-extensions", args, { timeout: 10000 });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (!r.ok && !opts.allowFailure) {
    error(`${commandLine("gnome-extensions", args)} failed: ${resultText(r)}`);
    process.exitCode = 1;
  }
}

function hardDisable(opts) {
  const status = collectStatus();
  const src = status.extension.dir;
  const dest = `${src}.disabled`;
  if (!opts.yes) {
    error(`Refusing hard disable without --yes. Would rename:\n  ${src}\n  -> ${dest}`);
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(src)) {
    error(`installed extension dir not found: ${src}`);
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(dest)) {
    error(`target already exists: ${dest}`);
    process.exitCode = 1;
    return;
  }
  fs.renameSync(src, dest);
  success(`renamed ${src} -> ${dest}`);
}
