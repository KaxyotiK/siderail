import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertSupportedNode } from "../src/node-version.mjs";

const execFileAsync = promisify(execFile);
const launcher = path.resolve("scripts/node-launcher.sh");
const cmuxLauncher = path.resolve("scripts/cmux-node-launcher.sh");

test("manifest routes every runtime entrypoint through an absolute shell and launcher", async () => {
  const manifest = await fs.readFile("herdr-plugin.toml", "utf8");
  for (const line of manifest.split("\n").filter((value) => value.startsWith("command ="))) {
    assert.match(line, /^command = \["\/bin\/bash", "scripts\/(?:node-launcher|open-herdr-panel)\.sh"/);
  }
  assert.doesNotMatch(manifest, /command = \["node"|command = \["bash"/);
});

test("launcher accepts an absolute Node executable whose path contains spaces", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail node path "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const linkedNode = path.join(root, "node executable");
  await fs.symlink(process.execPath, linkedNode);
  const result = await execFileAsync("/bin/bash", [launcher, "-e", "process.stdout.write('ok')"], {
    env: { GIT_RAIL_NODE_PATH: linkedNode, PATH: "/untrusted" },
  });
  assert.equal(result.stdout, "ok");
});

test("cmux bootstrap preserves an explicit Node executable through a restricted Dock PATH", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail cmux node path "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const linkedNode = path.join(root, "node executable");
  await fs.symlink(process.execPath, linkedNode);
  const result = await execFileAsync("/bin/bash", [cmuxLauncher, "-e", "process.stdout.write(process.env.GIT_RAIL_NODE_PATH)"], {
    env: { GIT_RAIL_NODE_PATH: linkedNode, PATH: "/untrusted" },
  });
  assert.equal(result.stdout, linkedNode);
});

test("direct cmux bootstrap enters a login shell after GitRail exits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail cmux shell "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fakeShell = path.join(root, "login shell");
  await fs.writeFile(fakeShell, "#!/bin/bash\nprintf '|shell:%s' \"$1\"\n", { mode: 0o700 });
  const result = await execFileAsync("/bin/bash", [cmuxLauncher, "-e", "process.stdout.write('tui')"], {
    env: {
      GIT_RAIL_NODE_PATH: process.execPath,
      GIT_RAIL_STAY_OPEN: "1",
      SHELL: fakeShell,
      PATH: "/untrusted",
    },
  });
  assert.equal(result.stdout, "tui|shell:-l");
});

test("launcher rejects missing and unsupported Node before running the target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-launcher-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = path.join(root, "node");
  const marker = path.join(root, "ran");
  await fs.writeFile(fake, "#!/bin/bash\nif [[ \"$1\" == \"-p\" ]]; then echo 21; else touch \"$MARKER\"; fi\n", { mode: 0o700 });
  await assert.rejects(
    () => execFileAsync("/bin/bash", [launcher, "target.mjs"], { env: { GIT_RAIL_NODE_PATH: fake, MARKER: marker } }),
    (error) => /requires Node\.js 22/.test(error.stderr),
  );
  await assert.rejects(() => fs.access(marker), (error) => error.code === "ENOENT");
  await assert.rejects(
    () => execFileAsync("/bin/bash", [launcher, "target.mjs"], { env: { PATH: "/missing" } }),
    (error) => /install Node or set GIT_RAIL_NODE_PATH/.test(error.stderr),
  );
});

test("in-process Node version guard rejects unsupported majors", () => {
  assert.throws(() => assertSupportedNode("21.9.0"), /requires Node\.js 22/);
  assert.equal(assertSupportedNode("24.1.0"), 24);
});
