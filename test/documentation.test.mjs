import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("security policy directs reports to the repository's private reporting channel", async () => {
  const policy = await fs.readFile("SECURITY.md", "utf8");
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
  const repositoryUrl = packageJson.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  assert.ok(policy.includes(`](${repositoryUrl}/security/advisories/new)`));
  assert.doesNotMatch(policy, /security@|within \d+ (?:hours|days)|acknowledge within/i);
  assert.doesNotMatch(policy, /private pre-release repository|does not currently advertise a security/i);
  assert.match(policy, /Repository contents never control SideRail configuration/);
});

test("documentation states the eventual refresh and user-only configuration contracts", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  assert.match(readme, /refresh is intentionally eventually consistent/);
  assert.match(readme, /built-in defaults/);
  assert.match(readme, /~\/\.config\/siderail\/config\.json/);
  assert.match(readme, /SIDERAIL_\*/);
  assert.match(readme, /git config --local 'branch\.feature\/my-work\.siderail-base'/);
  assert.match(readme, /git config --worktree --unset-all 'branch\.feature\/my-work\.siderail-base'/);
  assert.match(readme, /Untracked is a separate section/);
  await assert.rejects(() => fs.access("schema/v1/siderail.schema.json"), (error) => error.code === "ENOENT");
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
  assert.match(releasing, /for live_cell in live-macos live-linux/);
  assert.match(releasing, /live-macos-handoff/);
  assert.match(releasing, /live-linux-handoff/);
  assert.match(releasing, /does not read or write the\s+coordinator evidence manifest/);
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

test("cmux documentation and project Dock config describe the supported right-sidebar host", async () => {
  const guide = await fs.readFile("docs/CMUX.md", "utf8");
  const dock = JSON.parse(await fs.readFile(".cmux/dock.json", "utf8"));
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
  assert.match(guide, /right sidebar Dock/);
  assert.match(guide, /does not use the\s+left\/custom-sidebar interpreter, ExtensionKit/);
  assert.match(guide, /CMUX_WORKSPACE_ID/);
  assert.match(guide, /CMUX_SURFACE_ID/);
  assert.match(guide, /CMUX_DOCK_CONTROL_ID/);
  assert.match(guide, /CMUX_DOCK_CONTROL_TITLE/);
  assert.match(guide, /current_directory/);
  assert.match(guide, /cmux choose its Markdown, image, PDF, media, or\s+general file viewer/);
  assert.match(guide, /`cmux open`/);
  assert.match(guide, /`cmux open` as a native file tab/);
  assert.match(guide, /ambient\s+`CMUX_SURFACE_ID` is cleared/);
  assert.match(guide, /process-backed active\s+instance and stable control\/surface identity/);
  assert.match(guide, /relaunches SideRail in the same verified Dock terminal/);
  assert.match(guide, /Staged · Index · read-only/);
  assert.match(guide, /before deletion/);
  assert.match(guide, /stable SideRail\s+Dock control identity/);
  assert.match(guide, /Opening file B never closes or\s+reuses the tab previously opened for file A/);
  assert.match(guide, /retried on the next\s+preview open/);
  assert.match(guide, /migrates surface-keyed and replacement-era ownership records/);
  assert.match(guide, /owned by the cmux \*\*window\*\* that contains its Dock\s+surface/);
  assert.match(guide, /cmux reports `caller: null` for a Dock surface/);
  assert.match(guide, /the owner is the window whose `list-panels` output contains\s+that surface/);
  assert.match(guide, /owner\s+window id is deliberately excluded from the resume command/);
  assert.match(guide, /prefers the first candidate\s+that is inside a repository/);
  assert.match(guide, /Herdr identity variables and `HERDR_PLUGIN_CONTEXT_JSON` are read only under the\s+Herdr host/);
  assert.match(guide, /Ownership is the pair of Dock surface and control id/);
  assert.match(guide, /registers once at startup rather than on every refresh/);
  assert.match(guide, /a recorded process being dead is never a reason to remove\s+a record/);
  assert.match(guide, /pairs the id with the operating system's start time for it, read in a fixed\s+locale and time zone/);
  assert.match(guide, /A version 3\s+record without that marker is not valid/);
  assert.match(guide, /Migration publishes without clobbering/);
  assert.match(guide, /legacy records are removed only when this migration published the\s+record that is now canonical/);
  assert.match(guide, /falls back\s+to the bounded refresh poll/);
  assert.deepEqual(dock.controls.map(({ id, title, cwd }) => ({ id, title, cwd })), [
    { id: "siderail", title: "SideRail", cwd: "." },
  ]);
  assert.match(dock.controls[0].command, /scripts\/cmux-node-launcher\.sh/);
  assert.match(dock.controls[0].command, /scripts\/cmux-siderail\.mjs/);
  assert.match(packageJson.scripts["cmux:launch"], /open-cmux-dock\.mjs/);
});

test("live release cleanup is isolated from the operator's Herdr installation", async () => {
  const wrapper = await fs.readFile("scripts/run-isolated-live-smoke.sh", "utf8");
  assert.match(wrapper, /unset HERDR_ENV HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID/);
  assert.match(wrapper, /XDG_CONFIG_HOME="\$mode_root\/c"/);
  assert.match(wrapper, /HERDR_SESSION="gr\$\{mode_key\}\$\{\$\}"/);
  assert.match(wrapper, /SIDERAIL_LIVE_GIT_SHIM="\$release_bin\/git"/);
  assert.doesNotMatch(wrapper, /SIDERAIL_LIVE_GIT_SHIM=\$git_bin/);
});

test("sealed release logs are not hidden by the general log ignore", async () => {
  const ignore = await fs.readFile(".gitignore", "utf8");
  assert.match(ignore, /^\*\.log$/m);
  assert.match(ignore, /^!release-evidence\/\*\*\/\*\.log$/m);
});

test("sealed evidence is excluded from later archives and preserves terminal bytes", async () => {
  const attributes = await fs.readFile(".gitattributes", "utf8");
  assert.match(attributes, /^\/release-evidence\/ export-ignore$/m);
  assert.match(attributes, /^\/release-evidence\/\*\*\/\*\.log -whitespace$/m);
});
