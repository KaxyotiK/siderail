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
  assert.match(readme, /macOS or Linux/);
  assert.doesNotMatch(releasing, /record-ci|gh workflow|gh run/);
  assert.match(releasing, /record-file/);
  assert.match(releasing, /All eight required/);
  assert.match(releasing, /verify-bundle/);
  assert.match(releasing, /evidence-only direct-child commit/);
  assert.doesNotMatch(releasing, /tag-message --file/);
  assert.match(releasing, /separate explicit\s+authorization/);
  await assert.rejects(() => fs.access(".github/workflows"), (error) => error.code === "ENOENT");
  const bashBlocks = [...releasing.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(bashBlocks.length > 0);
  assert.ok(bashBlocks.every((block) => block.startsWith("set -euo pipefail\n")));
});

test("the default local check enforces coverage", async () => {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
  assert.match(packageJson.scripts.check, /test:coverage/);
});

test("live release cleanup is isolated from the operator's Herdr installation", async () => {
  const wrapper = await fs.readFile("scripts/run-isolated-live-smoke.sh", "utf8");
  assert.match(wrapper, /unset HERDR_ENV HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID/);
  assert.match(wrapper, /XDG_CONFIG_HOME="\$mode_root\/c"/);
  assert.match(wrapper, /HERDR_SESSION="gr\$\{mode_key\}\$\{\$\}"/);
  assert.match(wrapper, /GIT_RAIL_LIVE_GIT_SHIM="\$release_bin\/git"/);
  assert.doesNotMatch(wrapper, /GIT_RAIL_LIVE_GIT_SHIM=\$git_bin/);
});

test("sealed release logs are not hidden by the general log ignore", async () => {
  const ignore = await fs.readFile(".gitignore", "utf8");
  assert.match(ignore, /^\*\.log$/m);
  assert.match(ignore, /^!release-evidence\/\*\*\/\*\.log$/m);
});
