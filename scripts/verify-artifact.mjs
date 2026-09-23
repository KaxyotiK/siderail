#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const manifest = fs.readFileSync("herdr-plugin.toml", "utf8");
const references = [...manifest.matchAll(/"(scripts\/[^"]+)"/g)].map((match) => match[1]);
const missing = [...new Set(references)].filter((file) => !fs.existsSync(file));
const requiredReleaseFiles = [
  "scripts/run-isolated-live-smoke.sh",
  "scripts/uninstall-herdr-plugin.mjs",
  "scripts/git-state-coordinator.mjs",
  "src/shared-rail-runtime.mjs",
];
missing.push(...requiredReleaseFiles.filter((file) => !fs.existsSync(file)));
if (missing.length) throw new Error(`manifest references missing runtime files: ${missing.join(", ")}`);
if (fs.existsSync("schema") || manifest.includes(".siderail.json")) {
  throw new Error("removed schema or repository configuration leaked into the release contract");
}
for (const file of references) {
  if (!path.resolve(file).startsWith(`${process.cwd()}${path.sep}`)) throw new Error(`runtime path escapes package: ${file}`);
}
const visited = new Set();
function verifyImports(file) {
  const absolute = path.resolve(file);
  if (!absolute.startsWith(`${process.cwd()}${path.sep}`)) throw new Error(`runtime import escapes package: ${file}`);
  if (visited.has(absolute)) return;
  visited.add(absolute);
  if (!fs.statSync(absolute).isFile()) throw new Error(`runtime import is not a file: ${file}`);
  if (!absolute.endsWith(".mjs")) return;
  const source = fs.readFileSync(absolute, "utf8");
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g)) {
    verifyImports(path.resolve(path.dirname(absolute), match[1]));
  }
}
for (const file of new Set([...references, ...requiredReleaseFiles])) verifyImports(file);
console.log(`Verified ${new Set(references).size} manifest runtime files and ${visited.size} archive runtime dependencies`);
