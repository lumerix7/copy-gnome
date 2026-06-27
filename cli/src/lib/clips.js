import fs from "node:fs";
import path from "node:path";

import { MAX_SNAPSHOT_LINE_BYTES } from "./constants.js";

export function listClipFiles(dataDir) {
  try {
    return fs.readdirSync(dataDir)
      .filter(name => /^clips-\d{8}\.jsonl$/.test(name))
      .sort()
      .map(name => path.join(dataDir, name));
  } catch {
    return [];
  }
}

export function latestClipFile(dataDir) {
  const files = listClipFiles(dataDir);
  return files.length ? files[files.length - 1] : null;
}

export function inspectLatestClip(dataDir) {
  const file = latestClipFile(dataDir);
  if (!file)
    return { file: null, ok: true, exists: false, message: "no clips file found" };
  return inspectClipFile(file);
}

export function inspectClipFile(file) {
  try {
    const last = readLastLine(file);
    if (!last.line)
      return { file, ok: true, exists: true, bytes: last.size, count: 0, message: "empty clips file" };
    if (last.oversized)
      return { file, ok: false, exists: true, bytes: last.size, message: "latest snapshot line exceeds 64 MiB" };
    const parsed = JSON.parse(last.line);
    const valid = validateSnapshot(parsed);
    if (!valid.ok)
      return { file, ok: false, exists: true, bytes: last.size, message: valid.message };
    return {
      file,
      ok: true,
      exists: true,
      bytes: last.size,
      lineBytes: Buffer.byteLength(last.line),
      count: parsed.items.length,
      writtenAt: parsed.writtenAt ?? null,
      message: `latest snapshot ok (${parsed.items.length} items)`,
    };
  } catch (error) {
    return { file, ok: false, exists: true, message: `latest snapshot parse failed: ${error.message}` };
  }
}

export function repairLatestClip(dataDir, opts = {}) {
  const file = opts.file || latestClipFile(dataDir);
  if (!file)
    return { ok: true, changed: false, message: "no clips file found" };

  const before = inspectClipFile(file);
  if (before.ok)
    return { ok: true, changed: false, file, message: "latest snapshot is valid; no repair needed" };

  const last = readLastLine(file);
  if (last.start == null)
    return { ok: false, changed: false, file, message: "cannot locate start of bad latest line safely" };

  const backup = `${file}.bak-${timestamp()}`;
  const truncateTo = last.start;
  if (!opts.yes) {
    return {
      ok: false,
      changed: false,
      file,
      backup,
      truncateTo,
      message: `would backup then truncate bad latest line (${before.message})`,
    };
  }

  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.truncateSync(file, truncateTo);
  const after = inspectClipFile(file);
  return {
    ok: after.ok,
    changed: true,
    file,
    backup,
    truncateTo,
    message: after.ok ? `repaired latest bad line; backup: ${backup}` : `truncated, but file is still unhealthy: ${after.message}`,
  };
}

function validateSnapshot(obj) {
  if (!obj || obj.type !== "history" || obj.version !== 1 || !Array.isArray(obj.items))
    return { ok: false, message: "latest snapshot has invalid envelope" };
  for (const item of obj.items) {
    if (!item || typeof item.id !== "string" || typeof item.kind !== "string")
      return { ok: false, message: "latest snapshot has invalid item" };
  }
  return { ok: true };
}

function readLastLine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0)
      return { line: "", size, start: 0, end: 0, oversized: false };

    const chunkSize = 1024 * 1024;
    let pos = size;
    let buffers = [];
    let buffered = 0;
    let dropTrailingNewline = true;

    while (pos > 0) {
      const want = Math.min(chunkSize, pos);
      pos -= want;
      const chunk = Buffer.allocUnsafe(want);
      fs.readSync(fd, chunk, 0, want, pos);
      buffers.unshift(chunk);
      buffered += want;

      const combined = Buffer.concat(buffers, buffered);
      let end = combined.length;
      if (dropTrailingNewline && combined[end - 1] === 0x0a)
        end--;
      dropTrailingNewline = false;

      const nl = combined.lastIndexOf(0x0a, end - 1);
      if (nl >= 0) {
        const start = pos + nl + 1;
        const line = combined.subarray(nl + 1, end).toString("utf8");
        return {
          line,
          size,
          start,
          end: pos + end,
          oversized: Buffer.byteLength(line) > MAX_SNAPSHOT_LINE_BYTES,
        };
      }

      if (end > MAX_SNAPSHOT_LINE_BYTES + 1) {
        return { line: "", size, start: null, end: size, oversized: true };
      }
    }

    const combined = Buffer.concat(buffers, buffered);
    let end = combined.length;
    if (combined[end - 1] === 0x0a)
      end--;
    const line = combined.subarray(0, end).toString("utf8");
    return {
      line,
      size,
      start: 0,
      end,
      oversized: Buffer.byteLength(line) > MAX_SNAPSHOT_LINE_BYTES,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
