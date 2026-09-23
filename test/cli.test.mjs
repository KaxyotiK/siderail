import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../scripts/cli.mjs";
import { ProcessError } from "../src/process.mjs";
import { dockControl, readPackageInfo } from "../src/host-setup.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = readPackageInfo(ROOT).version;

function fakeHerdr({ plugins = [], missing = false } = {}) {
  const calls = [];
  const state = { plugins: [...plugins] };
  const run = async (command, args) => {
    calls.push(args.join(" "));
    if (missing) throw new ProcessError(`${command} is not installed`, { kind: "missing-executable" });
    if (args.join(" ") === "plugin list --json") {
      return { stdout: JSON.stringify({ result: { plugins: state.plugins } }) };
    }
    if (args[0] === "plugin" && args[1] === "link") {
      state.plugins = [{ plugin_id: "siderail", plugin_root: args[2], source: { kind: "local" }, enabled: true, version: VERSION }];
    }
    return { stdout: "{\"result\":{}}" };
  };
  return { run, calls, state };
}

function harness(t, { herdr = fakeHerdr(), cmux = false, root = ROOT } = {}) {
  const { environment, home } = hermeticEnvironment(t, { PATH: "/nonexistent" });
  if (cmux) fs.mkdirSync(path.join(home, ".config", "cmux"), { recursive: true });
  const output = [];
  const uninstalled = [];
  const options = {
    root,
    environment,
    run: herdr.run,
    write: (text) => output.push(text),
    // Confine host detection to the hermetic root; the real machine may have cmux.
    exists: (candidate) => candidate.startsWith(path.dirname(home)) && fs.existsSync(candidate),
    uninstallHerdr: async ({ pluginRoot }) => {
      uninstalled.push(pluginRoot);
      herdr.state.plugins = [];
      return { pluginId: "siderail", closedPaneIds: ["w1:p2"] };
    },
  };
  const dockPath = path.join(home, ".config", "cmux", "dock.json");
  return { options, output, uninstalled, dockPath, text: () => output.join("") };
}

test("help and version need no host", async (t) => {
  const { options, text } = harness(t);
  assert.equal(await main([], options), 0);
  assert.match(text(), /Usage: siderail <command>/);
  for (const flag of ["version", "--version", "-v"]) {
    const run = harness(t);
    assert.equal(await main([flag], run.options), 0);
    assert.equal(run.text(), `${VERSION}\n`);
  }
  for (const flag of ["help", "--help", "-h"]) {
    const run = harness(t);
    await main([flag], run.options);
    assert.match(run.text(), /siderail setup|setup \[herdr\] \[cmux\]/);
  }
});

test("unknown commands and hosts fail with usage", async (t) => {
  const run = harness(t);
  await assert.rejects(main(["bogus"], run.options), /unknown command "bogus"/);
  assert.match(run.text(), /Usage:/);
  await assert.rejects(main(["setup", "tmux"], harness(t).options), /unknown host "tmux"/);
});

