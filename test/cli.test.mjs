import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../scripts/cli.mjs";
import { ProcessError } from "../src/process.mjs";
import { dockControl, readPackageInfo } from "../src/host-setup.mjs";
import { herdrConfigPath } from "../src/herdr-toggle-key.mjs";
import { railTargetPath, readRailTarget } from "../src/rail-target.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = readPackageInfo(ROOT).version;

// Stands in for `herdr config check`: a key bound twice is a conflict, and an
// array of tables cannot extend an inline keys.command array.
function checkConfig(text) {
  if (/^\s*keys\.command\s*=\s*\[/m.test(text) && text.includes("[[keys.command]]")) {
    return { exitCode: 1, stdout: "Config: issues found\nduplicate key `command` in table `keys`\n" };
  }
  const keys = [...text.matchAll(/^\s*[\w.]+\s*=\s*"(ctrl\+[^"]+)"/gm)].map((match) => match[1]);
  if (/=\s*\d+\s*$/m.test(text)) return { exitCode: 1, stdout: "Config: issues found\ninvalid type: integer, expected a string\n" };
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  return repeated
    ? { exitCode: 1, stdout: `Config: issues found\n${repeated}: kept keys.new_tab, disabled keys.command[0].key\n` }
    : { exitCode: 0, stdout: "Config: ok\n" };
}

function fakeHerdr({ plugins = [], missing = false } = {}) {
  const calls = [];
  const state = { plugins: [...plugins] };
  const run = async (command, args, options = {}) => {
    calls.push(args.join(" "));
    if (missing) throw new ProcessError(`${command} is not installed`, { kind: "missing-executable" });
    if (args.join(" ") === "config check") {
      const configPath = options.env.HERDR_CONFIG_PATH;
      await state.onCheck?.(configPath);
      if (state.checkError) throw state.checkError;
      return checkConfig(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "");
    }
    if (args.join(" ") === "server reload-config") {
      state.reloadEnvironments = [...(state.reloadEnvironments || []), options.env];
      if (state.reloadFails) throw new ProcessError("herdr server is not running", { kind: "exit" });
    }
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
  const herdrConfig = herdrConfigPath(environment);
  return { options, output, uninstalled, dockPath, herdrConfig, text: () => output.join("") };
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
  assert.match(run.text(), /Herdr: toggle key ctrl\+shift\+g added to/);
  assert.match(fs.readFileSync(run.herdrConfig, "utf8"), /key = "ctrl\+shift\+g"\ntype = "plugin_action"\ncommand = "siderail\.toggle-siderail"/);
  assert.ok(herdr.calls.includes("server reload-config"));
  assert.match(run.text(), /cmux: added the SideRail Dock control/);

  const again = harness(t, { herdr, cmux: true });
  again.options.environment = run.options.environment;
  await main(["setup", "herdr", "cmux", "herdr"], again.options);
  assert.match(again.text(), /already linked to this install/);
  assert.match(again.text(), /already points at this install/);
  assert.doesNotMatch(again.text(), /toggle key|reload/);
  assert.equal(fs.readFileSync(run.herdrConfig, "utf8").match(/siderail\.toggle-siderail/g).length, 1);
});

function writeConfig(run, text) {
  fs.mkdirSync(path.dirname(run.herdrConfig), { recursive: true });
  fs.writeFileSync(run.herdrConfig, text);
}

function temporaryFiles(file) {
  return fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".siderail-"));
}

const GENERATED = [
  "# Added by `siderail setup`; `siderail uninstall` removes it.",
  "[[keys.command]]",
  "key = \"ctrl+shift+g\"",
  "type = \"plugin_action\"",
  "command = \"siderail.toggle-siderail\"",
  "description = \"toggle SideRail sidebar\"",
  "",
].join("\n");

test("setup leaves Herdr's config alone when Herdr rejects the key or the config is broken", async (t) => {
  const taken = harness(t);
  const existing = "[keys]\nnew_tab = \"ctrl+shift+g\"\n";
  writeConfig(taken, existing);
  await main(["setup", "herdr"], taken.options);
  assert.equal(fs.readFileSync(taken.herdrConfig, "utf8"), existing);
  assert.match(taken.text(), /Herdr rejected the changed [\s\S]*kept keys\.new_tab[\s\S]*Bind "siderail\.toggle-siderail" to another key/);
  assert.deepEqual(temporaryFiles(taken.herdrConfig), []);

  const broken = harness(t);
  writeConfig(broken, "[ui]\nagent_panel_sort = 5\n");
  await main(["setup", "herdr"], broken.options);
  assert.equal(fs.readFileSync(broken.herdrConfig, "utf8"), "[ui]\nagent_panel_sort = 5\n");
  assert.match(broken.text(), /has issues, so no toggle key was added/);
});

