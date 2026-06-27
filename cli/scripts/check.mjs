import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules")
      continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p);
    } else if (p.endsWith(".js") || p.endsWith(".mjs")) {
      files.push(p);
    }
  }
}

walk(root);

for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || `node --check failed: ${file}\n`);
    process.exit(r.status || 1);
  }
}

console.log(`checked ${files.length} JavaScript files`);
