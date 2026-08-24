import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("security policy has no fictional contact or response-time promise", async () => {
  const policy = await fs.readFile("SECURITY.md", "utf8");
  assert.doesNotMatch(policy, /security@|within \d+ (?:hours|days)|acknowledge within|private advisory/i);
  assert.match(policy, /does not currently advertise a security\s+reporting channel/);
  assert.match(policy, /Repository contents never control GitRail configuration/);
});

test("documentation states the eventual refresh and user-only configuration contracts", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  assert.match(readme, /refresh is intentionally eventually consistent/);
  assert.match(readme, /built-in defaults/);
  assert.match(readme, /~\/\.config\/git-rail\/config\.json/);
  assert.match(readme, /GIT_RAIL_\*/);
  assert.match(readme, /Untracked is a separate section/);
  await assert.rejects(() => fs.access("schema/v1/git-rail.schema.json"), (error) => error.code === "ENOENT");
});

test("public installation and release evidence instructions enforce the candidate gates", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  const releasing = await fs.readFile("docs/RELEASING.md", "utf8");
  const install = readme.slice(readme.indexOf("## Install and launch"), readme.indexOf("## Configuration"));
  assert.ok(install.indexOf("npm ci --ignore-scripts") < install.indexOf("herdr plugin link ."));
  assert.ok(install.indexOf("npm run check") < install.indexOf("herdr plugin link ."));
  assert.match(readme, /Herdr 0\.8\.x/);
  assert.match(readme, /macOS 15 or Ubuntu 24\.04/);
  assert.doesNotMatch(releasing, /release:evidence -- record(?:\s|$)/);
  assert.match(releasing, /record-ci/);
  assert.match(releasing, /record-file/);
  assert.match(releasing, /all 16 required/);
  assert.match(releasing, /verify-bundle/);
  assert.match(releasing, /evidence-only direct-child commit/);
  assert.doesNotMatch(releasing, /tag-message --file/);
  assert.match(releasing, /separate explicit\s+authorization/);
  const bashBlocks = [...releasing.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(bashBlocks.length > 0);
  assert.ok(bashBlocks.every((block) => block.startsWith("set -euo pipefail\n")));
});
