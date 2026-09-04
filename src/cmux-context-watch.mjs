import { spawn } from "node:child_process";

const CONTEXT_EVENT_NAMES = [
  "workspace.selected",
  "surface.selected",
  "surface.focused",
  "pane.focused",
];

function normalized(value) {
  return String(value || "").trim();
}

export function cmuxContextEventTargetsWindow(frame, windowId) {
  if (frame?.type !== "event" || !CONTEXT_EVENT_NAMES.includes(frame.name)) return false;
  const eventWindowId = normalized(frame.window_id || frame.payload?.window_id);
  return !normalized(windowId) || !eventWindowId || eventWindowId === normalized(windowId);
}

export function startCmuxContextWatcher({
  cmux,
  environment = process.env,
  windowId = "",
  onChange,
  onError = () => {},
  onClose = () => {},
  spawnProcess = spawn,
}) {
  const args = ["events"];
  for (const name of CONTEXT_EVENT_NAMES) args.push("--name", name);
  args.push("--reconnect", "--no-heartbeat");
  const child = spawnProcess(cmux, args, {
    env: { ...process.env, ...environment },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let closed = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line);
        if (cmuxContextEventTargetsWindow(frame, windowId)) onChange(frame);
      } catch (error) {
        onError(error);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) onError(new Error(message));
  });
  child.on("error", onError);
  child.on("close", (exitCode, signal) => {
    if (closed) return;
    // A clean exit is not an error: the stream is allowed to end. It still ends
    // this watcher's ability to follow selection, so every unrequested
    // termination is reported so the caller can fall back to bounded polling.
    if (exitCode !== 0) onError(new Error(`cmux event stream exited (${signal || exitCode})`));
    onClose({ exitCode, signal });
  });
  return {
    close() {
      if (closed) return;
      closed = true;
      child.kill("SIGTERM");
    },
  };
}
