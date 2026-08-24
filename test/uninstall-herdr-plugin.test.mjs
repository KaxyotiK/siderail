import assert from "node:assert/strict";
import test from "node:test";
import { uninstallGitRail } from "../scripts/uninstall-herdr-plugin.mjs";

function response(value) {
  return { stdout: JSON.stringify({ result: value }) };
}

test("uninstall closes only live pane instances owned by this checkout before unlinking", async () => {
  const pluginRoot = "/plugin";
  const panes = [
    { pane_id: "rail", terminal_id: "term-rail", workspace_id: "w1", label: "HERDER GITRAIL" },
    { pane_id: "preview", terminal_id: "term-preview", workspace_id: "w1", label: "GitRail Preview" },
    { pane_id: "shell", terminal_id: "term-shell", workspace_id: "w1", label: "shell" },
  ];
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.join(" ") === "pane list") return response({ panes });
    if (args[0] === "pane" && args[1] === "get") {
      return response({ pane: panes.find((pane) => pane.pane_id === args[2]) });
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      const paneId = args.at(-1);
      const script = paneId === "preview" ? "scripts/file-preview.mjs" : "scripts/git-rail.mjs";
      return response({ process_info: { foreground_processes: [{ cwd: pluginRoot, argv: [process.execPath, script] }] } });
    }
    return response({ type: "ok" });
  };
  const result = await uninstallGitRail({ environment: { HERDR_BIN_PATH: "herdr-test" }, run, pluginRoot });
  assert.deepEqual(result.closedPaneIds, ["rail", "preview"]);
  assert.deepEqual(calls.filter((args) => args[0] === "plugin" && args[1] === "pane"), [
    ["plugin", "pane", "close", "rail"],
    ["plugin", "pane", "close", "preview"],
  ]);
  assert.deepEqual(calls.at(-1), ["plugin", "unlink", "local.git-rail"]);
});

test("uninstall fails closed on a reused or spoofed GitRail pane", async () => {
  const pane = { pane_id: "reused", terminal_id: "term-original", workspace_id: "w1", label: "HERDER GITRAIL" };
  const calls = [];
  await assert.rejects(uninstallGitRail({
    environment: { HERDR_BIN_PATH: "herdr-test" },
    pluginRoot: "/plugin",
    run: async (_command, args) => {
      calls.push(args);
      if (args.join(" ") === "pane list") return response({ panes: [pane] });
      if (args[0] === "pane" && args[1] === "get") {
        return response({ pane: { ...pane, terminal_id: "term-reused" } });
      }
      return response({ type: "ok" });
    },
  }), /cannot be proven owned/);
  assert.equal(calls.some((args) => args[0] === "plugin" && args[1] === "pane"), false);
  assert.equal(calls.some((args) => args[0] === "plugin" && args[1] === "unlink"), false);
});
