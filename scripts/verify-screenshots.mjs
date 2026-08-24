#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNode } from "../src/node-version.mjs";

assertSupportedNode();

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedImages = new Map([
  [36, { pixelWidth: 468, pixelHeight: 2108 }],
  [52, { pixelWidth: 660, pixelHeight: 2108 }],
  [100, { pixelWidth: 1236, pixelHeight: 2108 }],
]);

export function pngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.subarray(0, 8).equals(signature), "screenshot is not a PNG");
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR", "screenshot has no PNG IHDR");
  return { pixelWidth: bytes.readUInt32BE(16), pixelHeight: bytes.readUInt32BE(20) };
}

function fullCommit(value, label) {
  const resolved = execFileSync("git", ["rev-parse", "--verify", `${value}^{commit}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40,64}$/.test(resolved)) throw new Error(`${label} did not resolve to a full commit`);
  return resolved;
}

function extractCommit(commit, destination) {
  const archive = spawnSync("git", ["archive", "--format=tar", commit], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error(`git archive ${commit} failed: ${archive.stderr?.toString() || ""}`);
  const archiveFile = path.join(path.dirname(destination), `${commit}.tar`);
  fs.writeFileSync(archiveFile, archive.stdout);
  fs.mkdirSync(destination);
  execFileSync("tar", ["-xf", archiveFile, "-C", destination]);
}

function snapshot(checkout, width, environmentRoot) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_RAIL_") || key.startsWith("HERDR_")) delete environment[key];
  }
  environment.HOME = path.join(environmentRoot, "home");
  environment.XDG_CONFIG_HOME = path.join(environmentRoot, "config");
  environment.XDG_CACHE_HOME = path.join(environmentRoot, "cache");
  environment.XDG_STATE_HOME = path.join(environmentRoot, "state");
  return execFileSync(process.execPath, [
    "scripts/git-rail.mjs", "--demo", "--snapshot", "--width", String(width), "--height", "46",
  ], { cwd: checkout, env: environment });
}

export function verifyScreenshotMetadata({ candidate = "HEAD", resolveCommits = true } = {}) {
  const readme = fs.readFileSync(path.join(repositoryRoot, "docs", "screenshots", "README.md"), "utf8");
  const visualSource = readme.match(/^- Visual source: `([0-9a-f]{40,64})`$/m)?.[1];
  if (!visualSource) throw new Error("screenshot README must name a full visual-source SHA");
  if (!/^- Herdr: `0\.8\.\d+`$/m.test(readme)) throw new Error("screenshot README must name exact Herdr 0.8.x");
  const candidateSha = resolveCommits ? fullCommit(candidate, "candidate") : null;
  const visualSourceSha = resolveCommits ? fullCommit(visualSource, "visual source") : visualSource;
  for (const [width, expected] of expectedImages) {
    const file = path.join(repositoryRoot, "docs", "screenshots", `gitrail-${width}.png`);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > 10_000, `${path.basename(file)} is unexpectedly small`);
    assert.deepEqual(pngDimensions(bytes), expected, `${path.basename(file)} dimensions changed`);
  }
  return { candidateSha, visualSourceSha };
}

export function verifyScreenshotSnapshots({ candidate = "HEAD" } = {}) {
  const metadata = verifyScreenshotMetadata({ candidate, resolveCommits: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitrail-screenshot-proof-"));
  try {
    const sourceRoot = path.join(temporaryRoot, "source");
    const candidateRoot = path.join(temporaryRoot, "candidate");
    extractCommit(metadata.visualSourceSha, sourceRoot);
    extractCommit(metadata.candidateSha, candidateRoot);
    for (const width of expectedImages.keys()) {
      const sourceOutput = snapshot(sourceRoot, width, path.join(temporaryRoot, `source-${width}`));
      const candidateOutput = snapshot(candidateRoot, width, path.join(temporaryRoot, `candidate-${width}`));
      assert.deepEqual(candidateOutput, sourceOutput, `candidate ${width}-column output differs from screenshot visual source`);
    }
    return metadata;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const shaIndex = process.argv.indexOf("--sha");
  const candidate = shaIndex >= 0 ? process.argv[shaIndex + 1] : "HEAD";
  const result = verifyScreenshotSnapshots({ candidate });
  process.stdout.write(`${JSON.stringify({ type: "screenshot_verification", ...result, widths: [...expectedImages.keys()] })}\n`);
}
