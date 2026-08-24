import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTagMessage,
  GITHUB_ACTIONS_CELLS,
  GITHUB_CELL_CONTRACTS,
  initializeEvidence,
  recordFileEvidence,
  recordGithubActionsEvidence,
  REQUIRED_RELEASE_CELLS,
  sealEvidenceBundle,
  verifyEvidence,
  verifyEvidenceBundle,
} from "../scripts/release-evidence.mjs";
import { validateArchiveMembers } from "../scripts/verify-archive-members.mjs";

const SHA = "a".repeat(40);

function successfulRunFor(cell, overrides = {}) {
  const contract = GITHUB_CELL_CONTRACTS.get(cell);
  return {
    databaseId: 1234,
    headSha: SHA,
    conclusion: "success",
    url: "https://github.com/example/project/actions/runs/1234",
    workflowName: contract.workflow,
    workflowPath: contract.workflowPath,
    event: contract.event,
    jobs: [{
      databaseId: 5678,
      name: contract.job,
      conclusion: "success",
      url: "https://github.com/example/project/actions/runs/1234/job/5678",
      steps: contract.steps.map((name) => ({ name, conclusion: "success" })),
    }],
    ...overrides,
  };
}

test("archive member verification rejects local-only and removed artifacts", () => {
  const required = "herdr-plugin.toml\npackage.json\nscripts/uninstall-herdr-plugin.mjs\n";
  assert.equal(validateArchiveMembers(required).length, 3);
  assert.throws(() => validateArchiveMembers(`${required}node_modules/pkg/index.js\n`), /forbidden/);
  assert.throws(() => validateArchiveMembers(`${required}.git-rail.json\n`), /forbidden/);
  assert.throws(() => validateArchiveMembers(`${required}schema/v1/config.json\n`), /forbidden/);
});

test("release evidence binds verified runs and hashed files to one SHA", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gitrail-evidence-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "evidence.json");
  initializeEvidence({ file, candidateSha: SHA, now: "2026-08-23T00:00:00.000Z" });
  assert.throws(() => verifyEvidence({ file, candidateSha: SHA }), /incomplete/);
  for (const cell of REQUIRED_RELEASE_CELLS) {
    if (GITHUB_ACTIONS_CELLS.has(cell)) {
      const macos = cell.endsWith("macos-15");
      const ubuntu = cell.endsWith("ubuntu-24.04");
      recordGithubActionsEvidence({
        file,
        candidateSha: SHA,
        cell,
        command: `verify ${cell}`,
        run: "1234",
        platform: macos ? "macOS 15.7" : ubuntu ? "Ubuntu 24.04.3" : undefined,
        node: macos || ubuntu ? "v22.18.0" : undefined,
        herdr: macos || ubuntu ? "herdr 0.8.2" : undefined,
        inspectRun: () => successfulRunFor(cell),
      });
      continue;
    }
    const evidenceFile = path.join(directory, `${cell}.log`);
    fs.writeFileSync(evidenceFile, `verified ${cell}\n`);
    const macos = cell.endsWith("macos-15");
    const ubuntu = cell.endsWith("ubuntu-24.04");
    recordFileEvidence({
      file,
      candidateSha: SHA,
      cell,
      command: `verify ${cell}`,
      evidenceFile,
      status: "pass",
      platform: macos ? "macOS 15.7" : ubuntu ? "Ubuntu 24.04.3" : undefined,
      node: macos || ubuntu ? "v22.18.0" : undefined,
      herdr: macos || ubuntu ? "herdr 0.8.2" : undefined,
      visualSourceSha: cell === "screenshots" ? SHA : undefined,
    });
  }
  assert.equal(verifyEvidence({ file, candidateSha: SHA }).candidateSha, SHA);
  const bundle = path.join(directory, "bundle");
  sealEvidenceBundle({ file, candidateSha: SHA, directory: bundle });
  assert.equal(verifyEvidenceBundle({ directory: bundle, candidateSha: SHA }).candidateSha, SHA);
  const tagMessage = createTagMessage({
    directory: bundle,
    candidateSha: SHA,
    evidenceCommit: "b".repeat(40),
    repositoryUrl: "https://github.com/example/project.git",
    bundleRepositoryPath: `release-evidence/0.1.0/${SHA}`,
    git: (args) => {
      if (args[0] === "rev-parse") return Buffer.from(`${SHA}\n`);
      const repositoryPath = args[1].split(":")[1];
      const relativePath = repositoryPath.slice(`release-evidence/0.1.0/${SHA}/`.length);
      return fs.readFileSync(path.join(bundle, relativePath));
    },
  });
  assert.match(tagMessage, new RegExp(`Validated candidate: ${SHA}`));
  assert.match(tagMessage, /Evidence commit: b{40}/);
  assert.match(tagMessage, new RegExp(`github\\.com/example/project/blob/${"b".repeat(40)}/release-evidence/0\\.1\\.0/`));
  assert.doesNotMatch(tagMessage, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(tagMessage, /Evidence SHA-256: [0-9a-f]{64}/);
  assert.throws(() => createTagMessage({
    directory: bundle,
    candidateSha: SHA,
    evidenceCommit: "b".repeat(40),
    repositoryUrl: "https://github.com/example/project",
    bundleRepositoryPath: `release-evidence/0.1.0/${SHA}`,
    git: () => Buffer.from(`${"c".repeat(40)}\n`),
  }), /direct child/);
  fs.appendFileSync(path.join(bundle, "files", "local.log"), "tampered bundle\n");
  assert.throws(() => verifyEvidenceBundle({ directory: bundle, candidateSha: SHA }), /bundled evidence is missing or has changed/);
  assert.throws(() => recordFileEvidence({
    file,
    candidateSha: "b".repeat(40),
    cell: "local",
    command: "x",
    evidenceFile: path.join(directory, "local.log"),
    status: "pass",
  }), /does not name/);
});

