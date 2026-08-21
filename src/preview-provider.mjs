import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { ProcessError, runGit } from "./process.mjs";

async function safeWorktreePath(repoRoot, relativePath) {
  const root = await fs.realpath(repoRoot);
  const lexical = path.resolve(root, relativePath);
  if (lexical !== root && !lexical.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to read a path outside the selected root");
  try {
    const resolved = await fs.realpath(lexical);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to follow a symlink outside the selected root");
    return resolved;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      const entry = await fs.lstat(lexical);
      if (entry.isSymbolicLink()) throw new Error("Refusing to follow a dangling symlink");
    } catch (entryError) {
      if (entryError.code !== "ENOENT") throw entryError;
    }
    const parent = await fs.realpath(path.dirname(lexical));
    if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to resolve a path through a symlink outside the selected root");
    return lexical;
  }
}

async function gitOutput(repoRoot, args, maxOutputBytes, allowExitCodes = [0]) {
  return (await runGit(repoRoot, args, { maxOutputBytes, allowExitCodes })).stdout;
}

async function safeUntrackedPath(repoRoot, relativePath) {
  const root = await fs.realpath(repoRoot);
  const lexical = path.resolve(root, relativePath);
  if (lexical !== root && !lexical.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to read a path outside the repository");
  const parent = await fs.realpath(path.dirname(lexical));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to resolve a path through a symlink outside the repository");
  const stat = await fs.lstat(lexical);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Only regular files and symbolic links can be previewed");
  return lexical;
}

function pathspecs(filePath, metadata = {}) {
  return metadata.oldPath && metadata.oldPath !== filePath ? [metadata.oldPath, filePath] : [filePath];
}

export function diffArguments(descriptor, filePath, metadata = {}) {
  const common = ["--no-ext-diff", "--color=always", "--find-renames", "--find-copies-harder"];
  const paths = pathspecs(filePath, metadata);
  if (descriptor.kind === "workspace") return ["diff", ...common, descriptor.mergeBase || descriptor.baseRef, "--", ...paths];
  if (descriptor.kind === "against") return descriptor.mergeBase
    ? ["diff", ...common, descriptor.mergeBase, "HEAD", "--", ...paths]
    : ["diff", ...common, `${descriptor.baseRef}...HEAD`, "--", ...paths];
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
  if (descriptor.kind === "filesystem") return { text: "No Git change exists for this file.", revision: "filesystem file" };
  if (descriptor.kind === "clean") return { text: "No change exists for this file.", revision: "worktree (clean)" };
  if (descriptor.kind === "untracked") {
    await safeUntrackedPath(repoRoot, filePath);
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

async function readBoundedBuffer(filePath, maxBytes) {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Only regular files can be previewed");
    if (stat.size > maxBytes) throw new Error(`File is ${stat.size} bytes; preview limit is ${maxBytes} bytes`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function decodeText(content) {
  if (content.subarray(0, Math.min(8_192, content.length)).includes(0)) throw new Error("Binary file — textual preview unavailable");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { throw new Error("File is not valid UTF-8 — textual preview unavailable"); }
}

async function readSymlinkBuffer(repoRoot, relativePath, maxBytes) {
  const root = await fs.realpath(repoRoot);
  const lexical = path.resolve(root, relativePath);
  if (lexical !== root && !lexical.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to read a path outside the repository");
  const parent = await fs.realpath(path.dirname(lexical));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to resolve a path through a symlink outside the repository");
  const stat = await fs.lstat(lexical);
  if (!stat.isSymbolicLink()) throw new Error("Expected a symbolic link");
  const target = await fs.readlink(lexical, { encoding: "buffer" });
  if (target.length > maxBytes) throw new Error(`File is ${target.length} bytes; preview limit is ${maxBytes} bytes`);
  return target;
}

async function blobBuffer(repoRoot, revision, filePath, maxBytes) {
  const spec = revision === "index" ? `:./${filePath}` : `${revision}:${filePath}`;
  return (await runGit(repoRoot, ["show", spec], { maxOutputBytes: maxBytes, stdoutEncoding: null })).stdout;
}

function isMissingContent(error) {
  if (error?.code === "ENOENT") return true;
  return error instanceof ProcessError
    && error.kind === "exit"
    && /(?:does not exist in|exists on disk, but not in|not at stage 0)/i.test(error.stderr || error.message);
}

function previousMetadata(metadata) {
  return {
    ...metadata,
    submodule: metadata.oldSubmodule ?? metadata.submodule,
    symlink: metadata.oldSymlink ?? metadata.symlink,
  };
}

async function submoduleText(repoRoot, revision, filePath, maxBytes) {
  let objectId;
  if (revision === "worktree") {
    const absolute = await safeWorktreePath(repoRoot, filePath);
    await fs.lstat(path.join(absolute, ".git"));
    objectId = (await gitOutput(absolute, ["rev-parse", "HEAD"], maxBytes)).trim();
  } else if (revision === "index") {
    objectId = (await gitOutput(repoRoot, ["rev-parse", `:./${filePath}`], maxBytes)).trim();
  } else {
    objectId = (await gitOutput(repoRoot, ["rev-parse", `${revision}:${filePath}`], maxBytes)).trim();
  }
  return `Submodule commit ${objectId}\n`;
}

async function loadRawContent({ repoRoot, filePath, descriptor, metadata = {}, maxFileBytes }, decode) {
  const oldPath = metadata.oldPath || filePath;
  const raw = async (revision, rawPath, label, contentMetadata = metadata) => ({
    content: contentMetadata.submodule
      ? decode(Buffer.from(await submoduleText(repoRoot, revision, rawPath, maxFileBytes)))
      : revision === "worktree"
        ? contentMetadata.symlink
          ? decode(await readSymlinkBuffer(repoRoot, rawPath, maxFileBytes))
          : decode(await readBoundedBuffer(await safeWorktreePath(repoRoot, rawPath), maxFileBytes))
        : decode(await blobBuffer(repoRoot, revision, rawPath, maxFileBytes)),
    revision: label,
  });
  if (descriptor.kind === "commit") {
    descriptor = await commitDescriptor(repoRoot, descriptor, maxFileBytes);
    try { return await raw(descriptor.commitHash, filePath, `${descriptor.commitHash}:${filePath}`); }
    catch (error) {
      if (!descriptor.parentHash || !isMissingContent(error)) throw error;
      return raw(descriptor.parentHash, oldPath, `${descriptor.parentHash}:${oldPath}`, previousMetadata(metadata));
    }
  }
  if (descriptor.kind === "against") {
    try { return await raw("HEAD", filePath, `HEAD:${filePath}`); }
    catch (error) {
      if (!isMissingContent(error)) throw error;
      const revision = descriptor.mergeBase || descriptor.baseRef;
      return raw(revision, oldPath, `${revision}:${oldPath}`, previousMetadata(metadata));
    }
  }
  if (descriptor.kind === "staged") {
    try { return await raw("index", filePath, `index:${filePath}`); }
    catch (error) {
      if (!isMissingContent(error)) throw error;
      return raw("HEAD", oldPath, `HEAD:${oldPath}`, previousMetadata(metadata));
    }
  }
  if (descriptor.kind === "workspace" || descriptor.kind === "unstaged" || descriptor.kind === "untracked" || descriptor.kind === "clean" || descriptor.kind === "filesystem") {
    try { return await raw("worktree", filePath, "worktree"); }
    catch (error) {
      if (!isMissingContent(error)) throw error;
      if (metadata.submodule && (descriptor.kind === "workspace" || descriptor.kind === "clean")) {
        try { return await raw("index", filePath, `index:${filePath}`); }
        catch (indexError) {
          if (!isMissingContent(indexError)) throw indexError;
        }
      }
      if (metadata.status !== "deleted") throw error;
      if (descriptor.kind === "workspace") {
        const revision = descriptor.mergeBase || descriptor.baseRef;
        return raw(revision, oldPath, `${revision}:${oldPath}`, previousMetadata(metadata));
      }
      if (descriptor.kind === "unstaged") return raw("index", oldPath, `index:${oldPath}`, previousMetadata(metadata));
      throw error;
    }
  }
  throw new Error(`Unsupported raw descriptor: ${descriptor.kind}`);
}

export async function loadRaw(options) {
  const result = await loadRawContent(options, decodeText);
  return { text: result.content, revision: result.revision };
}

export async function loadRawBytes(options) {
  const result = await loadRawContent(options, (content) => content);
  return { bytes: result.content, revision: result.revision };
}

export { safeWorktreePath };