test("setup recognizes existing bindings and declines what it cannot extend", async (t) => {
  const cases = [
    ["own key", "[[keys.command]]\nkey = \"ctrl+g\"\ntype = \"plugin_action\"\ncommand = \"siderail.toggle-siderail\"\n", /^Herdr: linked plugin siderail\n  Open it with: [^\n]+\n$/],
    ["inline array", "keys.command = [\n  { key = \"ctrl+h\", type = \"shell\", command = \"htop\" },\n]\n", /inline array, which setup does not edit/],
    ["inline binding", "[keys]\ncommand = [{ key = \"ctrl+g\", type = \"plugin_action\", command = \"siderail.toggle-siderail\" }]\n", /mentions "siderail\.toggle-siderail" outside a plugin_action key binding/],
    ["shell command", "[[keys.command]]\nkey = \"ctrl+g\"\ntype = \"shell\"\ncommand = \"siderail.toggle-siderail\"\n", /outside a plugin_action key binding/],
    ["unterminated string", "[ui]\nlabel = \"open\n", /could not classify the contents/],
  ];
  for (const [label, text, message] of cases) {
    const run = harness(t);
    writeConfig(run, text);
    await main(["setup", "herdr"], run.options);
    assert.equal(fs.readFileSync(run.herdrConfig, "utf8"), text, label);
    assert.match(run.text(), message, label);
  }
});

test("setup never commits an unvalidated candidate", async (t) => {
  const thrown = harness(t);
  writeConfig(thrown, "[ui]\nagent_panel_sort = \"priority\"\n");
  thrown.options.run = async (command, args, options) => {
    if (args.join(" ") === "config check" && options.env.HERDR_CONFIG_PATH !== thrown.herdrConfig) {
      throw new ProcessError("herdr timed out", { kind: "timeout" });
    }
    return fakeHerdr().run(command, args, options);
  };
  await main(["setup", "herdr"], thrown.options);
  assert.equal(fs.readFileSync(thrown.herdrConfig, "utf8"), "[ui]\nagent_panel_sort = \"priority\"\n");
  assert.match(thrown.text(), /"herdr config check" did not run[\s\S]*herdr timed out/);
  assert.deepEqual(temporaryFiles(thrown.herdrConfig), []);

  const absent = harness(t);
  absent.options.run = thrown.options.run;
  await main(["setup", "herdr"], absent.options);
  assert.equal(fs.existsSync(absent.herdrConfig), false);
});

test("an edit made while Herdr checks the candidate survives", async (t) => {
  for (const initial of ["[ui]\nagent_panel_sort = \"priority\"\n", null]) {
    const herdr = fakeHerdr();
    const run = harness(t, { herdr });
    if (initial !== null) writeConfig(run, initial);
    const edited = "[ui]\nagent_panel_sort = \"name\"\n";
    herdr.state.onCheck = (configPath) => {
      if (configPath === run.herdrConfig) return;
      fs.mkdirSync(path.dirname(run.herdrConfig), { recursive: true });
      fs.writeFileSync(run.herdrConfig, edited);
    };
    await main(["setup", "herdr"], run.options);
    assert.equal(fs.readFileSync(run.herdrConfig, "utf8"), edited);
    assert.match(run.text(), /changed while SideRail was editing it/);
    assert.deepEqual(temporaryFiles(run.herdrConfig), []);
  }
});

test("setup and uninstall edit a symlinked config in place and keep its mode", async (t) => {
  const run = harness(t);
  const real = path.join(path.dirname(path.dirname(run.herdrConfig)), "dotfiles", "herdr.toml");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "[ui]\nagent_panel_sort = \"priority\"\n", { mode: 0o600 });
  fs.mkdirSync(path.dirname(run.herdrConfig), { recursive: true });
  fs.symlinkSync(real, run.herdrConfig);

  await main(["setup", "herdr"], run.options);
  assert.ok(fs.lstatSync(run.herdrConfig).isSymbolicLink());
  assert.ok(fs.readFileSync(real, "utf8").endsWith(GENERATED));
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.deepEqual([...temporaryFiles(real), ...temporaryFiles(run.herdrConfig)], []);

  await main(["uninstall", "herdr"], run.options);
  assert.ok(fs.lstatSync(run.herdrConfig).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), "[ui]\nagent_panel_sort = \"priority\"\n");
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);

  const dangling = harness(t);
  fs.mkdirSync(path.dirname(dangling.herdrConfig), { recursive: true });
  fs.symlinkSync(path.join(path.dirname(dangling.herdrConfig), "missing.toml"), dangling.herdrConfig);
  await main(["setup", "herdr"], dangling.options);
  assert.match(dangling.text(), /symbolic link to a missing file/);
  assert.equal(fs.existsSync(path.join(path.dirname(dangling.herdrConfig), "missing.toml")), false);
});

