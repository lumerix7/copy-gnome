import fs from "node:fs";
import path from "node:path";

import { GSETTINGS_SCHEMA, GSETTINGS_TOGGLE_POPUP, SUPPORTED_GNOME_MAJOR, UUID } from "./constants.js";
import { loadConfig } from "./config.js";
import { inspectLatestClip } from "./clips.js";
import { installedExtensionDir, resolveDataPaths, schemaDir, sourceExtensionDir } from "./paths.js";
import { resultText, run } from "./shell.js";

export function collectStatus() {
  const paths = resolveDataPaths();
  const extensionDir = installedExtensionDir();
  const extensionInstalled = fs.existsSync(path.join(extensionDir, "metadata.json"));
  const metadata = readMetadata(extensionDir);
  const shellVersion = run("gnome-shell", ["--version"], { timeout: 5000 });
  const gnomeMajor = parseGnomeMajor(shellVersion.stdout || shellVersion.stderr);
  const extensionInfo = run("gnome-extensions", ["info", UUID], { timeout: 8000 });
  const extensionState = parseExtensionInfo(extensionInfo.stdout);
  const settings = run("gsettings", ["get", GSETTINGS_SCHEMA, GSETTINGS_TOGGLE_POPUP], {
    timeout: 5000,
    env: { GSETTINGS_SCHEMA_DIR: schemaDir() },
  });
  const config = loadConfig(paths.config);
  const clips = inspectLatestClip(paths.data);

  return {
    node: process.version,
    session: process.env.XDG_SESSION_TYPE || null,
    desktop: process.env.XDG_CURRENT_DESKTOP || null,
    shell: {
      ok: shellVersion.ok,
      version: (shellVersion.stdout || shellVersion.stderr).trim() || null,
      major: gnomeMajor,
      supported: gnomeMajor === SUPPORTED_GNOME_MAJOR,
      error: shellVersion.ok ? null : resultText(shellVersion),
    },
    extension: {
      uuid: UUID,
      installed: extensionInstalled,
      dir: extensionDir,
      sourceDir: sourceExtensionDir(gnomeMajor || SUPPORTED_GNOME_MAJOR),
      metadata,
      infoOk: extensionInfo.ok,
      info: extensionState,
      infoError: extensionInfo.ok ? null : resultText(extensionInfo),
    },
    gsettings: {
      schema: GSETTINGS_SCHEMA,
      schemaDir: schemaDir(),
      togglePopup: settings.ok ? settings.stdout.trim() : null,
      ok: settings.ok,
      error: settings.ok ? null : resultText(settings),
    },
    paths,
    config,
    clips,
  };
}

function readMetadata(extensionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionDir, "metadata.json"), "utf8"));
  } catch {
    return null;
  }
}

function parseGnomeMajor(text) {
  const m = /GNOME Shell\s+(\d+)/i.exec(text || "");
  return m ? Number(m[1]) : null;
}

function parseExtensionInfo(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line);
    if (m)
      out[m[1].toLowerCase().replace(/\s+/g, "_")] = m[2];
  }
  return out;
}
