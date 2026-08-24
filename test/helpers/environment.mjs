import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PASSTHROUGH = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
];

export function hermeticEnvironment(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitrail-test-env-"));
  const environment = {};
  for (const key of PASSTHROUGH) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const cache = path.join(root, "cache");
  const state = path.join(root, "state");
  for (const directory of [home, config, cache, state]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  Object.assign(environment, {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    ...overrides,
  });
  for (const key of Object.keys(environment)) {
    if ((key.startsWith("HERDR_") || key.startsWith("GIT_RAIL_")) && !(key in overrides)) delete environment[key];
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { environment, root, home, config, cache, state };
}
