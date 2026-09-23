import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.mjs";
import { PROTOCOL_VERSION } from "./git-state-protocol.mjs";

const KNOWN_SIDERAIL_VARIABLES = new Set([
  "SIDERAIL_AMBIGUOUS_WIDTH",
  "SIDERAIL_BASE",
  "SIDERAIL_CLIENT",
  "SIDERAIL_CLIENT_ARGS",
  "SIDERAIL_CLIENT_MODE",
  "SIDERAIL_CMUX_BIN",
  "SIDERAIL_DEBUG_LOG",
  "SIDERAIL_DEMO",
  "SIDERAIL_HOST",
  "SIDERAIL_LIVE_GIT_SHIM",
  "SIDERAIL_NODE_PATH",
  "SIDERAIL_PANEL_WIDTH",
  "SIDERAIL_PERFORMANCE_LOG",
  "SIDERAIL_POLL_INTERVAL_MS",
  "SIDERAIL_PREVIEW_DESCRIPTOR",
  "SIDERAIL_PREVIEW_METADATA",
  "SIDERAIL_PREVIEW_PATH",
  "SIDERAIL_PREVIEW_REPO",
  "SIDERAIL_PREVIEW_TEMPORARY",
  "SIDERAIL_PROJECT_CWD",
  "SIDERAIL_RECONCILE_INTERVAL_MS",
  "SIDERAIL_REPO_ROOT",
  "SIDERAIL_SOURCE_PANE_ID",
  "SIDERAIL_SOURCE_TAB_ID",
  "SIDERAIL_STATE_MODE",
  "SIDERAIL_STAY_OPEN",
  "SIDERAIL_TEST_FATAL",
  "SIDERAIL_WATCH_MODE",
  "SIDERAIL_WINDOW_ID",
  "SIDERAIL_WORKSPACE_CWD",
]);
const FIXED_ENVIRONMENT_NAMES = [
  "HOME", "XDG_CONFIG_HOME", "PATH", "LANG", "LANGUAGE", "LC_ALL", "TZ",
];
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export class GitStateIdentityError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "GitStateIdentityError";
    this.code = code;
  }
}

function identityError(code, message, cause) {
  return new GitStateIdentityError(code, message, cause);
}

function stableValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") throw new TypeError("identity input must be JSON-compatible");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function environmentValue(environment, name) {
  if (!Object.hasOwn(environment, name) || environment[name] === undefined) return null;
  const value = String(environment[name]);
  if (value.includes("\0")) throw identityError("UNSUPPORTED_ENVIRONMENT", `${name} contains NUL`);
  return value;
}

export function collectEffectiveGitEnvironment(environment = process.env, {
  platform = process.platform,
  uid = process.getuid?.() ?? null,
} = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  const names = new Set(FIXED_ENVIRONMENT_NAMES);
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_") || name.startsWith("LC_")
      || (name.startsWith("SIDERAIL_") && !KNOWN_SIDERAIL_VARIABLES.has(name))) names.add(name);
  }
  names.add("GIT_OPTIONAL_LOCKS");
  const variables = [...names].sort().map((name) => Object.freeze([
    name,
    name === "GIT_OPTIONAL_LOCKS" ? "0" : environmentValue(environment, name),
  ]));
  return Object.freeze({
    platform: String(platform),
    uid: uid === null ? null : String(uid),
    variables: Object.freeze(variables),
  });
}

export function digestEffectiveGitEnvironment(environment = process.env, options = {}) {
  return digest(collectEffectiveGitEnvironment(environment, options));
}

export function digestEffectiveRuntimeSemantics({
  environmentOverrides,
} = {}) {
  if (!environmentOverrides || typeof environmentOverrides !== "object" || Array.isArray(environmentOverrides)) {
    throw new TypeError("environmentOverrides must be an object");
  }
  return digest({ environmentOverrides });
}

export function collectEffectiveRuntimeSemantics(environment = process.env) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  const override = (name) => Object.freeze({
    present: Object.hasOwn(environment, name),
    raw: Object.hasOwn(environment, name) ? String(environment[name]) : null,
  });
  return Object.freeze({
    environmentOverrides: Object.freeze({
      base: override("SIDERAIL_BASE"),
      pollOverride: override("SIDERAIL_POLL_INTERVAL_MS"),
      reconcileOverride: override("SIDERAIL_RECONCILE_INTERVAL_MS"),
      watchModeOverride: override("SIDERAIL_WATCH_MODE"),
    }),
  });
}

async function canonicalExistingPath(value, realpath = fs.realpath) {
  try { return await realpath(value); }
  catch (error) { throw identityError("PATH_UNAVAILABLE", `cannot resolve ${value}: ${error.message}`, error); }
}

