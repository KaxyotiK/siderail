#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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

export const GITHUB_ACTIONS_CELLS = new Set([
  "ci-macos-15-node-22",
  "ci-macos-15-node-24",
  "ci-ubuntu-24.04-node-22",
  "ci-ubuntu-24.04-node-24",
  "poisoned-environment",
  "demo-snapshot",
  "dependency-review",
  "development-migration",
  "live-macos-15",
  "live-ubuntu-24.04",
  "uninstall-macos-15",
  "uninstall-ubuntu-24.04",
]);

const LIVE_PLATFORM_CELLS = new Map([
  ["live-macos-15", /^macOS 15(?:\.|\b)/i],
  ["uninstall-macos-15", /^macOS 15(?:\.|\b)/i],
  ["live-ubuntu-24.04", /^Ubuntu 24\.04(?:\.|\b)/i],
  ["uninstall-ubuntu-24.04", /^Ubuntu 24\.04(?:\.|\b)/i],
]);

function assertSha(sha, label = "candidate SHA") {
  if (!/^[0-9a-f]{40,64}$/.test(sha || "")) throw new Error(`${label} must be a full lowercase Git object id`);
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
  if (manifest.version !== 2 || manifest.candidateSha !== candidateSha) {
    throw new Error("evidence manifest does not name the candidate SHA");
  }
  return manifest;
}

function commonRecord({ candidateSha, command, status, platform, node, herdr, visualSourceSha, now }) {
  if (!command?.trim()) throw new Error("record requires a non-empty command");
  assertStatus(status);
  if (visualSourceSha) assertSha(visualSourceSha, "visual source SHA");
  return {
    status,
    candidateSha,
    command: command.trim(),
    recordedAt: now,
    ...(platform ? { platform: platform.trim() } : {}),
    ...(node ? { node: node.trim() } : {}),
    ...(herdr ? { herdr: herdr.trim() } : {}),
    ...(visualSourceSha ? { visualSourceSha } : {}),
  };
}

export function initializeEvidence({ file, candidateSha, release = "0.1.0", now = new Date().toISOString() }) {
  assertSha(candidateSha);
  if (fs.existsSync(file)) throw new Error(`evidence file already exists: ${file}`);
  const manifest = { version: 2, release, candidateSha, createdAt: now, cells: {} };
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
  now = new Date().toISOString(),
}) {
  assertCell(cell);
  if (GITHUB_ACTIONS_CELLS.has(cell)) throw new Error(`${cell} requires verified GitHub Actions evidence`);
  const manifest = checkedManifest(file, candidateSha);
  const evidencePath = path.resolve(evidenceFile || "");
  if (!evidenceFile || !fs.statSync(evidencePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("file evidence must name an existing regular file");
  }
  manifest.cells[cell] = {
    ...commonRecord({ candidateSha, command, status, platform, node, herdr, visualSourceSha, now }),
    evidence: { kind: "file", path: evidencePath, sha256: digestFile(evidencePath) },
  };
  writeManifest(file, manifest);
  if (status !== "pass") throw new Error(`${cell} recorded a failed evidence result`);
  return manifest;
}

function githubRunId(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:^|\/actions\/runs\/)(\d+)(?:\/|$)/);
  if (!match) throw new Error("GitHub Actions evidence must name a numeric run id or run URL");
  return match[1];
}

function inspectGithubRun(run) {
  return JSON.parse(execFileSync("gh", [
    "run", "view", githubRunId(run), "--json", "databaseId,headSha,conclusion,url",
  ], { encoding: "utf8" }));
}

export function recordGithubActionsEvidence({
  file,
  candidateSha,
  cell,
  command,
  run,
  platform,
  node,
  herdr,
  inspectRun = inspectGithubRun,
  now = new Date().toISOString(),
}) {
  assertCell(cell);
  if (!GITHUB_ACTIONS_CELLS.has(cell)) throw new Error(`${cell} requires hashed file evidence`);
  const manifest = checkedManifest(file, candidateSha);
  const inspected = inspectRun(run);
  if (inspected?.headSha !== candidateSha) throw new Error("GitHub Actions run does not name the candidate SHA");
  if (!/^https:\/\/github\.com\/.+\/actions\/runs\/\d+(?:\/|$)/.test(inspected?.url || "")) {
    throw new Error("GitHub Actions run did not return a canonical run URL");
  }
  const status = inspected.conclusion === "success" ? "pass" : "fail";
  manifest.cells[cell] = {
    ...commonRecord({ candidateSha, command, status, platform, node, herdr, now }),
    evidence: {
      kind: "github-actions",
      runId: String(inspected.databaseId || githubRunId(inspected.url)),
      url: inspected.url,
      headSha: inspected.headSha,
      conclusion: inspected.conclusion || "",
    },
  };
  writeManifest(file, manifest);
  if (status !== "pass") throw new Error(`${cell} GitHub Actions run concluded ${inspected.conclusion || "without a result"}`);
  return manifest;
}

function verifyCellMetadata(cell, record) {
  const platformPattern = LIVE_PLATFORM_CELLS.get(cell);
  if (platformPattern) {
    if (!platformPattern.test(record.platform || "")) throw new Error(`${cell} must record its exact supported platform version`);
    if (!/^v?(?:22|24)\./.test(record.node || "")) throw new Error(`${cell} must record Node 22.x or 24.x`);
    if (!/\b0\.8\.\d+\b/.test(record.herdr || "")) throw new Error(`${cell} must record Herdr 0.8.x`);
  }
  if (cell === "screenshots") assertSha(record.visualSourceSha, "screenshots visual source SHA");
}

function verifyEvidenceObject(cell, record, candidateSha) {
  const evidence = record.evidence;
  if (GITHUB_ACTIONS_CELLS.has(cell)) {
    if (evidence?.kind !== "github-actions" || evidence.headSha !== candidateSha
      || evidence.conclusion !== "success" || !evidence.url || !evidence.runId) {
      throw new Error(`${cell} does not contain successful candidate-bound GitHub Actions evidence`);
    }
    return;
  }
  if (evidence?.kind !== "file" || !path.isAbsolute(evidence.path)
    || !/^[0-9a-f]{64}$/.test(evidence.sha256 || "")) {
    throw new Error(`${cell} does not contain hashed file evidence`);
  }
  const currentDigest = fs.statSync(evidence.path, { throwIfNoEntry: false })?.isFile()
    ? digestFile(evidence.path)
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
    verifyEvidenceObject(cell, record, candidateSha);
    verifyCellMetadata(cell, record);
  }
  return manifest;
}

function evidenceReference(record) {
  return record.evidence.kind === "github-actions"
    ? record.evidence.url
    : `${record.evidence.path}#sha256=${record.evidence.sha256}`;
}

export function createTagMessage({ file, candidateSha }) {
  const manifest = verifyEvidence({ file, candidateSha });
  const bytes = fs.readFileSync(file);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const evidenceLines = REQUIRED_RELEASE_CELLS.map((cell) => `- ${cell}: ${evidenceReference(manifest.cells[cell])}`);
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
    });
    else if (command === "record-ci") recordGithubActionsEvidence({
      ...common,
      cell: required(args, "cell"),
      command: required(args, "command"),
      run: required(args, "run"),
      platform: args.platform,
      node: args.node,
      herdr: args.herdr,
    });
    else if (command === "verify") verifyEvidence(common);
    else if (command === "tag-message") process.stdout.write(createTagMessage(common));
    else throw new Error("usage: release-evidence.mjs <init|record-file|record-ci|verify|tag-message> --file PATH --sha SHA [...]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
