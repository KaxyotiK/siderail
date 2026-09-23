import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  dockControl,
  dockControlRoot,
  dockConfigPath,
  findDockControl,
  findHerdrPlugin,
  readPackageInfo,
  setupCmux,
  setupHerdr,
  assertHerdrLinkedHere,
  uninstallCmux,
} from "../src/host-setup.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

function herdrWith(plugins, calls = []) {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (args.join(" ") === "plugin list --json") {
      return { stdout: JSON.stringify({ result: { plugins, type: "plugin_list" } }) };
    }
    return { stdout: JSON.stringify({ result: { type: "plugin_linked" } }) };
  };
}

function localPlugin(root, extra = {}) {
  return { plugin_id: "siderail", plugin_root: root, source: { kind: "local" }, enabled: true, version: "0.1.0", ...extra };
}

test("package info comes from the install's own package.json", () => {
  const info = readPackageInfo(path.resolve(import.meta.dirname, ".."));
  assert.equal(info.name, "siderail");
  assert.match(info.version, /^\d+\.\d+\.\d+/);
});

test("Herdr setup links once, is idempotent, and moves a stale local link", async () => {
  const calls = [];
  const environment = { HERDR_BIN_PATH: "herdr-test" };
  const linked = await setupHerdr({ root: "/pkg", environment, run: herdrWith([], calls) });
  assert.deepEqual(linked, { action: "linked", root: "/pkg", previousRoot: null });
  assert.deepEqual(calls.at(-1), ["herdr-test", "plugin", "link", "/pkg"]);

  const sameCalls = [];
  const unchanged = await setupHerdr({ root: "/pkg/", environment, run: herdrWith([localPlugin("/pkg")], sameCalls) });
  assert.equal(unchanged.action, "unchanged");
  assert.equal(sameCalls.some((call) => call.includes("link")), false);

  const moved = await setupHerdr({ root: "/new", environment, run: herdrWith([localPlugin("/old")]) });
  assert.deepEqual(moved, { action: "moved", root: "/new", previousRoot: "/old" });
});

test("Herdr setup refuses to replace a GitHub-managed install and rejects malformed listings", async () => {
  await assert.rejects(
    setupHerdr({ root: "/pkg", environment: {}, run: herdrWith([localPlugin("/managed", { source: { kind: "github" } })]) }),
    /already has a github siderail plugin/,
  );
  await assert.rejects(
    setupHerdr({ root: "/pkg", environment: {}, run: herdrWith([localPlugin(null, { source: null })]) }),
    /non-local siderail plugin/,
  );
  await assert.rejects(findHerdrPlugin({ environment: {}, run: async () => ({ stdout: "not json" }) }), /invalid JSON/);
  await assert.rejects(findHerdrPlugin({ environment: {}, run: async () => ({ stdout: "{\"result\":{}}" }) }), /no plugin array/);
});

test("Herdr plugin lookup normalizes unexpected field types", async () => {
  const plugin = await findHerdrPlugin({ environment: {}, run: herdrWith([{ plugin_id: "siderail", plugin_root: 7, enabled: false }]) });
  assert.deepEqual(plugin, { root: null, source: null, enabled: false, version: null });
  assert.equal(await findHerdrPlugin({ environment: {}, run: herdrWith([{ plugin_id: "other" }]) }), null);
});

test("Herdr ownership check only accepts a local link at this install", async () => {
  assert.equal(await assertHerdrLinkedHere({ root: "/pkg", environment: {}, run: herdrWith([]) }), false);
  assert.equal(await assertHerdrLinkedHere({ root: "/pkg", environment: {}, run: herdrWith([localPlugin("/pkg")]) }), true);
  await assert.rejects(
    assertHerdrLinkedHere({ root: "/pkg", environment: {}, run: herdrWith([localPlugin("/checkout")]) }),
    /belongs to \/checkout/,
  );
  await assert.rejects(
    assertHerdrLinkedHere({ root: "/pkg", environment: {}, run: herdrWith([localPlugin(null, { source: { kind: "github" } })]) }),
    /belongs to github/,
  );
  await assert.rejects(
    assertHerdrLinkedHere({ root: "/pkg", environment: {}, run: herdrWith([localPlugin(null, { source: null })]) }),
    /belongs to another install/,
  );
});

