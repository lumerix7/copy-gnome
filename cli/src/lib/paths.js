import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UUID } from "./constants.js";

const thisFile = fileURLToPath(import.meta.url);
export const cliRoot = path.resolve(path.dirname(thisFile), "../..");
export const repoRoot = path.resolve(cliRoot, "..");

export function xdgConfigHome(home = os.homedir()) {
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

export function xdgStateHome(home = os.homedir()) {
  return process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
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

export function resolveDataPaths(opts = {}) {
  const user = os.userInfo().username;
  const preferred = opts.preferredHome || path.join("/opt", "home", user);
  const fallback = opts.fallbackHome || os.homedir();
  const preferredConfig = path.join(preferred, ".config", "copy-gnome");
  const preferredData = path.join(preferred, ".local", "state", "copy-gnome");
  const canUsePreferred = canUseHome(preferred) &&
    canUseDirOrParent(preferredConfig) &&
    canUseDirOrParent(preferredData);
  const base = canUsePreferred ? preferred : fallback;
  const usedFallback = !canUsePreferred;
  const config = canUsePreferred
    ? preferredConfig
    : path.join(opts.xdgConfigHome || xdgConfigHome(fallback), "copy-gnome");
  const data = canUsePreferred
    ? preferredData
    : path.join(opts.xdgStateHome || xdgStateHome(fallback), "copy-gnome");

  return {
    preferred,
    fallback,
    base,
    usedFallback,
    config,
    data,
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

function canUseHome(base) {
  if (existsDir(base))
    return canWriteDir(base);
  const parent = path.dirname(base);
  return existsDir(parent) && canWriteDir(parent);
}

function canUseDirOrParent(dir) {
  if (existsDir(dir))
    return canWriteDir(dir);
  let cur = dir;
  while (cur && cur !== path.dirname(cur)) {
    try {
      const stat = fs.statSync(cur);
      return stat.isDirectory() && canWriteDir(cur);
    } catch (error) {
      if (error.code !== "ENOENT")
        return false;
    }
    cur = path.dirname(cur);
  }
  return false;
}
