import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTagMessage,
  initializeEvidence,
  recordFileEvidence,
  REQUIRED_RELEASE_CELLS,
  sealEvidenceBundle,
  verifyEvidence,
  verifyEvidenceBundle,
} from "../scripts/release-evidence.mjs";
import { validateArchiveMembers } from "../scripts/verify-archive-members.mjs";

const SHA = "a".repeat(40);

function metadataFor(cell) {
  if (cell === "local-node-22") return { node: "v22.18.0" };
  if (cell === "local-node-24") return { node: "v24.6.0" };
  if (cell === "live-macos") {
    return { platform: "macOS 26.0", node: "v22.18.0", herdr: "herdr 0.8.2" };
  }
  if (cell === "live-linux") {
    return { platform: "Linux Ubuntu 24.04", node: "v24.6.0", herdr: "herdr 0.8.2" };
  }
  if (cell === "npm-install") {
    return { platform: "macOS 26.0", node: "v24.6.0", herdr: "herdr 0.8.2" };
  }
  if (cell === "screenshots") return { visualSourceSha: SHA, captureSourceSha: SHA };
  return {};
}

function recordAll({ directory, file, evidenceFile = "" }) {
  for (const cell of REQUIRED_RELEASE_CELLS) {
    const log = evidenceFile || path.join(directory, `${cell}.log`);
    if (!evidenceFile) fs.writeFileSync(log, `verified ${cell}\n`);
    recordFileEvidence({
      file,
      candidateSha: SHA,
      cell,
      command: `verify ${cell}`,
      evidenceFile: log,
      status: "pass",
      ...metadataFor(cell),
    });
  }
}

test("archive member verification rejects local-only and removed artifacts", () => {
  const required = "herdr-plugin.toml\npackage.json\nscripts/run-isolated-live-smoke.sh\nscripts/uninstall-herdr-plugin.mjs\n";
  assert.equal(validateArchiveMembers(required).length, 4);
  assert.throws(() => validateArchiveMembers(`${required}node_modules/pkg/index.js\n`), /forbidden/);
  assert.throws(() => validateArchiveMembers(`${required}.siderail.json\n`), /forbidden/);
  assert.throws(() => validateArchiveMembers(`${required}schema/v1/config.json\n`), /forbidden/);
});

test("release evidence binds nine hashed local logs to one candidate", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-evidence-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "evidence.json");
  initializeEvidence({ file, candidateSha: SHA, now: "2026-08-23T00:00:00.000Z" });
  assert.throws(() => verifyEvidence({ file, candidateSha: SHA }), /incomplete/);
  recordAll({ directory, file });
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
      if (args[0] === "diff-tree") {
        return Buffer.from([
          `release-evidence/0.1.0/${SHA}/evidence.json`,
          ...REQUIRED_RELEASE_CELLS.map((cell) => `release-evidence/0.1.0/${SHA}/files/${cell}.log`),
          "",
        ].join("\n"));
      }
      const repositoryPath = args[1].split(":")[1];
      const relativePath = repositoryPath.slice(`release-evidence/0.1.0/${SHA}/`.length);
      return fs.readFileSync(path.join(bundle, relativePath));
    },
  });
  assert.match(tagMessage, new RegExp(`Validated candidate: ${SHA}`));
  assert.match(tagMessage, /Evidence commit: b{40}/);
  assert.match(tagMessage, /files\/live-linux\.log#sha256=[0-9a-f]{64}/);
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

  assert.throws(() => createTagMessage({
    directory: bundle,
    candidateSha: SHA,
    evidenceCommit: "b".repeat(40),
    repositoryUrl: "https://github.com/example/project",
    bundleRepositoryPath: `release-evidence/0.1.0/${SHA}`,
    git: (args) => {
      if (args[0] === "rev-parse") return Buffer.from(`${SHA}\n`);
      if (args[0] === "diff-tree") return Buffer.from("README.md\n");
      return Buffer.alloc(0);
    },
  }), /only the sealed evidence bundle/);

  fs.appendFileSync(path.join(bundle, "files", "local-node-22.log"), "tampered bundle\n");
  assert.throws(() => verifyEvidenceBundle({ directory: bundle, candidateSha: SHA }), /missing or has changed/);
});

test("release evidence rejects failed, stale, mismatched, and malformed local records", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-evidence-negative-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "evidence.json");
  const log = path.join(directory, "walkthrough.log");
  fs.writeFileSync(log, "observed walkthrough\n");
  initializeEvidence({ file, candidateSha: SHA });

  assert.throws(() => recordFileEvidence({
    file,
    candidateSha: SHA,
    cell: "local-node-22",
    command: "not executed",
    evidenceFile: path.join(directory, "missing.log"),
    status: "pass",
    node: "v22.18.0",
  }), /existing regular file/);
  assert.throws(() => recordFileEvidence({
    file,
    candidateSha: "b".repeat(40),
    cell: "local-node-22",
    command: "x",
    evidenceFile: log,
    status: "pass",
  }), /does not name/);
  assert.throws(() => recordFileEvidence({
    file,
    candidateSha: SHA,
    cell: "not-a-cell",
    command: "x",
    evidenceFile: log,
    status: "pass",
  }), /unknown release cell/);
  assert.throws(() => recordFileEvidence({
    file,
    candidateSha: SHA,
    cell: "archive",
    command: "archive",
    evidenceFile: log,
    status: "fail",
  }), /recorded a failed/);

  const complete = path.join(directory, "complete.json");
  initializeEvidence({ file: complete, candidateSha: SHA });
  recordAll({ directory, file: complete, evidenceFile: log });
  const wrongNode = JSON.parse(fs.readFileSync(complete, "utf8"));
  wrongNode.cells["local-node-24"].node = "v22.18.0";
  fs.writeFileSync(complete, `${JSON.stringify(wrongNode, null, 2)}\n`);
  assert.throws(() => verifyEvidence({ file: complete, candidateSha: SHA }), /Node 24\.x/);

  recordAll({ directory, file: complete, evidenceFile: log });
  const wrongPlatform = JSON.parse(fs.readFileSync(complete, "utf8"));
  wrongPlatform.cells["live-macos"].platform = "Windows 11";
  fs.writeFileSync(complete, `${JSON.stringify(wrongPlatform, null, 2)}\n`);
  assert.throws(() => verifyEvidence({ file: complete, candidateSha: SHA }), /exact platform/);

  recordAll({ directory, file: complete, evidenceFile: log });
  fs.appendFileSync(log, "tampered\n");
  assert.throws(() => verifyEvidence({ file: complete, candidateSha: SHA }), /missing or has changed/);
});
