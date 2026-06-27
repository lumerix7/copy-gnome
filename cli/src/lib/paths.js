import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UUID } from "./constants.js";

const thisFile = fileURLToPath(import.meta.url);
export const cliRoot = path.resolve(path.dirname(thisFile), "../..");
export const repoRoot = path.resolve(cliRoot, "..");

export function xdgDataHome() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

export function installedExtensionDir() {
  return path.join(os.homedir(), ".local", "share", "gnome-shell", "extensions", UUID);
}

export function sourceExtensionDir(gnomeMajor = 46) {
  return path.join(repoRoot, `copy-gnome-${gnomeMajor}`);
}

export function schemaDir() {
  const installed = path.join(installedExtensionDir(), "schemas");
  if (existsDir(installed))
    return installed;
  return path.join(sourceExtensionDir(), "schemas");
}

export function resolveDataPaths() {
  const explicit = process.env.COPY_GNOME_HOME || "";
  const user = os.userInfo().username;
  const preferred = explicit || path.join("/opt", "copy-gnome", user);
  const fallback = path.join(xdgDataHome(), "copy-gnome");
  const canUsePreferred = canUseDataHome(preferred);
  const base = canUsePreferred ? preferred : fallback;
  const usedFallback = !canUsePreferred;

  return {
    explicit: explicit || null,
    preferred,
    fallback,
    base,
    usedFallback,
    config: path.join(base, "config"),
    data: usedFallback ? base : path.join(base, "data"),
  };
}

export function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function canRead(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function canWriteDir(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function canUseDataHome(base) {
  if (existsDir(base))
    return canWriteDir(base);
  const parent = path.dirname(base);
  return existsDir(parent) && canWriteDir(parent);
}