test("uninstall removes the toggle key setup added and keeps anything edited or embedded", async (t) => {
  const run = harness(t);
  writeConfig(run, "[ui]\nagent_panel_sort = \"priority\"\n");
  await main(["setup", "herdr"], run.options);
  fs.appendFileSync(run.herdrConfig, "\n[[keys.command]]\nkey = \"ctrl+h\"\ntype = \"shell\"\ncommand = \"htop\"\n");
  await main(["uninstall", "herdr"], run.options);
  assert.equal(fs.readFileSync(run.herdrConfig, "utf8"), "[ui]\nagent_panel_sort = \"priority\"\n\n[[keys.command]]\nkey = \"ctrl+h\"\ntype = \"shell\"\ncommand = \"htop\"\n");
  assert.match(run.text(), /removed the ctrl\+shift\+g toggle key/);

  const kept = [
    ["field after a blank line", `[ui]\nagent_panel_sort = "priority"\n\n${GENERATED}\nwidth = "80%"\n`],
    ["block inside a multiline command", `[[keys.command]]\nkey = "ctrl+shift+x"\ntype = "shell"\ncommand = """\ncat <<'TOML'\n${GENERATED}\nTOML\n"""\n`],
  ];
  for (const [label, text] of kept) {
    const edited = harness(t);
    writeConfig(edited, text);
    edited.options.uninstallHerdr = async () => ({ pluginId: "siderail", closedPaneIds: [] });
    await main(["uninstall", "herdr"], edited.options);
    assert.equal(fs.readFileSync(edited.herdrConfig, "utf8"), text, label);
    assert.match(edited.text(), /left your own "siderail\.toggle-siderail" key binding/, label);
  }
});

test("uninstall finishes removing the key after the plugin is gone and reports a failed reload", async (t) => {
  const herdr = fakeHerdr();
  const run = harness(t, { herdr });
  writeConfig(run, "[ui]\nagent_panel_sort = \"priority\"\n");
  herdr.state.reloadFails = true;
  await main(["setup", "herdr"], run.options);
  assert.match(run.text(), /toggle key ctrl\+shift\+g added[\s\S]*herdr server reload-config/);
  assert.equal(herdr.state.reloadEnvironments.at(-1), run.options.environment);

  herdr.state.plugins = [];
  run.output.length = 0;
  await main(["uninstall", "herdr"], run.options);
  assert.match(run.text(), /plugin siderail is not installed\nHerdr: removed the ctrl\+shift\+g toggle key[\s\S]*herdr server reload-config/);
  assert.equal(fs.readFileSync(run.herdrConfig, "utf8"), "[ui]\nagent_panel_sort = \"priority\"\n");
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

test("uninstall unlinks only the plugin id it verified, whatever HERDR_PLUGIN_ID says", async (t) => {
  const herdr = fakeHerdr({ plugins: [{ plugin_id: "siderail", plugin_root: ROOT, source: { kind: "local" } }] });
  const run = harness(t, { herdr });
  run.options.environment.HERDR_PLUGIN_ID = "another-plugin";
  run.options.environment.HERDR_BIN_PATH = "herdr-test";
  const calls = [];
  run.options.run = async (command, args, options) => {
    calls.push(args.join(" "));
    if (args.join(" ") === "pane list") return { stdout: JSON.stringify({ result: { panes: [] } }) };
    return herdr.run(command, args, options);
  };
  delete run.options.uninstallHerdr;
  await main(["uninstall", "herdr"], run.options);
  assert.deepEqual(calls.filter((call) => call.startsWith("plugin unlink")), ["plugin unlink siderail"]);
  assert.match(run.text(), /Herdr: unlinked siderail/);
});

test("default uninstall recognizes this install's control at a quoted path and leaves a quoted foreign one", async (t) => {
  const quotedRoot = "/Users/o'neil/lib/node_modules/siderail";
  const own = harness(t, { root: quotedRoot, herdr: fakeHerdr({ missing: true }) });
  fs.mkdirSync(path.dirname(own.dockPath), { recursive: true });
  fs.writeFileSync(own.dockPath, JSON.stringify({ controls: [dockControl(quotedRoot)] }));
  await main(["uninstall"], own.options);
  assert.match(own.text(), /cmux: removed the SideRail Dock control/);
  assert.deepEqual(JSON.parse(fs.readFileSync(own.dockPath, "utf8")).controls, []);

  const foreign = harness(t, { herdr: fakeHerdr({ missing: true }) });
  fs.mkdirSync(path.dirname(foreign.dockPath), { recursive: true });
  fs.writeFileSync(foreign.dockPath, JSON.stringify({ controls: [dockControl(quotedRoot)] }));
  await main(["uninstall"], foreign.options);
  assert.match(foreign.text(), /Dock control belongs to \/Users\/o'neil\/lib\/node_modules\/siderail, left in place/);
  assert.equal(JSON.parse(fs.readFileSync(foreign.dockPath, "utf8")).controls.length, 1);
});

function targetHarness(t) {
  const run = harness(t);
  const checkouts = path.join(path.dirname(run.options.environment.HOME), "checkouts");
  const checkout = (name) => { fs.mkdirSync(path.join(checkouts, name), { recursive: true }); return fs.realpathSync.native(path.join(checkouts, name)); };
  const snapshot = {
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }, { tab_id: "w1:t2", workspace_id: "w1" }],
    panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }],
    workspaces: [
      { workspace_id: "w1", label: "repo", number: 1, worktree: { repo_key: "/repo/.git", checkout_path: checkout("main") } },
      { workspace_id: "w4", label: "tier-relay", number: 4, worktree: { repo_key: "/repo/.git", checkout_path: checkout("tier-relay"), is_linked_worktree: true } },
    ],
  };
  run.options.environment.HERDR_PANE_ID = "w1:p1";
  run.options.run = async (command, args) => {
    if (command !== "git") throw new Error(`unexpected ${command}`);
    return { stdout: `${path.basename(args[1]) === "main" ? "main" : "feature/relay"}\n` };
  };
  run.options.readSnapshot = async () => snapshot;
  const targetFile = (tabId = "w1:t1") => railTargetPath({ workspaceId: "w1", tabId, environment: run.options.environment });
  return { ...run, checkout, targetFile };
}

