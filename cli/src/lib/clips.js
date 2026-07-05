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
  if (!obj || obj.type !== "history" || !Number.isFinite(obj.writtenAt) ||
      !Array.isArray(obj.items))
    return { ok: false, message: "latest snapshot has invalid envelope" };
  for (const item of obj.items) {
    if (!item || typeof item.id !== "string" || typeof item.kind !== "string")
      return { ok: false, message: "latest snapshot has invalid item" };
    if (typeof item.mime !== "string" || !Array.isArray(item.payloads) || item.payloads.length === 0)
      return { ok: false, message: "latest snapshot has invalid item" };
    if (!Number.isInteger(item.contentBytes) || item.contentBytes < 0 ||
        typeof item.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.contentSha256))
      return { ok: false, message: "latest snapshot has invalid content identity" };
    for (const payload of item.payloads) {
      if (!payload || typeof payload.mime !== "string" || typeof payload.encoding !== "string" ||
          typeof payload.value !== "string" || typeof payload.bytes !== "number")
        return { ok: false, message: "latest snapshot has invalid payload" };
    }
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
    // Exclude the normal JSONL terminator before scanning chunks. If it remains in a later
    // combined buffer, a multi-chunk line mistakes that terminator for the preceding line
    // boundary and returns an empty string.
    let logicalEnd = size;
    const finalByte = Buffer.allocUnsafe(1);
    fs.readSync(fd, finalByte, 0, 1, size - 1);
    if (finalByte[0] === 0x0a)
      logicalEnd--;

    let pos = logicalEnd;
    const buffers = [];
    let buffered = 0;

    while (pos > 0) {
      const want = Math.min(chunkSize, pos);
      pos -= want;
      const chunk = Buffer.allocUnsafe(want);
      fs.readSync(fd, chunk, 0, want, pos);

      const nl = chunk.lastIndexOf(0x0a);
      if (nl >= 0) {
        const suffix = chunk.subarray(nl + 1);
        buffers.unshift(suffix);
        buffered += suffix.length;
        const start = pos + nl + 1;
        if (buffered > MAX_SNAPSHOT_LINE_BYTES)
          return { line: "", size, start, end: logicalEnd, oversized: true };
        const line = Buffer.concat(buffers, buffered).toString("utf8");
        return {
          line,
          size,
          start,
          end: logicalEnd,
          oversized: false,
        };
      }

      buffers.unshift(chunk);
      buffered += want;
      if (buffered > MAX_SNAPSHOT_LINE_BYTES)
        return { line: "", size, start: null, end: logicalEnd, oversized: true };
    }

    const line = Buffer.concat(buffers, buffered).toString("utf8");
    return {
      line,
      size,
      start: 0,
      end: logicalEnd,
      oversized: false,
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
