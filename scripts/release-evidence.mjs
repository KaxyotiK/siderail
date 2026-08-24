#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_RELEASE_CELLS = [
  "local-node-22",
  "local-node-24",
  "poisoned-environment",
  "archive",
  "dependency-audit",
  "live-macos",
  "live-linux",
  "screenshots",
];

const NODE_CELL_MAJORS = new Map([
  ["local-node-22", 22],
  ["local-node-24", 24],
]);

const LIVE_PLATFORM_CELLS = new Map([
  ["live-macos", /^macOS\s+\d+(?:\.\d+)+/i],
  ["live-linux", /^Linux\s+.+/i],
]);

function assertSha(sha, label = "candidate SHA") {
  if (!/^[0-9a-f]{40,64}$/.test(sha || "")) {
    throw new Error(`${label} must be a full lowercase Git object id`);
  }
}

function assertCell(cell) {
  if (!REQUIRED_RELEASE_CELLS.includes(cell)) throw new Error(`unknown release cell: ${cell}`);
}

function assertStatus(status) {
  if (!["pass", "fail"].includes(status)) throw new Error("evidence status must be pass or fail");
}

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeManifest(file, manifest) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function digestFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function checkedManifest(file, candidateSha) {
  assertSha(candidateSha);
  const manifest = readManifest(file);
  if (manifest.version !== 5 || manifest.candidateSha !== candidateSha) {
    throw new Error("evidence manifest does not name the candidate SHA");
  }
  return manifest;
}

function commonRecord({ candidateSha, command, status, platform, node, herdr, visualSourceSha, captureSourceSha, now }) {
  if (!command?.trim()) throw new Error("record requires a non-empty command");
  assertStatus(status);
  if (visualSourceSha) assertSha(visualSourceSha, "visual source SHA");
  if (captureSourceSha) assertSha(captureSourceSha, "capture source SHA");
  return {
    status,
    candidateSha,
    command: command.trim(),
    recordedAt: now,
    ...(platform ? { platform: platform.trim() } : {}),
    ...(node ? { node: node.trim() } : {}),
    ...(herdr ? { herdr: herdr.trim() } : {}),
    ...(visualSourceSha ? { visualSourceSha } : {}),
    ...(captureSourceSha ? { captureSourceSha } : {}),
  };
}

export function initializeEvidence({ file, candidateSha, release = "0.1.0", now = new Date().toISOString() }) {
  assertSha(candidateSha);
  if (fs.existsSync(file)) throw new Error(`evidence file already exists: ${file}`);
  const manifest = { version: 5, release, candidateSha, createdAt: now, cells: {} };
  writeManifest(file, manifest);
  return manifest;
}

export function recordFileEvidence({
  file,
  candidateSha,
  cell,
  command,
  evidenceFile,
  status,
  platform,
  node,
  herdr,
  visualSourceSha,
  captureSourceSha,
  now = new Date().toISOString(),
}) {
  assertCell(cell);
  const manifest = checkedManifest(file, candidateSha);
  const evidencePath = path.resolve(evidenceFile || "");
  if (!evidenceFile || !fs.statSync(evidencePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("file evidence must name an existing regular file");
  }
  manifest.cells[cell] = {
    ...commonRecord({ candidateSha, command, status, platform, node, herdr, visualSourceSha, captureSourceSha, now }),
    evidence: { kind: "file", path: evidencePath, sha256: digestFile(evidencePath) },
  };
  writeManifest(file, manifest);
  if (status !== "pass") throw new Error(`${cell} recorded a failed evidence result`);
  return manifest;
}

function verifyCellMetadata(cell, record) {
  const requiredNodeMajor = NODE_CELL_MAJORS.get(cell);
  if (requiredNodeMajor && !new RegExp(`^v?${requiredNodeMajor}\\.`).test(record.node || "")) {
    throw new Error(`${cell} must record Node ${requiredNodeMajor}.x`);
  }
  const platformPattern = LIVE_PLATFORM_CELLS.get(cell);
  if (platformPattern) {
    if (!platformPattern.test(record.platform || "")) {
      throw new Error(`${cell} must record its exact platform version`);
    }
    if (!/^v?(?:22|24)\./.test(record.node || "")) {
      throw new Error(`${cell} must record Node 22.x or 24.x`);
    }
    if (!/\b0\.8\.\d+\b/.test(record.herdr || "")) {
      throw new Error(`${cell} must record Herdr 0.8.x`);
    }
  }
  if (cell === "screenshots") {
    assertSha(record.visualSourceSha, "screenshots visual source SHA");
    assertSha(record.captureSourceSha, "screenshots capture source SHA");
  }
}

function bundledFile(directory, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("bundled evidence paths must be relative");
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("bundled evidence path escapes its bundle");
  }
  const absolute = path.resolve(directory, normalized);
  const root = `${path.resolve(directory)}${path.sep}`;
  if (!absolute.startsWith(root)) throw new Error("bundled evidence path escapes its bundle");
  return absolute;
}

