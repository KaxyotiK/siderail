#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";

function append(entry) {
  const target = process.env.REFRESH_HERDR_LOG;
  if (!target) return;
  fs.appendFileSync(target, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    pid: process.pid,
    railPaneId: process.env.HERDR_PANE_ID || "",
    tabId: process.env.HERDR_TAB_ID || "",
    ...entry,
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function finish(result, exitCode = 0) {
  append({ phase: "exit", exitCode, cpu: process.cpuUsage() });
  if (result !== undefined) process.stdout.write(`${JSON.stringify({ result })}\n`);
  process.exit(exitCode);
}

function appendComponent(entry) {
  const target = process.env.SIDERAIL_PERFORMANCE_LOG;
  if (!target) return;
  fs.appendFileSync(target, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "component",
    role: "host-fixture",
    pid: process.pid,
    owner: "refresh-performance",
    ...entry,
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

async function serveSocket(socketPath, topologyPath) {
  const snapshot = JSON.parse(fs.readFileSync(topologyPath, "utf8"));
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("end", () => {
      for (const line of input.split("\n").filter(Boolean)) {
        const request = JSON.parse(line);
        const started = process.cpuUsage();
        append({ phase: "start", args: [request.method], requestId: request.id });
        const result = request.method === "session.snapshot"
          ? { type: "session_snapshot", snapshot }
          : undefined;
        const response = result
          ? { id: request.id, result }
          : { id: request.id, error: { code: "METHOD_NOT_FOUND", message: `unsupported fixture method: ${request.method}` } };
        socket.write(`${JSON.stringify(response)}\n`);
        append({ phase: "exit", args: [request.method], requestId: request.id, exitCode: result ? 0 : 64, cpu: process.cpuUsage(started) });
      }
      socket.end();
    });
  });
  const close = () => new Promise((resolve) => server.close(resolve));
  appendComponent({ phase: "started" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  appendComponent({ phase: "ready" });
  process.stdout.write(`${JSON.stringify({ ready: true, socketPath })}\n`);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await close();
    try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    appendComponent({ phase: "stopped" });
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { if (chunk.includes("q")) stop().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { stop().then(() => process.exit(0)); });
}

const args = process.argv.slice(2);
if (args[0] === "--socket-server") {
  await serveSocket(args[1], args[2]);
} else {
const railPaneId = process.env.HERDR_PANE_ID || "rail";
const sourcePaneId = process.env.SIDERAIL_SOURCE_PANE_ID || "content";
const tabId = process.env.HERDR_TAB_ID || "tab";
const workspaceId = process.env.HERDR_WORKSPACE_ID || "workspace";
const cwd = process.env.SIDERAIL_REPO_ROOT || process.cwd();
append({ phase: "start", args });

if (args[0] === "pane" && args[1] === "get") {
  finish({ pane: {
    pane_id: railPaneId,
    tab_id: tabId,
    workspace_id: workspaceId,
    label: "SIDERAIL",
    cwd,
    foreground_cwd: cwd,
  } });
}
if (args[0] === "pane" && args[1] === "list") {
  finish({ panes: [
    {
      pane_id: railPaneId,
      tab_id: tabId,
      workspace_id: workspaceId,
      label: "SIDERAIL",
      cwd,
      foreground_cwd: cwd,
    },
    {
      pane_id: sourcePaneId,
      tab_id: tabId,
      workspace_id: workspaceId,
      label: "Fixture content",
      cwd,
      foreground_cwd: cwd,
    },
  ] });
}
if (args[0] === "pane" && args[1] === "layout") {
  finish({ layout: { focused_pane_id: sourcePaneId } });
}

finish(undefined, 64);
}
