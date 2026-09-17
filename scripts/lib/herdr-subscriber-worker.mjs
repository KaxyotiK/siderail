#!/usr/bin/env node
import { HERDR_CONTEXT_SUBSCRIPTIONS, subscribeHerdr } from "../../src/herdr-socket.mjs";

const [socketPath, durationValue = "3000"] = process.argv.slice(2);
const durationMs = Number.parseInt(durationValue, 10);
if (!socketPath || !Number.isInteger(durationMs) || durationMs < 1) {
  throw new Error("usage: herdr-subscriber-worker.mjs SOCKET_PATH DURATION_MS");
}

const beforeConnect = process.cpuUsage();
const subscription = await subscribeHerdr(socketPath, HERDR_CONTEXT_SUBSCRIPTIONS);
let bootstrapEvents = 0;
const bootstrapEventCounts = {};
while (true) {
  try {
    const message = await subscription.next({ timeoutMs: 300 });
    bootstrapEvents += 1;
    bootstrapEventCounts[message.event] = (bootstrapEventCounts[message.event] || 0) + 1;
  } catch (error) {
    if (error.code === "HERDR_TIMEOUT") break;
    throw error;
  }
}
const startupCpu = process.cpuUsage(beforeConnect);
const before = process.cpuUsage();
let events = 0;
const eventCounts = {};
let done = false;
const drain = (async () => {
  while (!done) {
    try {
      const message = await subscription.next({ timeoutMs: Math.min(durationMs + 1_000, 5_000) });
      events += 1;
      eventCounts[message.event] = (eventCounts[message.event] || 0) + 1;
    } catch (error) {
      if (!done && error.code !== "HERDR_TIMEOUT") throw error;
    }
  }
})();

await new Promise((resolve) => setTimeout(resolve, durationMs));
done = true;
subscription.close();
await drain;
const cpu = process.cpuUsage(before);
const usage = process.resourceUsage();
process.stdout.write(`${JSON.stringify({
  pid: process.pid,
  durationMs,
  requests: { "events.subscribe": 1 },
  bootstrapEvents,
  bootstrapEventCounts,
  startupCpuMicros: { user: startupCpu.user, system: startupCpu.system, total: startupCpu.user + startupCpu.system },
  events,
  eventCounts,
  cpuMicros: { user: cpu.user, system: cpu.system, total: cpu.user + cpu.system },
  rssBytes: process.memoryUsage.rss(),
  maxRssBytes: usage.maxRSS * 1024,
})}\n`);