test("target pins the caller's tab to an open worktree and --follow releases it", async (t) => {
  const run = targetHarness(t);
  assert.equal(await main(["target", "tier-relay"], run.options), 0);
  assert.deepEqual(readRailTarget(run.targetFile()), { workspaceId: "w4", label: "tier-relay", checkoutPath: run.checkout("tier-relay"), branch: "feature/relay" });
  assert.match(run.text(), /SideRail in w1:t1 now shows tier-relay/);

  await main(["target", "--list"], run.options);
  assert.match(run.text(), /\* tier-relay\tfeature\/relay\tw4\t/);
  await main(["target", "--follow"], run.options);
  assert.equal(readRailTarget(run.targetFile()), null);

  await main(["target", "feature/relay"], run.options);
  assert.equal(readRailTarget(run.targetFile()).label, "tier-relay");
  await main(["target", "--follow"], run.options);

  await main(["target", "repo", "--tab", "w1:t2"], run.options);
  assert.equal(readRailTarget(run.targetFile("w1:t2")).label, "repo");
  assert.equal(readRailTarget(run.targetFile()), null);
});

test("target lists worktrees as JSON for agents", async (t) => {
  const run = targetHarness(t);
  await main(["target", "--list", "--json"], run.options);
  const listed = JSON.parse(run.text());
  assert.equal(listed.tabId, "w1:t1");
  assert.equal(listed.target, null);
  assert.deepEqual(listed.worktrees.map((worktree) => [worktree.label, worktree.branch]), [["repo", "main"], ["tier-relay", "feature/relay"]]);
});

test("target rejects unknown worktrees, tabs, and ambiguous arguments", async (t) => {
  const run = targetHarness(t);
  await assert.rejects(main(["target", "nope"], run.options), /no open worktree "nope" .*choices: repo, tier-relay/);
  await assert.rejects(main(["target", "repo", "--tab", "w9:t1"], run.options), /no Herdr tab "w9:t1"/);
  await assert.rejects(main(["target"], run.options), /exactly one of/);
  await assert.rejects(main(["target", "repo", "--follow"], run.options), /exactly one of/);
  await assert.rejects(main(["target", "repo", "--json"], run.options), /--json applies only to --list/);
  delete run.options.environment.HERDR_PANE_ID;
  await assert.rejects(main(["target", "repo"], run.options), /pass --tab <tab_id>/);
  assert.equal(readRailTarget(run.targetFile()), null);
});
