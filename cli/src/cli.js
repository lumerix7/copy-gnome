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
import { callService, serviceExitCode } from "./lib/ipc.js";
import { collectLogs, followLogs } from "./lib/logs.js";
import { dim, error, field, formatHelp, printChecks, printEntries, printJson, printServiceStatus, printStatus, success, warn } from "./lib/output.js";
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

  const program = buildProgram();
  await program.parseAsync(argv);
}

// Build the commander program without parsing, so tests can inspect the real
// command/option surface and assert bash completion stays in sync with it.
export function buildProgram(deps = {}) {
  const serviceCaller = deps.serviceCaller ?? callService;
  const statusCollector = deps.statusCollector ?? collectStatus;
  const readStdin = deps.readStdin ?? (encoding => fs.readFileSync(0, encoding));
  const program = new Command();
  program
    .name("copy-gnome")
    .description("CLI for the copy-gnome clipboard manager")
    .version("0.1.0")
    .option("--completion <shell>", "print a shell completion script, then exit (bash)");

  program.command("status")
    .description("Show extension, config, storage, and service status")
    .option("--json", "print JSON")
    .action(opts => {
      const status = statusCollector();
      status.service = serviceCaller("Status", [], { timeoutSec: 3 });
      if (opts.json) {
        printJson(status);
      } else {
        printStatus(status);
        printServiceStatus(status.service);
      }
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

  // History commands: thin clients over the extension's DBus service (docs/14-ipc).
  // They fail with exit code 3 when the service (i.e. the extension) is not running.

  program.command("list")
    .description("List history entries (most recent first)")
    .option("--limit <n>", "show at most N entries", parsePositiveInt)
    .option("--json", "print JSON")
    .action(opts => {
      const result = serviceCaller("List", [opts.limit ?? 0]);
      finishService(result, opts, () => {
        printEntries(result.items);
        if (opts.limit && result.total > result.items.length)
          console.log(dim(`(${result.items.length} of ${result.total} entries)`));
      });
    });

  program.command("search")
    .description("Search history entries by text")
    .argument("<query>", "case-insensitive substring")
    .option("--limit <n>", "show at most N matches", parsePositiveInt)
    .option("--json", "print JSON")
    .action((query, opts) => {
      const result = serviceCaller("Search", [query, opts.limit ?? 0]);
      finishService(result, opts, () => {
        printEntries(result.items);
        if (opts.limit && result.total > result.items.length)
          console.log(dim(`(${result.items.length} of ${result.total} matches)`));
      });
    });

  program.command("get")
    .description("Print one entry's content to stdout")
    .argument("<id>", "entry id (a unique prefix of 4+ chars works)")
    .option("--raw", "write the primary payload as-is (base64 payloads are decoded)")
    .option("--json", "print the full entry as JSON")
    .action((id, opts) => {
      const result = serviceCaller("Get", [id]);
      finishService(result, opts, () => {
        const item = result.item;
        if (opts.raw) {
          const payload = item.payloads?.[0];
          if (!payload) {
            error("entry has no payload");
            process.exitCode = 1;
            return;
          }
          if (payload.encoding === "base64")
            process.stdout.write(Buffer.from(payload.value, "base64"));
          else
            process.stdout.write(payload.value ?? "");
          return;
        }
        const text = entryText(item);
        if (text == null) {
          error(`entry ${item.id} is ${item.kind}; use --raw to write its payload`);
          process.exitCode = 1;
          return;
        }
        writeText(text);
      });
    });

  program.command("use")
    .description("Restore an entry to the clipboard and move it to the front")
    .argument("<id>", "entry id (a unique prefix of 4+ chars works)")
    .option("--mode <mode>", "rich entries only: paste mode, rich or plain")
    .option("--json", "print JSON")
    .action((id, opts) => {
      const mode = opts.mode ?? "";
      if (mode && mode !== "rich" && mode !== "plain") {
        error(`invalid --mode: ${mode} (expected rich or plain)`);
        process.exitCode = 2;
        return;
      }
      const result = serviceCaller("Use", [id, mode]);
      finishService(result, opts, () => success(`restored ${result.id} (${result.kind})`));
    });

  program.command("copy")
    .description("Set the clipboard (and add a history entry) from text or stdin")
    .argument("[text...]", "text to copy; omit or pass - to read stdin")
    .option("--json", "print JSON")
    .action((texts, opts) => {
      let text;
      if (!texts.length || (texts.length === 1 && texts[0] === "-")) {
        try {
          text = readStdin("utf8");
        } catch (err) {
          error(`reading stdin failed: ${err.message}`);
          process.exitCode = 2;
          return;
        }
      } else {
        text = texts.join(" ");
      }
      if (!text) {
        error("nothing to copy");
        process.exitCode = 2;
        return;
      }
      const result = serviceCaller("CopyText", [text]);
      finishService(result, opts, () => success(`copied ${result.bytes} bytes ${dim(`(id ${result.id})`)}`));
    });

  program.command("paste")
    .description("Print the current clipboard text to stdout")
    .option("--json", "print JSON")
    .action(opts => {
      const result = serviceCaller("GetClipboardText");
      finishService(result, opts, () => {
        if (!result.hasText) {
          error("no text on the clipboard");
          process.exitCode = 1;
          return;
        }
        writeText(result.text);
      });
    });

  program.command("rm")
    .description("Remove one history entry")
    .argument("<id>", "entry id (a unique prefix of 4+ chars works)")
    .option("--json", "print JSON")
    .action((id, opts) => {
      const result = serviceCaller("Remove", [id]);
      finishService(result, opts, () => success(`removed ${result.id}`));
    });

  program.command("clear")
    .description("Clear the whole history")
    .option("-y, --yes", "confirm; without it, clear refuses to run")
    .option("--json", "print JSON")
    .action(opts => {
      if (!opts.yes) {
        error("refusing to clear history without --yes");
        process.exitCode = 2;
        return;
      }
      const result = serviceCaller("Clear");
      finishService(result, opts, () => success(`cleared ${result.cleared} entries`));
    });

  program.command("popup")
    .description("Toggle the history popup (same as the keybinding)")
    .option("--json", "print JSON")
    .action(opts => {
      const result = serviceCaller("Popup");
      finishService(result, opts, () => success("popup toggled"));
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
  return program;
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

// Shared tail for service-backed commands: --json prints the raw envelope; otherwise
// failures map to docs/12-cli exit codes and successes run the human formatter.
function finishService(result, opts, onOk) {
  if (opts?.json) {
    printJson(result);
    process.exitCode = serviceExitCode(result);
    return;
  }
  if (!result.ok) {
    error(result.error || `service call failed (${result.code || "unknown"})`);
    process.exitCode = serviceExitCode(result);
    return;
  }
  onOk();
}

// Text to print for `get` without --raw: prefer the plain-text payload, then any other
// text-like payload (rich primary, file uri-list); binary-only entries return null.
function entryText(item) {
  const payloads = item.payloads || [];
  const plain = payloads.find(p => typeof p.mime === "string" && p.mime.startsWith("text/plain"));
  if (plain)
    return plain.value ?? "";
  const textLike = payloads.find(p => p.encoding === "utf8" || p.encoding === "uri-list");
  return textLike ? textLike.value ?? "" : null;
}

// Exact bytes for pipes; only a TTY gets a cosmetic trailing newline.
function writeText(text) {
  process.stdout.write(text);
  if (process.stdout.isTTY && text && !text.endsWith("\n"))
    process.stdout.write("\n");
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
    const status = collectStatus();
    if (status.extension.installed && !status.extension.infoOk)
      warn(`installed files exist at ${status.extension.dir}, but GNOME Shell does not list ${UUID}; log out and back in on Wayland, then retry`);
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
