import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindHerdrToggleKey, unbindHerdrToggleKey } from "../src/herdr-toggle-key.mjs";

// These run the installed `herdr config check` against real TOML, so they are
// opt-in: SIDERAIL_TEST_REAL_HERDR=1 npm test. Reloads go to a session that
// does not exist, so no running Herdr server is touched.
const REAL = process.env.SIDERAIL_TEST_REAL_HERDR === "1";

function realEnvironment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-real-herdr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.toml");
  const environment = { ...process.env, HERDR_CONFIG_PATH: configPath, HERDR_SESSION: `siderail-test-${process.pid}` };
  delete environment.HERDR_SOCKET_PATH;
  return { environment, configPath };
}

test("Herdr accepts the generated binding and rejects it when the key is taken", { skip: !REAL }, async (t) => {
  const fresh = realEnvironment(t);
  fs.writeFileSync(fresh.configPath, "[ui]\nagent_panel_sort = \"priority\"\n");
  assert.equal((await bindHerdrToggleKey(fresh)).action, "bound");
  assert.equal((await unbindHerdrToggleKey(fresh)).action, "removed");
  assert.equal(fs.readFileSync(fresh.configPath, "utf8"), "[ui]\nagent_panel_sort = \"priority\"\n");

  const taken = realEnvironment(t);
  fs.writeFileSync(taken.configPath, "[keys]\nnew_tab = \"ctrl+shift+g\"\n");
  const result = await bindHerdrToggleKey(taken);
  assert.equal(result.action, "rejected");
  assert.match(result.issues.join("\n"), /ctrl\+shift\+g/);
  assert.equal(fs.readFileSync(taken.configPath, "utf8"), "[keys]\nnew_tab = \"ctrl+shift+g\"\n");
});

test("a valid config that embeds the generated block in a string keeps it", { skip: !REAL }, async (t) => {
  const fresh = realEnvironment(t);
  assert.equal((await bindHerdrToggleKey(fresh)).action, "bound");
  const block = fs.readFileSync(fresh.configPath, "utf8");
  const embedded = realEnvironment(t);
  const text = `[[keys.command]]\nkey = "ctrl+shift+x"\ntype = "shell"\ncommand = """\ncat <<'TOML'\n${block}\nTOML\n"""\n`;
  fs.writeFileSync(embedded.configPath, text);
  assert.equal((await unbindHerdrToggleKey(embedded)).action, "kept");
  assert.equal(fs.readFileSync(embedded.configPath, "utf8"), text);
});
