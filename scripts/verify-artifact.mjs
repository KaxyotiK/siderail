#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const manifest = fs.readFileSync("herdr-plugin.toml", "utf8");
const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
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
  if (!absolute.endsWith(".mjs") && !absolute.endsWith(".sh")) return;
  const source = fs.readFileSync(absolute, "utf8");
  if (absolute.endsWith(".mjs")) {
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      verifyImports(path.resolve(path.dirname(absolute), match[1]));
    }
  }
  // Scripts launched by path rather than imported, such as the coordinator,
  // the temporary-copy cleaner, and the shell launchers' Node entrypoints.
  for (const match of source.matchAll(/\bscripts\/[\w-]+\.(?:mjs|sh)\b/g)) {
    if (fs.existsSync(match[0])) verifyImports(match[0]);
  }
}
const binaries = Object.values(packageManifest.bin || {});
const releaseOnlyFiles = ["scripts/run-isolated-live-smoke.sh"];
for (const file of new Set([...references, ...binaries, ...requiredReleaseFiles.filter((file) => !releaseOnlyFiles.includes(file))])) {
  verifyImports(file);
}
const runtimeFiles = new Set(visited);
for (const file of releaseOnlyFiles) verifyImports(file);

// The npm package must carry every runtime file; `files` entries are exact
// paths, directory prefixes ending in "/", or a single-directory "*.ext" glob.
function packaged(relative) {
  return packageManifest.files.some((entry) => {
    if (entry.endsWith("/")) return relative.startsWith(entry);
    if (entry.includes("*")) {
      const [directory, pattern] = [path.dirname(entry), path.basename(entry)];
      return path.dirname(relative) === directory && relative.endsWith(pattern.replace(/^\*/, ""));
    }
    return relative === entry;
  });
}
if (!Array.isArray(packageManifest.files)) throw new Error("package.json must declare a files allowlist");
const unpackaged = [...runtimeFiles]
  .map((absolute) => path.relative(process.cwd(), absolute))
  .filter((relative) => !packaged(relative));
if (!packaged("herdr-plugin.toml")) unpackaged.push("herdr-plugin.toml");
if (unpackaged.length) throw new Error(`npm package omits runtime files: ${unpackaged.join(", ")}`);
console.log(`Verified ${new Set(references).size} manifest runtime files and ${visited.size} archive runtime dependencies, all in the npm files allowlist`);