test("setup with no host registers every detected host", async (t) => {
  const herdr = fakeHerdr();
  const run = harness(t, { herdr, cmux: true });
  assert.equal(await main(["setup"], run.options), 0);
  assert.ok(herdr.calls.includes(`plugin link ${ROOT}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(run.dockPath, "utf8")).controls, [dockControl(ROOT)]);
  assert.match(run.text(), /Herdr: linked plugin siderail/);
  assert.match(run.text(), /siderail\.toggle-siderail/);
  assert.match(run.text(), /cmux: added the SideRail Dock control/);

  const again = harness(t, { herdr, cmux: true });
  again.options.environment = run.options.environment;
  await main(["setup", "herdr", "cmux", "herdr"], again.options);
  assert.match(again.text(), /already linked to this install/);
  assert.match(again.text(), /already points at this install/);
  assert.doesNotMatch(again.text(), /Bind a toggle key|reload/);
});

test("setup skips missing hosts, and fails when none is found", async (t) => {
  const onlyHerdr = harness(t);
  await main(["setup"], onlyHerdr.options);
  assert.match(onlyHerdr.text(), /cmux: not found, skipped/);

  const onlyCmux = harness(t, { herdr: fakeHerdr({ missing: true }), cmux: true });
  await main(["setup"], onlyCmux.options);
  assert.match(onlyCmux.text(), /Herdr: not found, skipped/);
  assert.ok(fs.existsSync(onlyCmux.dockPath));

  const neither = harness(t, { herdr: fakeHerdr({ missing: true }) });
  await assert.rejects(main(["setup"], neither.options), /found neither Herdr nor cmux/);
  await assert.rejects(main(["setup", "herdr"], harness(t, { herdr: fakeHerdr({ missing: true }) }).options), /herdr is not installed/);
});

test("cmux is detected from PATH or the macOS application", async (t) => {
  const onPath = harness(t);
  const bin = path.join(path.dirname(onPath.options.environment.HOME), "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cmux"), "");
  onPath.options.environment.PATH = bin;
  await main(["setup"], onPath.options);
  assert.match(onPath.text(), /cmux: added/);

  const app = harness(t);
  app.options.exists = (candidate) => candidate === "/Applications/cmux.app";
  await main(["setup"], app.options);
  assert.match(app.text(), /cmux: added/);

  const noHome = harness(t);
  delete noHome.options.environment.HOME;
  noHome.options.environment.PATH = "";
  await main(["setup", "herdr"], noHome.options);
  assert.match(noHome.text(), /Herdr: linked/);
});

test("setup reports a moved Herdr link and an updated Dock control", async (t) => {
  const herdr = fakeHerdr({ plugins: [{ plugin_id: "siderail", plugin_root: "/old", source: { kind: "local" } }] });
  const run = harness(t, { herdr, cmux: true });
  fs.writeFileSync(run.dockPath, JSON.stringify({ controls: [dockControl("/old")] }));
  await main(["setup"], run.options);
  assert.match(run.text(), new RegExp(`moved from /old to ${ROOT.replaceAll("/", "\\/")}`));
  assert.match(run.text(), /cmux: updated the SideRail Dock control/);
});

test("status reports each host, including stale and missing registrations", async (t) => {
  const fresh = harness(t);
  await main(["status"], fresh.options);
  assert.match(fresh.text(), new RegExp(`SideRail ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(fresh.text(), /herdr: +not set up/);
  assert.match(fresh.text(), /cmux: +not set up/);

  const missing = harness(t, { herdr: fakeHerdr({ missing: true }) });
  await main(["status"], missing.options);
  assert.match(missing.text(), /herdr: +not found/);

  const herdr = fakeHerdr({ plugins: [{ plugin_id: "siderail", plugin_root: "/old", source: { kind: "local" }, enabled: false }] });
  const stale = harness(t, { herdr });
  fs.mkdirSync(path.dirname(stale.dockPath), { recursive: true });
  fs.writeFileSync(stale.dockPath, JSON.stringify({ controls: [dockControl("/old")] }));
  await main(["status"], stale.options);
  assert.match(stale.text(), /local plugin siderail at \/old \(disabled\) — stale/);
  assert.match(stale.text(), /Dock control points at \/old — stale/);

  const current = harness(t, { cmux: true });
  await main(["setup"], current.options);
  current.output.length = 0;
  await main(["status"], current.options);
  assert.match(current.text(), new RegExp(`plugin siderail ${VERSION.replaceAll(".", "\\.")} at this install\\n`));
  assert.match(current.text(), /Dock control at this install/);

  const unknownRoot = harness(t, { herdr: fakeHerdr({ plugins: [{ plugin_id: "siderail", source: { kind: "github" } }] }) });
  fs.mkdirSync(path.dirname(unknownRoot.dockPath), { recursive: true });
  fs.writeFileSync(unknownRoot.dockPath, JSON.stringify({ controls: [{ id: "siderail", command: "run scripts/cmux-siderail.mjs" }] }));
  await main(["status"], unknownRoot.options);
  assert.match(unknownRoot.text(), /github plugin siderail at unknown path/);
  assert.match(unknownRoot.text(), /points at another command/);
});

test("uninstall removes only registrations that belong to this install", async (t) => {
  const run = harness(t, { cmux: true });
  await main(["setup"], run.options);
  run.output.length = 0;
  await main(["uninstall"], run.options);
  assert.deepEqual(run.uninstalled, [ROOT]);
  assert.match(run.text(), /Herdr: unlinked siderail; closed 1 verified SideRail pane/);
  assert.match(run.text(), /cmux: removed the SideRail Dock control/);

  run.output.length = 0;
  await main(["uninstall"], run.options);
  assert.match(run.text(), /Herdr: plugin siderail is not installed/);
  assert.match(run.text(), /cmux: no SideRail Dock control is configured/);

  const herdr = fakeHerdr({ plugins: [{ plugin_id: "siderail", plugin_root: "/checkout", source: { kind: "local" } }] });
  const foreign = harness(t, { herdr });
  fs.mkdirSync(path.dirname(foreign.dockPath), { recursive: true });
  fs.writeFileSync(foreign.dockPath, JSON.stringify({ controls: [dockControl("/checkout")] }));
  await main(["uninstall"], foreign.options);
  assert.deepEqual(foreign.uninstalled, []);
  assert.match(foreign.text(), /Herdr: plugin siderail belongs to \/checkout, left in place/);
  assert.match(foreign.text(), /cmux: Dock control belongs to \/checkout, left in place/);
  await assert.rejects(main(["uninstall", "herdr"], foreign.options), /belongs to \/checkout, not/);

  const noHerdr = harness(t, { herdr: fakeHerdr({ missing: true }) });
  await main(["uninstall"], noHerdr.options);
  await assert.rejects(main(["uninstall", "herdr"], noHerdr.options), /herdr is not installed/);
});

test("explicit cmux uninstall removes a control from another install", async (t) => {
  const run = harness(t);
  fs.mkdirSync(path.dirname(run.dockPath), { recursive: true });
  fs.writeFileSync(run.dockPath, JSON.stringify({ controls: [dockControl("/checkout")] }));
  await main(["uninstall", "cmux"], run.options);
  assert.deepEqual(JSON.parse(fs.readFileSync(run.dockPath, "utf8")).controls, []);
});

test("Herdr failures other than a missing executable propagate", async (t) => {
  const run = harness(t, {
    herdr: { run: async () => { throw new ProcessError("server exploded", { kind: "exit" }); }, calls: [], state: {} },
  });
  await assert.rejects(main(["status"], run.options), /server exploded/);
});

test("the installed bin runs through a symlink and reports errors on stderr", (t) => {
  const { environment, root } = hermeticEnvironment(t);
  const link = path.join(root, "siderail");
  fs.symlinkSync(path.join(ROOT, "scripts", "cli.mjs"), link);
  const version = spawnSync(process.execPath, [link, "--version"], { env: environment, encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${VERSION}\n`);
  const failure = spawnSync(process.execPath, [link, "nope"], { env: environment, encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /^siderail: unknown command "nope"/m);
});

test("the bin exits cleanly when its reader closes the pipe early", (t) => {
  const { environment } = hermeticEnvironment(t);
  const result = spawnSync("/bin/bash", ["-c", `"${process.execPath}" "$1" help | (exec 0<&-; sleep 0.2); echo "status=\${PIPESTATUS[0]}"`, "bash", path.join(ROOT, "scripts", "cli.mjs")], {
    env: environment,
    encoding: "utf8",
  });
  assert.match(result.stdout, /status=0/);
  assert.doesNotMatch(result.stderr, /EPIPE/);
});
