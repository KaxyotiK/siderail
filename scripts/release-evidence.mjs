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
  "ci-archive",
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
  "ci-archive",
  "dependency-review",
  "development-migration",
  "live-macos-15",
  "live-ubuntu-24.04",
  "uninstall-macos-15",
  "uninstall-ubuntu-24.04",
]);

const CHECK_STEPS = [
  "Run npm ci --ignore-scripts",
  "Run npm run check",
  "Run npm run test:coverage",
  "Run npm run snapshot",
  "Run npm run artifact:verify",
];

const LIVE_SETUP_STEPS = [
  "Run npm ci --ignore-scripts",
  "Run npm run check",
  "Install pinned Herdr and Glow binaries",
];

export const GITHUB_CELL_CONTRACTS = new Map([
  ["ci-macos-15-node-22", {
    workflow: "CI", workflowPath: ".github/workflows/ci.yml", event: "push", job: "test (macos-15, 22)", steps: CHECK_STEPS,
  }],
  ["ci-macos-15-node-24", {
    workflow: "CI", workflowPath: ".github/workflows/ci.yml", event: "push", job: "test (macos-15, 24)", steps: CHECK_STEPS,
  }],
  ["ci-ubuntu-24.04-node-22", {
    workflow: "CI", workflowPath: ".github/workflows/ci.yml", event: "push", job: "test (ubuntu-24.04, 22)", steps: CHECK_STEPS,
  }],
  ["ci-ubuntu-24.04-node-24", {
    workflow: "CI", workflowPath: ".github/workflows/ci.yml", event: "push", job: "test (ubuntu-24.04, 24)", steps: CHECK_STEPS,
  }],
  ["poisoned-environment", {
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    job: "poisoned-environment",
    steps: [
      "Run npm ci --ignore-scripts",
      "Create hostile Herdr witness",
      "Run with poisoned parent environment",
    ],
  }],
  ["demo-snapshot", {
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    job: "demo-snapshot",
    steps: ["Run npm ci --ignore-scripts", "Run npm run snapshot", "Run npm run artifact:verify"],
  }],
  ["ci-archive", {
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    job: "release-archive",
    steps: ["Verify the exact Git archive"],
  }],
  ["live-macos-15", {
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    job: "live-herdr (macos-15)",
    steps: [...LIVE_SETUP_STEPS, "Run clean-install live Herdr walkthrough and unlink proof"],
    platform: "macOS 15",
    node: "v22.x (actions/setup-node)",
    herdr: "herdr 0.8.2",
  }],
  ["uninstall-macos-15", {
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    job: "live-herdr (macos-15)",
    steps: [...LIVE_SETUP_STEPS, "Run clean-install live Herdr walkthrough and unlink proof"],
    platform: "macOS 15",
    node: "v22.x (actions/setup-node)",
    herdr: "herdr 0.8.2",
  }],
  ["live-ubuntu-24.04", {
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    job: "live-herdr (ubuntu-24.04)",
    steps: [...LIVE_SETUP_STEPS, "Run clean-install live Herdr walkthrough and unlink proof"],
    platform: "Ubuntu 24.04",
    node: "v22.x (actions/setup-node)",
    herdr: "herdr 0.8.2",
  }],
  ["uninstall-ubuntu-24.04", {
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    job: "live-herdr (ubuntu-24.04)",
    steps: [...LIVE_SETUP_STEPS, "Run clean-install live Herdr walkthrough and unlink proof"],
    platform: "Ubuntu 24.04",
    node: "v22.x (actions/setup-node)",
    herdr: "herdr 0.8.2",
  }],
  ["development-migration", {
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    job: "live-herdr (ubuntu-24.04)",
    steps: [...LIVE_SETUP_STEPS, "Run development migration and unlink proof"],
  }],
  ["dependency-review", {
    workflow: "Dependency audit",
    workflowPath: ".github/workflows/dependency-audit.yml",
    event: "workflow_dispatch",
    job: "dependency-audit",
    steps: [
      "Verify refs and review dependency changes",
      "Run npm ci --ignore-scripts",
      "Run npm audit --audit-level=high",
    ],
  }],
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
  if (manifest.version !== 3 || manifest.candidateSha !== candidateSha) {
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
  const manifest = { version: 3, release, candidateSha, createdAt: now, cells: {} };
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
  const inspected = JSON.parse(execFileSync("gh", [
    "run", "view", githubRunId(run),
    "--json", "databaseId,headSha,conclusion,url,workflowName,workflowDatabaseId,event,jobs",
  ], { encoding: "utf8" }));
  const workflow = JSON.parse(execFileSync("gh", [
    "api", `repos/{owner}/{repo}/actions/workflows/${inspected.workflowDatabaseId}`,
  ], { encoding: "utf8" }));
  return { ...inspected, workflowPath: workflow.path };
}

function verifiedGithubCell(cell, inspected) {
  const contract = GITHUB_CELL_CONTRACTS.get(cell);
  if (!contract) throw new Error(`${cell} has no GitHub Actions verification contract`);
  if (inspected.workflowName !== contract.workflow) {
    throw new Error(`${cell} requires the ${contract.workflow} workflow`);
  }
  if (inspected.workflowPath !== contract.workflowPath) {
    throw new Error(`${cell} requires workflow path ${contract.workflowPath}`);
  }
  if (inspected.event !== contract.event) {
    throw new Error(`${cell} requires a ${contract.event} workflow run`);
  }
  const job = inspected.jobs?.find((candidate) => candidate.name === contract.job);
  if (!job) throw new Error(`${cell} requires the ${contract.job} job`);
  if (job.conclusion !== "success") throw new Error(`${cell} job concluded ${job.conclusion || "without a result"}`);
  const verifiedSteps = [];
  for (const name of contract.steps) {
    const step = job.steps?.find((candidate) => candidate.name === name);
    if (!step) throw new Error(`${cell} requires the ${name} step`);
    if (step.conclusion !== "success") {
      throw new Error(`${cell} step ${name} concluded ${step.conclusion || "without a result"}`);
    }
    verifiedSteps.push({ name, conclusion: step.conclusion });
  }
  return { contract, job, verifiedSteps };
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
  if (status !== "pass") {
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
    throw new Error(`${cell} GitHub Actions run concluded ${inspected.conclusion || "without a result"}`);
  }
  const { contract, job, verifiedSteps } = verifiedGithubCell(cell, inspected);
  manifest.cells[cell] = {
    ...commonRecord({
      candidateSha,
      command,
      status,
      platform: contract.platform || platform,
      node: contract.node || node,
      herdr: contract.herdr || herdr,
      now,
    }),
    evidence: {
      kind: "github-actions",
      runId: String(inspected.databaseId || githubRunId(inspected.url)),
      url: inspected.url,
      headSha: inspected.headSha,
      conclusion: inspected.conclusion || "",
      workflow: inspected.workflowName,
      workflowPath: inspected.workflowPath,
      event: inspected.event,
      jobId: String(job.databaseId || ""),
      jobName: job.name,
      jobUrl: job.url || "",
      steps: verifiedSteps,
    },
  };
  writeManifest(file, manifest);
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
    const contract = GITHUB_CELL_CONTRACTS.get(cell);
    if (evidence?.kind !== "github-actions" || evidence.headSha !== candidateSha
      || evidence.conclusion !== "success" || !evidence.url || !evidence.runId
      || evidence.workflow !== contract?.workflow || evidence.workflowPath !== contract?.workflowPath
      || evidence.event !== contract?.event
      || evidence.jobName !== contract?.job || !evidence.jobId || !evidence.jobUrl
      || contract.steps.some((name) => !evidence.steps?.some((step) => (
        step.name === name && step.conclusion === "success"
      )))) {
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
      const record = bundled.cells[cell];
      if (record.evidence.kind !== "file") continue;
      const relativePath = path.posix.join("files", `${cell}.log`);
      fs.copyFileSync(manifest.cells[cell].evidence.path, path.join(temporary, relativePath));
      record.evidence.path = relativePath;
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

export function verifyEvidenceBundle({ directory, candidateSha }) {
  const root = path.resolve(directory);
  const file = path.join(root, "evidence.json");
  const manifest = checkedManifest(file, candidateSha);
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
    if (GITHUB_ACTIONS_CELLS.has(cell)) verifyEvidenceObject(cell, record, candidateSha);
    else {
      const evidence = record.evidence;
      if (evidence?.kind !== "file" || !/^[0-9a-f]{64}$/.test(evidence.sha256 || "")) {
        throw new Error(`${cell} does not contain bundled hashed file evidence`);
      }
      const evidenceFile = bundledFile(root, evidence.path);
      const currentDigest = fs.statSync(evidenceFile, { throwIfNoEntry: false })?.isFile()
        ? digestFile(evidenceFile)
        : "";
      if (currentDigest !== evidence.sha256) throw new Error(`${cell} bundled evidence is missing or has changed`);
    }
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
  const requiredPaths = ["evidence.json", ...REQUIRED_RELEASE_CELLS.flatMap((cell) => {
    const evidence = manifest.cells[cell].evidence;
    return evidence.kind === "file" ? [evidence.path] : [];
  })];
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
  const bytes = fs.readFileSync(file);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const blobRoot = `${repository}/blob/${evidenceCommit}/${repositoryPath}`;
  const evidenceLines = REQUIRED_RELEASE_CELLS.map((cell) => {
    const evidence = manifest.cells[cell].evidence;
    const reference = evidence.kind === "github-actions"
      ? evidence.jobUrl
      : `${blobRoot}/${evidence.path}#sha256=${evidence.sha256}`;
    return `- ${cell}: ${reference}`;
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
    const fileCommands = new Set(["init", "record-file", "record-ci", "verify", "seal"]);
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
    else throw new Error("usage: release-evidence.mjs <init|record-file|record-ci|verify|seal|verify-bundle|tag-message> --sha SHA [...]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
