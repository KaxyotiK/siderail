const MINIMUM_NODE_MAJOR = 22;

export function assertSupportedNode(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error(`GitRail requires Node.js ${MINIMUM_NODE_MAJOR} or newer (running ${version || "unknown"})`);
  }
  return major;
}
