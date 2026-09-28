import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindHerdrToggleKey, unbindHerdrToggleKey } from "../src/herdr-toggle-key.mjs";
import { runCommand } from "../src/process.mjs";

// These run the installed `herdr config check` against real TOML, so they are
// opt-in: SIDERAIL_TEST_REAL_HERDR=1 npm test. Only the check reaches the real
// binary; a reload would reach whatever server the parent environment names.
const REAL = process.env.SIDERAIL_TEST_REAL_HERDR === "1";

function realHerdr(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-real-herdr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.toml");
  const reloads = [];
  const run = (command, args, options) => {
    if (args.join(" ") !== "config check") {
      reloads.push(args.join(" "));
      return Promise.reject(new Error(`${args.join(" ")} is not run by these tests`));
    }
    return runCommand(command, args, options);
  };
  const check = async (text) => {
    fs.writeFileSync(path.join(root, "probe.toml"), text);
    const result = await runCommand("herdr", ["config", "check"], {
      env: { HERDR_CONFIG_PATH: path.join(root, "probe.toml") },
      allowExitCodes: [0, 1],
    });
    return result.exitCode === 0;
  };
  return { options: { environment: { ...process.env, HERDR_BIN_PATH: "herdr" }, run, configPath }, configPath, reloads, check };
}

test("Herdr accepts the generated binding and rejects it when the key is taken", { skip: !REAL }, async (t) => {
  const fresh = realHerdr(t);
  fs.writeFileSync(fresh.configPath, "[ui]\nagent_panel_sort = \"priority\"\n");
  assert.deepEqual(await bindHerdrToggleKey(fresh.options), { action: "bound", configPath: fresh.configPath, reloaded: false });
  assert.deepEqual(fresh.reloads, ["server reload-config"]);
  assert.ok(await fresh.check(fs.readFileSync(fresh.configPath, "utf8")));
  assert.equal((await unbindHerdrToggleKey(fresh.options)).action, "removed");
  assert.equal(fs.readFileSync(fresh.configPath, "utf8"), "[ui]\nagent_panel_sort = \"priority\"\n");

  const taken = realHerdr(t);
  fs.writeFileSync(taken.configPath, "[keys]\nnew_tab = \"ctrl+shift+g\"\n");
  const result = await bindHerdrToggleKey(taken.options);
  assert.equal(result.action, "rejected");
  assert.match(result.issues.join("\n"), /ctrl\+shift\+g/);
  assert.equal(fs.readFileSync(taken.configPath, "utf8"), "[keys]\nnew_tab = \"ctrl+shift+g\"\n");
  assert.deepEqual(taken.reloads, []);
});

test("setup declines an inline keys.command array that the generated entry would break", { skip: !REAL }, async (t) => {
  const inline = realHerdr(t);
  fs.writeFileSync(inline.configPath, "keys.command = []\n");
  assert.ok(await inline.check("keys.command = []\n"));
  assert.equal((await bindHerdrToggleKey(inline.options)).action, "inline-array");
  const fresh = realHerdr(t);
  await bindHerdrToggleKey(fresh.options);
  assert.equal(await inline.check(`keys.command = []\n\n${fs.readFileSync(fresh.configPath, "utf8")}`), false);
});

test("a valid config that embeds the generated block in a string keeps it", { skip: !REAL }, async (t) => {
  const fresh = realHerdr(t);
  assert.equal((await bindHerdrToggleKey(fresh.options)).action, "bound");
  const block = fs.readFileSync(fresh.configPath, "utf8");
  const embedded = realHerdr(t);
  const text = `[[keys.command]]\nkey = "ctrl+shift+x"\ntype = "shell"\ncommand = """\ncat <<'TOML'\n${block}\nTOML\n"""\n`;
  assert.ok(await embedded.check(text));
  fs.writeFileSync(embedded.configPath, text);
  assert.equal((await unbindHerdrToggleKey(embedded.options)).action, "kept");
  assert.equal(fs.readFileSync(embedded.configPath, "utf8"), text);
});