function verifyFileEvidence(cell, record, { bundledDirectory = "" } = {}) {
  const evidence = record.evidence;
  if (evidence?.kind !== "file" || !/^[0-9a-f]{64}$/.test(evidence.sha256 || "")) {
    throw new Error(`${cell} does not contain hashed file evidence`);
  }
  const evidenceFile = bundledDirectory
    ? bundledFile(bundledDirectory, evidence.path)
    : path.isAbsolute(evidence.path) ? evidence.path : "";
  if (!evidenceFile) throw new Error(`${cell} evidence path must be absolute before sealing`);
  const currentDigest = fs.statSync(evidenceFile, { throwIfNoEntry: false })?.isFile()
    ? digestFile(evidenceFile)
    : "";
  if (currentDigest !== evidence.sha256) throw new Error(`${cell} evidence file is missing or has changed`);
}

export function verifyEvidence({ file, candidateSha }) {
  const manifest = checkedManifest(file, candidateSha);
  const missing = REQUIRED_RELEASE_CELLS.filter((cell) => {
    const record = manifest.cells?.[cell];
    return record?.status !== "pass" || record.candidateSha !== candidateSha || !record.command;
  });
  if (missing.length) throw new Error(`release evidence is incomplete: ${missing.join(", ")}`);
  for (const cell of REQUIRED_RELEASE_CELLS) {
    const record = manifest.cells[cell];
    verifyFileEvidence(cell, record);
    verifyCellMetadata(cell, record);
  }
  return manifest;
}

