// Repository data is untrusted terminal input. Keep application-owned ANSI outside
// this boundary and sanitize every value before interpolating it into a frame.
const STRING_CONTROL = /(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c)/g;
const OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const COMBINING = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}/u;

export function sanitizeTerminalText(value, replacement = "�") {
  return String(value ?? "")
    .replace(OSC, replacement)
    .replace(STRING_CONTROL, replacement)
    .replace(CSI, replacement)
    .replace(/\u001b./gs, replacement)
    .replace(/\u001b/g, replacement)
    .replace(CONTROL, replacement)
    .replace(BIDI_CONTROL, replacement);
}

function terminalWidth(value) {
  let width = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (COMBINING.test(character) || point === 0xfe0f || point === 0x200d) continue;
    const wide = EMOJI.test(character)
      || point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
        || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3
        || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f
        || point >= 0xff00 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
        || point >= 0x20000 && point <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

export function truncateTerminalColumns(value, maxColumns) {
  const clean = sanitizeTerminalText(value);
  if (terminalWidth(clean) <= maxColumns) return clean;
  const limit = Math.max(0, maxColumns - 1);
  let result = "";
  for (const character of clean) {
    if (terminalWidth(result + character) > limit) break;
    result += character;
  }
  return `${result}…`;
}

export function previewTabName(filePath, maxColumns = 32) {
  const normalized = String(filePath ?? "").replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) || "Preview";
  return truncateTerminalColumns(basename, maxColumns);
}

export function startupFailureState(cwd, error) {
  return {
    cwd,
    repoRoot: "",
    repository: "GitRail unavailable",
    branch: "—",
    baseLabel: "main",
    files: [],
    againstBase: [],
    staged: [],
    unstaged: [],
    commits: [],
    totalCommits: 0,
    configErrors: [],
    config: { refresh: { pollIntervalMs: 5000 }, limits: { maxDiffBytes: 4 * 1024 * 1024 } },
    error: `Could not load Git state: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export function previewInitialMode(descriptor, metadata) {
  return descriptor?.kind === "clean" || metadata?.status === "clean" ? "raw" : "diff";
}

export function commitComparisonSource(descriptor) {
  return descriptor?.comparison === "first-parent" && descriptor?.parentHash === "" ? "empty tree" : "first parent";
}
