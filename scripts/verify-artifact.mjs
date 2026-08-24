#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const manifest = fs.readFileSync("herdr-plugin.toml", "utf8");
const references = [...manifest.matchAll(/"(scripts\/[^"]+)"/g)].map((match) => match[1]);
const missing = [...new Set(references)].filter((file) => !fs.existsSync(file));
const requiredReleaseFiles = ["scripts/uninstall-herdr-plugin.mjs"];
missing.push(...requiredReleaseFiles.filter((file) => !fs.existsSync(file)));
if (missing.length) throw new Error(`manifest references missing runtime files: ${missing.join(", ")}`);
if (fs.existsSync("schema") || manifest.includes(".git-rail.json")) {
  throw new Error("removed schema or repository configuration leaked into the release contract");
}
for (const file of references) {
  if (!path.resolve(file).startsWith(`${process.cwd()}${path.sep}`)) throw new Error(`runtime path escapes package: ${file}`);
}
console.log(`Verified ${new Set(references).size} manifest runtime files`);