export function sealEvidenceBundle({
  file,
  candidateSha,
  directory,
  now = new Date().toISOString(),
}) {
  const manifest = verifyEvidence({ file, candidateSha });
  const destination = path.resolve(directory);
  if (fs.existsSync(destination)) throw new Error(`evidence bundle already exists: ${destination}`);
  const temporary = `${destination}.${process.pid}.tmp`;
  if (fs.existsSync(temporary)) throw new Error(`temporary evidence bundle already exists: ${temporary}`);
  fs.mkdirSync(path.join(temporary, "files"), { recursive: true, mode: 0o700 });
  try {
    const bundled = JSON.parse(JSON.stringify(manifest));
    bundled.bundleVersion = 1;
    bundled.sealedAt = now;
    bundled.sourceManifestSha256 = digestFile(file);
    for (const cell of REQUIRED_RELEASE_CELLS) {
      const relativePath = path.posix.join("files", `${cell}.log`);
      fs.copyFileSync(manifest.cells[cell].evidence.path, path.join(temporary, relativePath));
      bundled.cells[cell].evidence.path = relativePath;
    }
    writeManifest(path.join(temporary, "evidence.json"), bundled);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.renameSync(temporary, destination);
    return bundled;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function verifyEvidenceBundle({ directory, candidateSha }) {
  const root = path.resolve(directory);
  const manifest = checkedManifest(path.join(root, "evidence.json"), candidateSha);
  if (manifest.bundleVersion !== 1 || !/^[0-9a-f]{64}$/.test(manifest.sourceManifestSha256 || "")) {
    throw new Error("release evidence bundle metadata is invalid");
  }
  const missing = REQUIRED_RELEASE_CELLS.filter((cell) => {
    const record = manifest.cells?.[cell];
    return record?.status !== "pass" || record.candidateSha !== candidateSha || !record.command;
  });
  if (missing.length) throw new Error(`release evidence bundle is incomplete: ${missing.join(", ")}`);
  for (const cell of REQUIRED_RELEASE_CELLS) {
    const record = manifest.cells[cell];
    verifyFileEvidence(cell, record, { bundledDirectory: root });
    verifyCellMetadata(cell, record);
  }
  return manifest;
}

function portableRepositoryPath(value) {
  const normalized = path.posix.normalize(String(value || "").replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")
    || normalized.startsWith("/")) throw new Error("bundle repository path must stay inside the repository");
  return normalized;
}

export function verifyEvidenceCommit({
  directory,
  candidateSha,
  evidenceCommit,
  bundleRepositoryPath,
  repositoryRoot = process.cwd(),
  git = (args) => execFileSync("git", args, { cwd: repositoryRoot }),
}) {
  assertSha(evidenceCommit, "evidence commit");
  const repositoryPath = portableRepositoryPath(bundleRepositoryPath);
  const manifest = verifyEvidenceBundle({ directory, candidateSha });
  const parent = git(["rev-parse", `${evidenceCommit}^`]).toString().trim();
  if (parent !== candidateSha) throw new Error("evidence commit must be the candidate's direct child");
  const requiredPaths = ["evidence.json", ...REQUIRED_RELEASE_CELLS.map((cell) => manifest.cells[cell].evidence.path)];
  const committedPaths = git([
    "diff-tree", "--no-commit-id", "--name-only", "-r", evidenceCommit,
  ]).toString().split(/\r?\n/).filter(Boolean).sort();
  const expectedPaths = requiredPaths.map((relativePath) => (
    path.posix.join(repositoryPath, relativePath)
  )).sort();
  if (committedPaths.length !== expectedPaths.length
    || committedPaths.some((committedPath, index) => committedPath !== expectedPaths[index])) {
    throw new Error("evidence commit must contain only the sealed evidence bundle");
  }
  for (const relativePath of requiredPaths) {
    const localFile = bundledFile(directory, relativePath);
    const committed = git(["show", `${evidenceCommit}:${path.posix.join(repositoryPath, relativePath)}`]);
    if (!Buffer.from(committed).equals(fs.readFileSync(localFile))) {
      throw new Error(`evidence commit does not contain the verified ${relativePath}`);
    }
  }
  return manifest;
}

export function createTagMessage({
  directory,
  candidateSha,
  evidenceCommit,
  repositoryUrl,
  bundleRepositoryPath,
  repositoryRoot,
  git,
}) {
  const repository = String(repositoryUrl || "").replace(/\.git\/?$/, "").replace(/\/$/, "");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("repository URL must be a canonical GitHub repository URL");
  }
  const repositoryPath = portableRepositoryPath(bundleRepositoryPath);
  const manifest = verifyEvidenceCommit({
    directory,
    candidateSha,
    evidenceCommit,
    bundleRepositoryPath: repositoryPath,
    repositoryRoot,
    git,
  });
  const file = path.join(path.resolve(directory), "evidence.json");
  const digest = digestFile(file);
  const blobRoot = `${repository}/blob/${evidenceCommit}/${repositoryPath}`;
  const evidenceLines = REQUIRED_RELEASE_CELLS.map((cell) => {
    const evidence = manifest.cells[cell].evidence;
    return `- ${cell}: ${blobRoot}/${evidence.path}#sha256=${evidence.sha256}`;
  });
  return [
    `Herdr GitRail ${manifest.release}`,
    "",
    `Validated candidate: ${candidateSha}`,
    `Evidence commit: ${evidenceCommit}`,
    `Evidence manifest: ${blobRoot}/evidence.json`,
    `Evidence SHA-256: ${digest}`,
    "",
    ...evidenceLines,
    "",
  ].join("\n");
}

function argumentsMap(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) result._.push(argv[index]);
    else result[argv[index].slice(2)] = argv[index + 1], index += 1;
  }
  return result;
}

function required(args, name) {
  if (!args[name]) throw new Error(`missing --${name}`);
  return args[name];
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = argumentsMap(process.argv.slice(2));
    const command = args._[0];
    const candidateSha = required(args, "sha");
    const fileCommands = new Set(["init", "record-file", "verify", "seal"]);
    const common = { file: fileCommands.has(command) ? required(args, "file") : "", candidateSha };
    if (command === "init") initializeEvidence({ ...common, release: args.release });
    else if (command === "record-file") recordFileEvidence({
      ...common,
      cell: required(args, "cell"),
      command: required(args, "command"),
      evidenceFile: required(args, "evidence-file"),
      status: required(args, "status"),
      platform: args.platform,
      node: args.node,
      herdr: args.herdr,
      visualSourceSha: args["visual-source-sha"],
      captureSourceSha: args["capture-source-sha"],
    });
    else if (command === "verify") verifyEvidence(common);
    else if (command === "seal") sealEvidenceBundle({
      ...common,
      directory: required(args, "output"),
    });
    else if (command === "verify-bundle") verifyEvidenceBundle({
      directory: required(args, "bundle"),
      candidateSha,
    });
    else if (command === "tag-message") process.stdout.write(createTagMessage({
      directory: required(args, "bundle"),
      candidateSha,
      evidenceCommit: required(args, "evidence-commit"),
      repositoryUrl: required(args, "repository-url"),
      bundleRepositoryPath: required(args, "bundle-repository-path"),
    }));
    else throw new Error("usage: release-evidence.mjs <init|record-file|verify|seal|verify-bundle|tag-message> --sha SHA [...]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