test("the Dock control quotes install paths for cmux's login shell", () => {
  const control = dockControl("/Users/o'neil/lib/node_modules/siderail");
  assert.equal(control.id, "siderail");
  assert.equal(
    control.command,
    "/bin/bash '/Users/o'\\''neil/lib/node_modules/siderail/scripts/cmux-node-launcher.sh' '/Users/o'\\''neil/lib/node_modules/siderail/scripts/cmux-siderail.mjs'",
  );
  assert.equal(dockControlRoot(dockControl("/opt/siderail")), "/opt/siderail");
  assert.equal(dockControlRoot({ id: "siderail", command: "siderail scripts/cmux-siderail.mjs" }), null);
  assert.equal(dockControlRoot({ id: "other", command: dockControl("/opt/siderail").command }), null);
  assert.equal(dockControlRoot(null), null);
});

test("the global Dock config lives under HOME", () => {
  assert.equal(dockConfigPath({ HOME: "/home/example" }), "/home/example/.config/cmux/dock.json");
  assert.throws(() => dockConfigPath({}), /HOME is not set/);
});

test("cmux setup creates, preserves, updates, and removes only its own control", (t) => {
  const { environment, home } = hermeticEnvironment(t);
  const configPath = path.join(home, ".config", "cmux", "dock.json");
  assert.deepEqual(findDockControl({ environment }), { configPath, control: null });

  const added = setupCmux({ root: "/pkg", environment });
  assert.equal(added.action, "added");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).controls, [dockControl("/pkg")]);

  const existing = {
    theme: "keep-me",
    controls: [{ id: "tests", title: "Tests", command: "npm test" }, { ...dockControl("/old"), height: 400 }],
  };
  fs.writeFileSync(configPath, JSON.stringify(existing));
  fs.chmodSync(configPath, 0o600);
  const updated = setupCmux({ root: "/pkg", environment });
  assert.equal(updated.action, "updated");
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(written.theme, "keep-me");
  assert.deepEqual(written.controls[0], existing.controls[0]);
  assert.deepEqual(written.controls[1], { ...dockControl("/pkg"), height: 400 });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(configPath)).length, 1);

  assert.equal(setupCmux({ root: "/pkg", environment }).action, "unchanged");
  assert.equal(findDockControl({ environment }).control.height, 400);

  assert.equal(uninstallCmux({ environment }).action, "removed");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).controls, [existing.controls[0]]);
  assert.equal(uninstallCmux({ environment }).action, "absent");
});

test("cmux setup never overwrites an unrelated control or malformed config", (t) => {
  const { environment, home } = hermeticEnvironment(t);
  const configPath = path.join(home, ".config", "cmux", "dock.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  assert.equal(uninstallCmux({ environment }).action, "absent");

  const foreign = JSON.stringify({ controls: [{ id: "siderail", command: "something-else" }] });
  fs.writeFileSync(configPath, foreign);
  assert.throws(() => setupCmux({ root: "/pkg", environment }), /does not launch SideRail; rename or remove it/);
  assert.throws(() => uninstallCmux({ environment }), /does not launch SideRail; leaving it in place/);
  assert.equal(fs.readFileSync(configPath, "utf8"), foreign);

  for (const [text, message] of [
    ["{ not json", /is not valid JSON/],
    ["[]", /must contain a JSON object/],
    ["{\"controls\":{}}", /non-array "controls"/],
  ]) {
    fs.writeFileSync(configPath, text);
    assert.throws(() => setupCmux({ root: "/pkg", environment }), message);
    assert.equal(fs.readFileSync(configPath, "utf8"), text);
  }

  fs.writeFileSync(configPath, "{\"theme\":\"dark\"}");
  assert.equal(setupCmux({ root: "/pkg", environment }).action, "added");
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).theme, "dark");
});

test("cmux config read errors other than a missing file surface", (t) => {
  const { environment, home } = hermeticEnvironment(t);
  const configPath = path.join(home, ".config", "cmux", "dock.json");
  fs.mkdirSync(configPath, { recursive: true });
  assert.throws(() => findDockControl({ environment }), /EISDIR/);
});
