import net from "node:net";

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
let nextRequestId = 1;

function requestId(prefix) {
  const id = nextRequestId++;
  return `${prefix}-${process.pid}-${id}`;
}

function protocolError(message) {
  const error = new Error(message);
  error.code = "HERDR_PROTOCOL_ERROR";
  return error;
}

function parseLine(line) {
  try { return JSON.parse(line); }
  catch (error) { throw protocolError(`Herdr returned invalid JSON: ${error.message}`); }
}

function connect(socketPath, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("connect", connected);
      socket.removeListener("error", failed);
      operation(value);
    };
    const connected = () => finish(resolve, socket);
    const failed = (error) => finish(reject, error);
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`${label} timed out after ${timeoutMs} ms`), {
        code: "HERDR_TIMEOUT",
      });
      socket.destroy();
      finish(reject, error);
    }, timeoutMs);
    socket.once("connect", connected);
    socket.once("error", failed);
  });
}

function lineReader(socket, { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  const queued = [];
  const waiting = [];
  let endedError = null;

  const settle = (value) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(value);
    else queued.push(value);
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > maxLineBytes) throw protocolError(`Herdr response exceeded ${maxLineBytes} bytes`);
          break;
        }
        if (newline > maxLineBytes) throw protocolError(`Herdr response exceeded ${maxLineBytes} bytes`);
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        if (line) settle(parseLine(line));
      }
    } catch (error) {
      socket.destroy(error);
    }
  });
  socket.on("error", (error) => {
    endedError = error;
    while (waiting.length) waiting.shift().reject(error);
  });
  socket.on("close", () => {
    endedError ||= protocolError("Herdr socket closed");
    while (waiting.length) waiting.shift().reject(endedError);
  });

  return {
    next({ timeoutMs, label = "Herdr response" } = {}) {
      if (queued.length) return Promise.resolve(queued.shift());
      if (endedError) return Promise.reject(endedError);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiting.push(waiter);
        if (!timeoutMs) return;
        waiter.timer = setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(Object.assign(new Error(`${label} timed out after ${timeoutMs} ms`), {
            code: "HERDR_TIMEOUT",
          }));
        }, timeoutMs);
        const settleOnce = (operation) => (value) => {
          clearTimeout(waiter.timer);
          operation(value);
        };
        waiter.resolve = settleOnce(resolve);
        waiter.reject = settleOnce(reject);
      });
    },
  };
}

function assertResponse(message, id) {
  if (message?.id !== id) {
    throw protocolError(`expected Herdr response ${id}, received ${message?.id || "an event"}`);
  }
  if (message.error) {
    const error = new Error(message.error.message || `Herdr request ${id} failed`);
    error.code = message.error.code || "HERDR_REQUEST_ERROR";
    throw error;
  }
  return message.result;
}

export async function requestHerdr(socketPath, method, params = {}, {
  id = requestId("req"),
  timeoutMs = 5_000,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
} = {}) {
  const socket = await connect(socketPath, timeoutMs, "Herdr connection");
  const reader = lineReader(socket, { maxLineBytes });
  try {
    socket.end(`${JSON.stringify({ id, method, params })}\n`);
    return assertResponse(await reader.next({ timeoutMs, label: method }), id);
  } finally {
    socket.destroy();
  }
}

export async function subscribeHerdr(socketPath, subscriptions, {
  id = requestId("sub"),
  timeoutMs = 5_000,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
} = {}) {
  const socket = await connect(socketPath, timeoutMs, "Herdr subscription connection");
  const reader = lineReader(socket, { maxLineBytes });
  socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`);
  const result = assertResponse(await reader.next({ timeoutMs, label: "events.subscribe" }), id);
  if (result?.type !== "subscription_started") {
    socket.destroy();
    throw protocolError(`unexpected events.subscribe response: ${result?.type || "missing"}`);
  }
  return {
    id,
    async next({ timeoutMs: eventTimeoutMs = timeoutMs } = {}) {
      return reader.next({ timeoutMs: eventTimeoutMs, label: "Herdr event" });
    },
    close() { socket.destroy(); },
  };
}

export const HERDR_CONTEXT_SUBSCRIPTIONS = Object.freeze([
  "workspace.created", "workspace.updated", "workspace.closed", "workspace.focused",
  "tab.created", "tab.closed", "tab.focused", "tab.moved",
  "pane.created", "pane.updated", "pane.closed", "pane.focused", "pane.moved", "pane.exited",
  "layout.updated",
].map((type) => Object.freeze({ type })));

export function normalizeHerdrEventName(event) {
  return String(event).replace("_", ".");
}
