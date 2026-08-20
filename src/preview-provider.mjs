import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./process.mjs";

async function safeWorktreePath(repoRoot, relativePath) {
  const root = await fs.realpath(repoRoot);
  const lexical = path.resolve(root, relativePath);
  if (lexical !== root && !lexical.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to read a path outside the repository");
  try {
    const resolved = await fs.realpath(lexical);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to follow a symlink outside the repository");
    return resolved;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = await fs.realpath(path.dirname(lexical));
    if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to resolve a path through a symlink outside the repository");
    return lexical;
  }
}

async function gitOutput(repoRoot, args, maxOutputBytes, allowExitCodes = [0]) {
  return (await runGit(repoRoot, args, { maxOutputBytes, allowExitCodes })).stdout;
}

export function diffArguments(descriptor, filePath) {
  const common = ["--no-ext-diff", "--color=always", "--find-renames", "--find-copies-harder"];
  if (descriptor.kind === "head") return ["diff", ...common, "HEAD", "--", filePath];
  if (descriptor.kind === "against") return ["diff", ...common, `${descriptor.baseRef}...HEAD`, "--", filePath];
  if (descriptor.kind === "commit") return ["show", "--format=", ...common, descriptor.commitHash, "--", filePath];
  if (descriptor.kind === "staged") return ["diff", ...common, "--cached", "--", filePath];
  if (descriptor.kind === "unstaged") return ["diff", ...common, "--", filePath];
  return null;
}

export async function loadDiff({ repoRoot, filePath, descriptor, maxOutputBytes }) {
  if (descriptor.kind === "clean") return { text: "No change exists for this file.", revision: "worktree (clean)" };
  if (descriptor.kind === "untracked") {
    await safeWorktreePath(repoRoot, filePath);
    const text = await gitOutput(repoRoot, ["diff", "--no-index", "--color=always", "--", "/dev/null", filePath], maxOutputBytes, [0, 1]);
    return { text: text || "The untracked file is empty.", revision: "untracked worktree file" };
  }
  const args = diffArguments(descriptor, filePath);
  if (!args) throw new Error(`Unsupported diff descriptor: ${descriptor.kind}`);
  const text = await gitOutput(repoRoot, args, maxOutputBytes);
  return { text: text || `No ${descriptor.kind} change exists for this path.`, revision: descriptorLabel(descriptor) };
}

function descriptorLabel(descriptor) {
  if (descriptor.kind === "head") return "worktree vs HEAD";
  if (descriptor.kind === "against") return `${descriptor.baseRef}...HEAD`;
  if (descriptor.kind === "commit") return descriptor.commitHash;
  if (descriptor.kind === "staged") return "index vs HEAD";
  if (descriptor.kind === "unstaged") return "worktree vs index";
  return descriptor.kind;
}

async function readBounded(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) throw new Error(`File is ${stat.size} bytes; preview limit is ${maxBytes} bytes`);
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, stat.size, 0);
    if (buffer.subarray(0, Math.min(8_192, buffer.length)).includes(0)) throw new Error("Binary file — textual preview unavailable");
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function blob(repoRoot, revision, filePath, maxBytes) {
  const spec = `${revision}:${filePath}`;
  return gitOutput(repoRoot, ["show", spec], maxBytes);
}

export async function loadRaw({ repoRoot, filePath, descriptor, metadata = {}, maxFileBytes }) {
  try {
    const absolute = await safeWorktreePath(repoRoot, filePath);
    return { text: await readBounded(absolute, maxFileBytes), revision: "worktree" };
  } catch (worktreeError) {
    if (!/ENOENT|no such file|unavailable/i.test(`${worktreeError.code || ""} ${worktreeError.message}`) && metadata.status !== "deleted") throw worktreeError;
  }
  const oldPath = metadata.oldPath || filePath;
  if (descriptor.kind === "commit") {
    try { return { text: await blob(repoRoot, descriptor.commitHash, filePath, maxFileBytes), revision: `${descriptor.commitHash}:${filePath}` }; }
    catch { return { text: await blob(repoRoot, `${descriptor.commitHash}^`, oldPath, maxFileBytes), revision: `${descriptor.commitHash}^:${oldPath}` }; }
  }
  if (descriptor.kind === "against") return { text: await blob(repoRoot, descriptor.baseRef, oldPath, maxFileBytes), revision: `${descriptor.baseRef}:${oldPath}` };
  if (descriptor.kind === "unstaged") return { text: await blob(repoRoot, "", oldPath, maxFileBytes), revision: `index:${oldPath}` };
  return { text: await blob(repoRoot, "HEAD", oldPath, maxFileBytes), revision: `HEAD:${oldPath}` };
}

export { safeWorktreePath };
