#!/usr/bin/env node
import { createGitStateClient } from "../../src/git-state-client.mjs";

const [socketPath, namespaceId, selectorJson, durationText] = process.argv.slice(2);
if (!socketPath || !namespaceId || !selectorJson || !durationText) {
  throw new Error("usage: git-state-host-client-worker.mjs SOCKET NAMESPACE SELECTOR_JSON DURATION_MS");
}
const selector = JSON.parse(selectorJson);
const durationMs = Number.parseInt(durationText, 10);
const started = process.cpuUsage();
const client = createGitStateClient({ namespaceId, socketPath });
let deliveries = 0;
try {
  const subscription = client.subscribeHost(selector, () => { deliveries += 1; });
  const context = await subscription.ready;
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const cpu = process.cpuUsage(started);
  await subscription.close();
  await client.close();
  process.stdout.write(`${JSON.stringify({
    context,
    deliveries,
    cpuMicros: { user: cpu.user, system: cpu.system, total: cpu.user + cpu.system },
    rssBytes: process.memoryUsage().rss,
  })}\n`);
} finally {
  await client.close().catch(() => {});
}
