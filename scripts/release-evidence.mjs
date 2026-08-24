#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_RELEASE_CELLS = [
  "local",
  "ci-macos-15-node-22",
  "ci-macos-15-node-24",
  "ci-ubuntu-24.04-node-22",
  "ci-ubuntu-24.04-node-24",
  "poisoned-environment",
  "demo-snapshot",
  "dependency-review",
  "archive",
  "live-macos-15",
  "live-ubuntu-24.04",
  "development-migration",
  "uninstall-macos-15",
  "uninstall-ubuntu-24.04",
  "screenshots",
];

function assertSha(sha) {
  if (!/^[0-9a-f]{40,64}$/.test(sha || "")) throw new Error("candidate SHA must be a full lowercase Git object id");
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

export function initializeEvidence({ file, candidateSha, release = "0.1.0", now = new Date().toISOString() }) {
  assertSha(candidateSha);
  if (fs.existsSync(file)) throw new Error(`evidence file already exists: ${file}`);
  const manifest = { version: 1, release, candidateSha, createdAt: now, cells: {} };
  writeManifest(file, manifest);
  return manifest;
}

export function recordEvidence({ file, candidateSha, cell, command, evidence, platform, node, herdr, now = new Date().toISOString() }) {
  assertSha(candidateSha);
  if (!REQUIRED_RELEASE_CELLS.includes(cell)) throw new Error(`unknown release cell: ${cell}`);
  if (!command?.trim() || !evidence?.trim()) throw new Error("record requires non-empty command and evidence");
  const manifest = readManifest(file);
  if (manifest.candidateSha !== candidateSha) throw new Error("evidence candidate SHA does not match");
  manifest.cells[cell] = {
    status: "pass",
    candidateSha,
    command: command.trim(),
    evidence: evidence.trim(),
    recordedAt: now,
    ...(platform ? { platform } : {}),
    ...(node ? { node } : {}),
    ...(herdr ? { herdr } : {}),
  };
  writeManifest(file, manifest);
  return manifest;
}

export function verifyEvidence({ file, candidateSha }) {
  assertSha(candidateSha);
  const manifest = readManifest(file);
  if (manifest.version !== 1 || manifest.candidateSha !== candidateSha) throw new Error("evidence manifest does not name the candidate SHA");
  const missing = REQUIRED_RELEASE_CELLS.filter((cell) => {
    const record = manifest.cells?.[cell];
    return record?.status !== "pass" || record.candidateSha !== candidateSha || !record.command || !record.evidence;
  });
  if (missing.length) throw new Error(`release evidence is incomplete: ${missing.join(", ")}`);
  for (const cell of ["live-macos-15", "live-ubuntu-24.04"]) {
    const record = manifest.cells[cell];
    if (!record.platform || !record.node || !record.herdr) throw new Error(`${cell} must record platform, Node, and Herdr versions`);
  }
  return manifest;
}

export function createTagMessage({ file, candidateSha }) {
  const manifest = verifyEvidence({ file, candidateSha });
  const bytes = fs.readFileSync(file);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const evidenceLines = REQUIRED_RELEASE_CELLS.map((cell) => `- ${cell}: ${manifest.cells[cell].evidence}`);
  return [`Herdr GitRail ${manifest.release}`, "", `Validated candidate: ${candidateSha}`, `Evidence SHA-256: ${digest}`, "", ...evidenceLines, ""].join("\n");
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
    const common = { file: required(args, "file"), candidateSha: required(args, "sha") };
    if (command === "init") initializeEvidence({ ...common, release: args.release });
    else if (command === "record") recordEvidence({ ...common, cell: required(args, "cell"), command: required(args, "command"), evidence: required(args, "evidence"), platform: args.platform, node: args.node, herdr: args.herdr });
    else if (command === "verify") verifyEvidence(common);
    else if (command === "tag-message") process.stdout.write(createTagMessage(common));
    else throw new Error("usage: release-evidence.mjs <init|record|verify|tag-message> --file PATH --sha SHA [...]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