test("release evidence rejects fabricated, failed, stale, and unsupported records", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gitrail-evidence-negative-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "evidence.json");
  const log = path.join(directory, "walkthrough.log");
  fs.writeFileSync(log, "observed walkthrough\n");
  initializeEvidence({ file, candidateSha: SHA });

  assert.throws(() => recordFileEvidence({
    file,
    candidateSha: SHA,
    cell: "local",
    command: "not executed",
    evidenceFile: path.join(directory, "missing.log"),
    status: "pass",
  }), /existing regular file/);
  assert.throws(() => recordGithubActionsEvidence({
    file,
    candidateSha: SHA,
    cell: "dependency-review",
    command: "audit",
    run: "1234",
    inspectRun: () => ({
      databaseId: 1234,
      headSha: "b".repeat(40),
      conclusion: "success",
      url: "https://github.com/example/project/actions/runs/1234",
    }),
  }), /does not name the candidate/);
  assert.throws(() => recordGithubActionsEvidence({
    file,
    candidateSha: SHA,
    cell: "dependency-review",
    command: "audit",
    run: "1234",
    inspectRun: () => ({
      databaseId: 1234,
      headSha: SHA,
      conclusion: "failure",
      url: "https://github.com/example/project/actions/runs/1234",
    }),
  }), /concluded failure/);
  assert.throws(() => recordGithubActionsEvidence({
    file,
    candidateSha: SHA,
    cell: "dependency-review",
    command: "audit",
    run: "1234",
    inspectRun: () => successfulRunFor("dependency-review", { workflowName: "CI" }),
  }), /requires the Dependency audit workflow/);
  assert.throws(() => recordGithubActionsEvidence({
    file,
    candidateSha: SHA,
    cell: "dependency-review",
    command: "audit",
    run: "1234",
    inspectRun: () => successfulRunFor("dependency-review", { workflowPath: ".github/workflows/ci.yml" }),
  }), /requires workflow path \.github\/workflows\/dependency-audit\.yml/);
  assert.throws(() => recordGithubActionsEvidence({
    file,
    candidateSha: SHA,
    cell: "dependency-review",
    command: "audit",
    run: "1234",
    inspectRun: () => successfulRunFor("dependency-review", { jobs: [] }),
  }), /requires the dependency-audit job/);
  const missingStep = successfulRunFor("dependency-review");
  missingStep.jobs[0].steps.pop();
  assert.throws(() => recordGithubActionsEvidence({
    file,
    candidateSha: SHA,
    cell: "dependency-review",
    command: "audit",
    run: "1234",
    inspectRun: () => missingStep,
  }), /requires the Run npm audit --audit-level=high step/);
  assert.throws(() => verifyEvidence({ file, candidateSha: SHA }), /incomplete/);

  for (const cell of REQUIRED_RELEASE_CELLS) {
    if (GITHUB_ACTIONS_CELLS.has(cell)) {
      recordGithubActionsEvidence({
        file,
        candidateSha: SHA,
        cell,
        command: `verify ${cell}`,
        run: "1234",
        inspectRun: () => successfulRunFor(cell),
      });
    } else {
      recordFileEvidence({
        file,
        candidateSha: SHA,
        cell,
        command: `verify ${cell}`,
        evidenceFile: log,
        status: "pass",
        visualSourceSha: cell === "screenshots" ? SHA : undefined,
      });
    }
  }
  const unsupported = JSON.parse(fs.readFileSync(file, "utf8"));
  unsupported.cells["live-macos-15"].platform = "macOS 26.0";
  fs.writeFileSync(file, `${JSON.stringify(unsupported, null, 2)}\n`);
  assert.throws(() => verifyEvidence({ file, candidateSha: SHA }), /supported platform/);

  const fileEvidence = path.join(directory, "file-evidence.json");
  initializeEvidence({ file: fileEvidence, candidateSha: SHA });
  recordFileEvidence({ file: fileEvidence, candidateSha: SHA, cell: "local", command: "check", evidenceFile: log, status: "pass" });
  fs.appendFileSync(log, "tampered\n");
  const stale = JSON.parse(fs.readFileSync(fileEvidence, "utf8"));
  for (const cell of REQUIRED_RELEASE_CELLS) stale.cells[cell] = stale.cells.local;
  fs.writeFileSync(fileEvidence, `${JSON.stringify(stale, null, 2)}\n`);
  assert.throws(() => verifyEvidence({ file: fileEvidence, candidateSha: SHA }), /evidence file is missing or has changed|GitHub Actions evidence/);

});
