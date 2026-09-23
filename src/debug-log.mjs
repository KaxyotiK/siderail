import fs from "node:fs";
import path from "node:path";

export function debugLog(operation, details = {}) {
  const target = process.env.SIDERAIL_DEBUG_LOG;
  if (!target) return;
  const safe = Object.fromEntries(Object.entries(details).filter(([key]) => !["args", "stdout", "stderr", "contents", "environment"].includes(key)));
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, operation, ...safe });
  try {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true, mode: 0o700 });
    fs.appendFileSync(target, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Debug logging is opt-in and must never replace usable application state.
  }
}
