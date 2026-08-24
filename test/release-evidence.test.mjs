import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTagMessage, initializeEvidence, recordEvidence, REQUIRED_RELEASE_CELLS, verifyEvidence } from "../scripts/release-evidence.mjs";
import { validateArchiveMembers } from "../scripts/verify-archive-members.mjs";

const SHA = "a".repeat(40);

test("archive member verification rejects local-only and removed artifacts", () => {
  const required = "herdr-plugin.toml\npackage.json\nscripts/uninstall-herdr-plugin.mjs\n";
  assert.equal(validateArchiveMembers(required).length, 3);
  assert.throws(() => validateArchiveMembers(`${required}node_modules/pkg/index.js\n`), /forbidden/);
  assert.throws(() => validateArchiveMembers(`${required}.git-rail.json\n`), /forbidden/);
  assert.throws(() => validateArchiveMembers(`${required}schema/v1/config.json\n`), /forbidden/);
});

test("release evidence binds every required cell and the tag message to one SHA", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gitrail-evidence-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "evidence.json");
  initializeEvidence({ file, candidateSha: SHA, now: "2026-08-23T00:00:00.000Z" });
  assert.throws(() => verifyEvidence({ file, candidateSha: SHA }), /incomplete/);
  for (const cell of REQUIRED_RELEASE_CELLS) {
    recordEvidence({
      file,
      candidateSha: SHA,
      cell,
      command: `verify ${cell}`,
      evidence: `https://example.test/${cell}`,
      platform: cell.startsWith("live-") ? cell.slice(5) : undefined,
      node: cell.startsWith("live-") ? "v22.18.0" : undefined,
      herdr: cell.startsWith("live-") ? "0.8.2" : undefined,
    });
  }
  assert.equal(verifyEvidence({ file, candidateSha: SHA }).candidateSha, SHA);
  const tagMessage = createTagMessage({ file, candidateSha: SHA });
  assert.match(tagMessage, new RegExp(`Validated candidate: ${SHA}`));
  assert.match(tagMessage, /Evidence SHA-256: [0-9a-f]{64}/);
  assert.throws(() => recordEvidence({ file, candidateSha: "b".repeat(40), cell: "local", command: "x", evidence: "y" }), /does not match/);
});
