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

function pathspecs(filePath, metadata = {}) {
  return metadata.oldPath && metadata.oldPath !== filePath ? [metadata.oldPath, filePath] : [filePath];
}

export function diffArguments(descriptor, filePath, metadata = {}) {
  const common = ["--no-ext-diff", "--color=always", "--find-renames", "--find-copies-harder"];
  const paths = pathspecs(filePath, metadata);
  if (descriptor.kind === "workspace") return ["diff", ...common, descriptor.mergeBase || descriptor.baseRef, "--", ...paths];
  if (descriptor.kind === "against") return ["diff", ...common, `${descriptor.baseRef}...HEAD`, "--", ...paths];
  if (descriptor.kind === "commit" && descriptor.parentHash) return ["diff", ...common, descriptor.parentHash, descriptor.commitHash, "--", ...paths];
  if (descriptor.kind === "commit" && descriptor.parentHash === "") return ["show", "--root", "--format=", ...common, descriptor.commitHash, "--", ...paths];
  if (descriptor.kind === "staged") return ["diff", ...common, "--cached", "--", ...paths];
  if (descriptor.kind === "unstaged") return ["diff", ...common, "--", ...paths];
  return null;
}

async function commitDescriptor(repoRoot, descriptor, maxOutputBytes) {
  if (descriptor.kind !== "commit" || Object.hasOwn(descriptor, "parentHash")) return descriptor;
  const parents = (await gitOutput(repoRoot, ["rev-list", "--parents", "-n", "1", descriptor.commitHash], maxOutputBytes)).trim().split(/\s+/);
  return { ...descriptor, parentHash: parents[1] || "", comparison: "first-parent" };
}

export async function loadDiff({ repoRoot, filePath, descriptor, metadata = {}, maxOutputBytes }) {
  if (descriptor.kind === "clean") return { text: "No change exists for this file.", revision: "worktree (clean)" };
  if (descriptor.kind === "untracked") {
    await safeWorktreePath(repoRoot, filePath);
    const text = await gitOutput(repoRoot, ["diff", "--no-index", "--color=always", "--", "/dev/null", filePath], maxOutputBytes, [0, 1]);
    return { text: text || "The untracked file is empty.", revision: "untracked worktree file" };
  }
  descriptor = await commitDescriptor(repoRoot, descriptor, maxOutputBytes);
  const args = diffArguments(descriptor, filePath, metadata);
  if (!args) throw new Error(`Unsupported diff descriptor: ${descriptor.kind}`);
  const text = await gitOutput(repoRoot, args, maxOutputBytes);
  return { text: text || `No ${descriptor.kind} change exists for this path.`, revision: descriptorLabel(descriptor) };
}

function descriptorLabel(descriptor) {
  if (descriptor.kind === "workspace") return `${descriptor.baseRef} merge base vs worktree`;
  if (descriptor.kind === "against") return `${descriptor.baseRef}...HEAD`;
  if (descriptor.kind === "commit") return descriptor.parentHash
    ? `${descriptor.parentHash.slice(0, 8)} → ${descriptor.commitHash.slice(0, 8)} (first parent)`
    : `empty tree → ${descriptor.commitHash.slice(0, 8)}`;
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
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw new Error("File is not valid UTF-8 — textual preview unavailable"); }
  } finally {
    await handle.close();
  }
}

async function blob(repoRoot, revision, filePath, maxBytes) {
  const spec = `${revision}:${filePath}`;
  return gitOutput(repoRoot, ["show", spec], maxBytes);
}

async function submoduleText(repoRoot, revision, filePath, maxBytes) {
  let objectId;
  if (revision === "worktree") {
    const absolute = await safeWorktreePath(repoRoot, filePath);
    await fs.lstat(path.join(absolute, ".git"));
    objectId = (await gitOutput(absolute, ["rev-parse", "HEAD"], maxBytes)).trim();
  } else if (revision === "index") {
    objectId = (await gitOutput(repoRoot, ["rev-parse", `:${filePath}`], maxBytes)).trim();
  } else {
    objectId = (await gitOutput(repoRoot, ["rev-parse", `${revision}:${filePath}`], maxBytes)).trim();
  }
  return `Submodule commit ${objectId}\n`;
}

export async function loadRaw({ repoRoot, filePath, descriptor, metadata = {}, maxFileBytes }) {
  const oldPath = metadata.oldPath || filePath;
  const raw = async (revision, rawPath, label) => ({
    text: metadata.submodule
      ? await submoduleText(repoRoot, revision, rawPath, maxFileBytes)
      : revision === "worktree"
        ? await readBounded(await safeWorktreePath(repoRoot, rawPath), maxFileBytes)
        : await blob(repoRoot, revision === "index" ? "" : revision, rawPath, maxFileBytes),
    revision: label,
  });
  if (descriptor.kind === "commit") {
    descriptor = await commitDescriptor(repoRoot, descriptor, maxFileBytes);
    try { return await raw(descriptor.commitHash, filePath, `${descriptor.commitHash}:${filePath}`); }
    catch (error) {
      if (!descriptor.parentHash) throw error;
      return raw(descriptor.parentHash, oldPath, `${descriptor.parentHash}:${oldPath}`);
    }
  }
  if (descriptor.kind === "against") {
    try { return await raw("HEAD", filePath, `HEAD:${filePath}`); }
    catch { return raw(descriptor.baseRef, oldPath, `${descriptor.baseRef}:${oldPath}`); }
  }
  if (descriptor.kind === "staged") {
    try { return await raw("index", filePath, `index:${filePath}`); }
    catch { return raw("HEAD", oldPath, `HEAD:${oldPath}`); }
  }
  if (descriptor.kind === "workspace" || descriptor.kind === "unstaged" || descriptor.kind === "untracked" || descriptor.kind === "clean") {
    try { return await raw("worktree", filePath, "worktree"); }
    catch (error) {
      if (metadata.submodule) {
        try { return await raw("index", filePath, `index:${filePath}`); }
        catch { return raw("HEAD", oldPath, `HEAD:${oldPath}`); }
      }
      if (metadata.status !== "deleted") throw error;
      if (descriptor.kind === "workspace") {
        const revision = descriptor.mergeBase || descriptor.baseRef;
        return raw(revision, oldPath, `${revision}:${oldPath}`);
      }
      if (descriptor.kind === "unstaged") return raw("index", oldPath, `index:${oldPath}`);
      return raw("HEAD", oldPath, `HEAD:${oldPath}`);
    }
  }
  throw new Error(`Unsupported raw descriptor: ${descriptor.kind}`);
}

export { safeWorktreePath };