async function canonicalProspectivePath(value, realpath = fs.realpath) {
  let current = path.resolve(value);
  const suffix = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return path.join(existing, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw identityError("PATH_UNAVAILABLE", `cannot resolve ${value}: ${error.message}`, error);
      }
      const parent = path.dirname(current);
      if (parent === current) throw identityError("PATH_UNAVAILABLE", `cannot resolve ${value}`, error);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function findExecutable(executable, {
  environment,
  cwd,
  access,
  platform,
} = {}) {
  if (typeof executable !== "string" || !executable.trim() || executable.includes("\0")) {
    throw identityError("UNSUPPORTED_EXECUTABLE", "Git executable must be a non-empty path or command name");
  }
  if (executable.includes("/") || platform === "win32" && executable.includes("\\")) {
    const candidate = path.resolve(cwd, executable);
    await access(candidate, fsConstants.X_OK);
    return candidate;
  }
  const search = String(environment.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32"
    ? String(environment.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of search) {
    const searchDirectory = path.isAbsolute(directory) ? directory : path.resolve(cwd, directory);
    for (const extension of extensions) {
      const candidate = path.join(searchDirectory, `${executable}${extension}`);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {}
    }
  }
  throw identityError("GIT_EXECUTABLE_UNAVAILABLE", `cannot resolve ${executable} from PATH`);
}

export async function resolveGitExecutableIdentity({
  environment = process.env,
  executable = "git",
  cwd = process.cwd(),
  platform = process.platform,
  access = fs.access,
  realpath = fs.realpath,
  stat = fs.stat,
} = {}) {
  let selected;
  try {
    selected = await findExecutable(executable, { environment, cwd, access, platform });
  } catch (error) {
    if (error instanceof GitStateIdentityError) throw error;
    throw identityError("GIT_EXECUTABLE_UNAVAILABLE", `cannot resolve ${executable}: ${error.message}`, error);
  }
  const canonical = await canonicalExistingPath(selected, realpath);
  let metadata;
  try { metadata = await stat(canonical, { bigint: true }); }
  catch (error) { throw identityError("GIT_EXECUTABLE_UNAVAILABLE", `cannot inspect ${canonical}: ${error.message}`, error); }
  if (!metadata.isFile()) throw identityError("UNSUPPORTED_EXECUTABLE", `${canonical} is not a regular file`);
  return Object.freeze({
    realpath: canonical,
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs ?? BigInt(Math.trunc(Number(metadata.mtimeMs) * 1e6))),
  });
}

function updateLengthPrefixed(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

export async function computeCodeFingerprint(runtimeFiles, {
  checkoutPath = process.cwd(),
  readFile = fs.readFile,
  realpath = fs.realpath,
} = {}) {
  if (!Array.isArray(runtimeFiles) || runtimeFiles.length === 0) {
    throw new TypeError("runtimeFiles must be a non-empty array");
  }
  const checkout = await canonicalExistingPath(checkoutPath, realpath);
  const files = [];
  for (const file of runtimeFiles) {
    if (typeof file !== "string" || !file || file.includes("\0")) throw new TypeError("runtime file paths must be non-empty strings");
    const canonical = await canonicalExistingPath(path.resolve(checkout, file), realpath);
    if (canonical !== checkout && !canonical.startsWith(`${checkout}${path.sep}`)) {
      throw identityError("RUNTIME_FILE_OUTSIDE_CHECKOUT", `${canonical} is outside ${checkout}`);
    }
    files.push({ canonical, relative: path.relative(checkout, canonical) });
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  const duplicate = files.find((entry, index) => index > 0 && entry.relative === files[index - 1].relative);
  if (duplicate) throw identityError("DUPLICATE_RUNTIME_FILE", `runtime file listed twice: ${duplicate.relative}`);
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, "siderail-code-v1");
  updateLengthPrefixed(hash, checkout);
  for (const file of files) {
    updateLengthPrefixed(hash, file.relative);
    updateLengthPrefixed(hash, await readFile(file.canonical));
  }
  return hash.digest("hex");
}

export async function createCoordinatorIdentity({
  hostSocketPath,
  codeFingerprint,
  providerEnvironmentId,
  effectiveConfigId,
  gitExecutableIdentity,
  uid = process.getuid?.() ?? null,
  platform = process.platform,
  protocolVersion = PROTOCOL_VERSION,
  realpath = fs.realpath,
} = {}) {
  if (typeof hostSocketPath !== "string" || !hostSocketPath) throw new TypeError("hostSocketPath is required");
  if (typeof codeFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(codeFingerprint)) {
    throw new TypeError("codeFingerprint must be a SHA-256 hex digest");
  }
  if (typeof providerEnvironmentId !== "string" || !/^[a-f0-9]{64}$/.test(providerEnvironmentId)) {
    throw new TypeError("providerEnvironmentId must be a SHA-256 hex digest");
  }
  if (typeof effectiveConfigId !== "string" || !/^[a-f0-9]{64}$/.test(effectiveConfigId)) {
    throw new TypeError("effectiveConfigId must be a SHA-256 hex digest");
  }
  if (!gitExecutableIdentity || typeof gitExecutableIdentity !== "object") {
    throw new TypeError("gitExecutableIdentity is required");
  }
  const executableKeys = ["realpath", "dev", "ino", "size", "mtimeNs"];
  if (Object.keys(gitExecutableIdentity).some((key) => !executableKeys.includes(key))) {
    throw new TypeError("gitExecutableIdentity contains unknown fields");
  }
  for (const key of executableKeys) {
    if (typeof gitExecutableIdentity[key] !== "string" || !gitExecutableIdentity[key]) {
      throw new TypeError(`gitExecutableIdentity.${key} must be a non-empty string`);
    }
  }
  if (gitExecutableIdentity.realpath.includes("\0") || executableKeys.slice(1).some((key) => !/^\d+$/.test(gitExecutableIdentity[key]))) {
    throw new TypeError("gitExecutableIdentity fields are invalid");
  }
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0) throw new TypeError("protocolVersion must be positive");
  const canonicalHostSocketPath = await canonicalExistingPath(hostSocketPath, realpath);
  const namespaceId = digest({
    protocolVersion,
    platform,
    uid: uid === null ? null : String(uid),
    canonicalHostSocketPath,
    codeFingerprint,
    providerEnvironmentId,
    effectiveConfigId,
    gitExecutableIdentity,
  });
  return Object.freeze({
    namespaceId,
    protocolVersion,
    platform,
    uid: uid === null ? null : String(uid),
    canonicalHostSocketPath,
    codeFingerprint,
    providerEnvironmentId,
    effectiveConfigId,
    gitExecutableIdentity: Object.freeze({ ...gitExecutableIdentity }),
  });
}

export async function validateOwnedRuntimeDirectory(directory, {
  uid = process.getuid?.() ?? null,
  lstat = fs.lstat,
} = {}) {
  let metadata;
  try { metadata = await lstat(directory); }
  catch (error) { throw identityError("RUNTIME_DIRECTORY_UNAVAILABLE", `cannot inspect ${directory}: ${error.message}`, error); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink?.()) {
    throw identityError("UNSAFE_RUNTIME_DIRECTORY", `${directory} is not a real directory`);
  }
  if (uid !== null && metadata.uid !== uid) {
    throw identityError("UNSAFE_RUNTIME_DIRECTORY", `${directory} is not owned by uid ${uid}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw identityError("UNSAFE_RUNTIME_DIRECTORY", `${directory} must not grant group or other access`);
  }
  return directory;
}

async function ensurePrivateDirectory(directory, { uid, mkdir, lstat }) {
  try { await mkdir(directory, { recursive: false, mode: 0o700 }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw identityError("RUNTIME_DIRECTORY_UNAVAILABLE", `cannot create ${directory}: ${error.message}`, error);
  }
  return validateOwnedRuntimeDirectory(directory, { uid, lstat });
}

async function safeConfiguredRuntimeRoot(directory, { uid, lstat }) {
  if (!directory) return false;
  try {
    await validateOwnedRuntimeDirectory(directory, { uid, lstat });
    return true;
  } catch {
    return false;
  }
}

export async function preparePrivateRuntimePaths({
  environment = process.env,
  namespaceId,
  uid = process.getuid?.() ?? null,
  shortTmpRoot = process.platform === "win32" ? os.tmpdir() : "/tmp",
  mkdir = fs.mkdir,
  lstat = fs.lstat,
} = {}) {
  if (typeof namespaceId !== "string" || !/^[a-f0-9]{64}$/.test(namespaceId)) {
    throw new TypeError("namespaceId must be a SHA-256 hex digest");
  }
  if (uid === null) throw identityError("UNSUPPORTED_USER_IDENTITY", "a numeric uid is required for private runtime paths");
  const configured = String(environment.XDG_RUNTIME_DIR || "");
  const configuredSafe = await safeConfiguredRuntimeRoot(configured, { uid, lstat });
  const roots = [
    ...(configuredSafe ? [path.join(configured, "siderail")] : []),
    path.join(shortTmpRoot, `siderail-${uid}`),
  ];
  let tooLong = false;
  let lastError;
  for (const root of roots) {
    const runtimeDirectory = path.join(root, `v${PROTOCOL_VERSION}-${namespaceId.slice(0, 40)}`);
    const socketPath = path.join(runtimeDirectory, "coordinator.sock");
    if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      tooLong = true;
      continue;
    }
    try {
      await ensurePrivateDirectory(root, { uid, mkdir, lstat });
      await ensurePrivateDirectory(runtimeDirectory, { uid, mkdir, lstat });
    } catch (error) {
      lastError = error;
      continue;
    }
    return Object.freeze({
      runtimeDirectory,
      socketPath,
      leasePath: path.join(runtimeDirectory, "owner.json"),
    });
  }
  if (lastError) throw lastError;
  throw identityError(
    tooLong ? "RUNTIME_PATH_TOO_LONG" : "RUNTIME_DIRECTORY_UNAVAILABLE",
    "cannot create a private coordinator runtime path",
  );
}

async function defaultRunGit({ cwd, args, gitExecutable, environment }) {
  return runCommand(gitExecutable, args, {
    cwd,
    baseEnv: environment,
    env: { GIT_OPTIONAL_LOCKS: "0" },
    stdoutEncoding: "utf8-strict",
    maxOutputBytes: 1024 * 1024,
  });
}

function stripFinalNewline(value) {
  return String(value).replace(/\r?\n$/, "");
}

async function gitValue(runGit, options, args) {
  const result = await runGit({ ...options, args });
  const value = stripFinalNewline(result?.stdout);
  if (!value) throw identityError("AMBIGUOUS_REPOSITORY", `git ${args.join(" ")} returned an empty path`);
  if (value.includes("\0")) throw identityError("AMBIGUOUS_REPOSITORY", `git ${args.join(" ")} returned NUL`);
  return value;
}

export async function resolveRepositoryIdentity({
  cwd,
  environment = process.env,
  executable = "git",
  executableIdentity,
  providerEnvironmentId = digestEffectiveGitEnvironment(environment),
  providerConfig = {},
  schedulerConfig = {},
  protocolVersion = PROTOCOL_VERSION,
  codeVersion = "",
  runGit = defaultRunGit,
  access = fs.access,
  realpath = fs.realpath,
  stat = fs.stat,
} = {}) {
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) throw new TypeError("cwd must be a non-empty path");
  const canonicalCwd = await canonicalExistingPath(cwd, realpath);
  const gitExecutable = executableIdentity || await resolveGitExecutableIdentity({
    environment, executable, cwd: canonicalCwd, access, realpath, stat,
  });
  const runOptions = {
    cwd: canonicalCwd,
    gitExecutable: gitExecutable.realpath,
    environment: { ...environment, GIT_OPTIONAL_LOCKS: "0" },
  };
  let rootValue;
  try { rootValue = await gitValue(runGit, runOptions, ["rev-parse", "--show-toplevel"]); }
  catch (error) {
    if (error instanceof GitStateIdentityError && error.code === "AMBIGUOUS_REPOSITORY") throw error;
    return Object.freeze({
      kind: "filesystem",
      canonicalCwd,
      worktreeRoot: "",
      gitDir: "",
      commonGitDir: "",
      indexPath: "",
      identityId: digest({
        kind: "filesystem",
        canonicalCwd,
        providerEnvironmentId,
        providerConfig,
        schedulerConfig,
        protocolVersion,
        codeVersion,
      }),
    });
  }
  const worktreeRoot = await canonicalExistingPath(path.resolve(canonicalCwd, rootValue), realpath);
  const gitRunOptions = { ...runOptions, cwd: worktreeRoot };
  let gitDirValue;
  let commonGitDirValue;
  let indexValue;
  try {
    [gitDirValue, commonGitDirValue, indexValue] = await Promise.all([
      gitValue(runGit, gitRunOptions, ["rev-parse", "--absolute-git-dir"]),
      gitValue(runGit, gitRunOptions, ["rev-parse", "--git-common-dir"]),
      gitValue(runGit, gitRunOptions, ["rev-parse", "--git-path", "index"]),
    ]);
  } catch (error) {
    throw identityError("AMBIGUOUS_REPOSITORY", `cannot resolve Git identity for ${worktreeRoot}`, error);
  }
  const gitDir = await canonicalExistingPath(path.resolve(worktreeRoot, gitDirValue), realpath);
  const commonGitDir = await canonicalExistingPath(path.resolve(worktreeRoot, commonGitDirValue), realpath);
  const indexPath = await canonicalProspectivePath(path.resolve(worktreeRoot, indexValue), realpath);
  return Object.freeze({
    kind: "git",
    canonicalCwd,
    worktreeRoot,
    gitDir,
    commonGitDir,
    indexPath,
    identityId: digest({
      kind: "git",
      worktreeRoot,
      gitDir,
      commonGitDir,
      indexPath,
      gitExecutable,
      providerEnvironmentId,
      providerConfig,
      schedulerConfig,
      protocolVersion,
      codeVersion,
    }),
  });
}
