import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/process.mjs";
import { clearRailTarget, railTargetPath, readRailTarget, writeRailTarget } from "../src/rail-target.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

const IDENTITY = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };

// Generous: each switch rebuilds Git state, which is slow on a loaded machine.
async function waitFor(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), typeof message === "function" ? message() : message);
}

function latestPlainFrame(text) {
  return text.split("\u001b[?2026h\u001b[H").at(-1).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

// Answers session.snapshot the way Herdr does for a rail beside one content pane.
function fakeHerdr(socketPath, snapshot) {
  const server = net.createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffered.slice(0, newline));
      const reply = request.method === "session.snapshot"
        ? { id: request.id, result: { type: "session_snapshot", snapshot } }
        : { id: request.id, error: { code: "unsupported", message: request.method } };
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

for (const mode of ["shared", "in-process"]) test(`the rail shows a chosen Herdr worktree and follows its pane again when released (${mode})`, async (t) => {
  const { environment, root } = hermeticEnvironment(t, { SIDERAIL_STATE_MODE: mode });
  const main = path.join(root, "repo");
  const relay = path.join(root, "relay");
  fs.mkdirSync(main);
  await runGit(main, ["init", "--initial-branch=main"]);
  fs.writeFileSync(path.join(main, "base.txt"), "base\n");
  await runGit(main, ["add", "base.txt"]);
  await runGit(main, ["commit", "-m", "base"], { env: IDENTITY });
  await runGit(main, ["worktree", "add", "-b", "tier-relay", relay]);

  const repoKey = path.join(main, ".git");
  const snapshot = {
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    workspaces: [
      { workspace_id: "w1", label: "repo", number: 1, worktree: { repo_key: repoKey, checkout_path: main, is_linked_worktree: false } },
      { workspace_id: "w2", label: "tier-relay", number: 2, worktree: { repo_key: repoKey, checkout_path: relay, is_linked_worktree: true } },
    ],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }],
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", foreground_cwd: main },
      { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "SIDERAIL", terminal_id: "term-2" },
    ],
    layouts: [{ tab_id: "w1:t1", focused_pane_id: "w1:p1" }],
  };
  const socketPath = path.join(root, "h.sock");
  const server = await fakeHerdr(socketPath, snapshot);
  t.after(() => server.close());

  const child = spawn(process.execPath, [path.resolve("scripts/siderail.mjs"), "--width", "60", "--height", "24"], {
    cwd: main,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...environment, HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: socketPath },
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let exit = null;
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  const frame = () => latestPlainFrame(stdout);
  const debug = () => `\n${frame()}\nexit: ${JSON.stringify(exit)}\n${stderr}`;

  await waitFor(() => frame().includes("↱ main ▾"), `rail did not follow the content pane\n${stderr}`);
  child.stdin.write("w");
  // The branch line stays as it is; the other worktrees follow it as rows
  // with their arrows aligned, pushing the rest of the view down.
  const closedLines = frame().split("\n");
  await waitFor(() => /↱ tier-relay\s+branch/.test(frame()), () => `worktree list did not open${debug()}`);
  const openLines = frame().split("\n");
  assert.equal(openLines[1], closedLines[1]);
  assert.equal(openLines[2].indexOf("↱"), openLines[1].indexOf("↱"));
  assert.deepEqual(openLines.slice(3, -3), closedLines.slice(2, -4));
  child.stdin.write("\r");
  const pinned = () => /↱ tier-relay ▾\s+current/.test(frame()) && /↱ main\s+pane/.test(frame());
  await waitFor(pinned, () => `rail did not switch to the chosen worktree${debug()}`);
  const targetFile = railTargetPath({ workspaceId: "w1", tabId: "w1:t1", environment });
  assert.equal(readRailTarget(targetFile).workspaceId, "w2");

  // Reopened while pinned, the pane's line is the first choice, in place;
  // choosing it follows the pane again.
  child.stdin.write("w");
  await waitFor(() => pinned() && frame().includes("Enter choose"), () => `worktree list did not reopen${debug()}`);
  child.stdin.write("\r");
  const following = () => frame().includes("↱ main ▾") && !/current|pane/.test(frame().split("\n").slice(0, 4).join("\n"));
  await waitFor(following, () => `rail did not return to its content pane${debug()}`);
  assert.equal(readRailTarget(targetFile), null);

  // An agent pins and releases through the same file with `siderail target`.
  writeRailTarget(targetFile, { workspaceId: "w2", label: "tier-relay", checkoutPath: fs.realpathSync.native(relay) });
  await waitFor(pinned, () => `rail did not follow an external pin${debug()}`);
  clearRailTarget(targetFile);
  await waitFor(following, () => `rail did not follow an external release${debug()}`);

  child.stdin.write("q");
  await new Promise((resolve) => child.once("exit", resolve));
});
