// Repository data is untrusted terminal input. Keep application-owned ANSI outside
// this boundary and sanitize every value before interpolating it into a frame.
const STRING_CONTROL = /(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c)/g;
const OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const COMBINING = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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

export function sanitizeRendererAnsi(value, replacement = "�") {
  const text = String(value ?? "")
    .replace(OSC, replacement)
    .replace(STRING_CONTROL, replacement);
  let result = "";
  let offset = 0;
  CSI.lastIndex = 0;
  for (const match of text.matchAll(CSI)) {
    result += sanitizeTerminalText(text.slice(offset, match.index), replacement);
    result += /^(?:\u001b\[|\u009b)[0-9;:]*m$/.test(match[0]) ? match[0] : replacement;
    offset = match.index + match[0].length;
  }
  return result + sanitizeTerminalText(text.slice(offset), replacement);
}

export function stripTerminalAnsi(value) {
  return String(value ?? "").replace(CSI, "");
}

function graphemeWidth(value) {
  if (!value || [...value].every((character) => COMBINING.test(character))) return 0;
  if (EMOJI.test(value) || EMOJI_PRESENTATION.test(value) || REGIONAL_INDICATOR.test(value) || value.includes("\u20e3")) return 2;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
      || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3
      || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f
      || point >= 0xff00 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
      || point >= 0x20000 && point <= 0x3fffd)) return 2;
  }
  return 1;
}

export function terminalColumns(value) {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(stripTerminalAnsi(value))) {
    width += graphemeWidth(segment);
  }
  return width;
}

export function truncateTerminalColumns(value, maxColumns) {
  const clean = sanitizeTerminalText(value);
  if (terminalColumns(clean) <= maxColumns) return clean;
  if (maxColumns <= 0) return "";
  const limit = Math.max(0, maxColumns - 1);
  let result = "";
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(clean)) {
    const nextWidth = graphemeWidth(segment);
    if (width + nextWidth > limit) break;
    result += segment;
    width += nextWidth;
  }
  return `${result}…`;
}

export function fitAnsiTerminalColumns(value, maxColumns) {
  const text = String(value ?? "");
  if (terminalColumns(text) <= maxColumns) return text;
  if (maxColumns <= 0) return "";
  const limit = Math.max(0, maxColumns - 1);
  const reset = text.includes("\u001b[") ? "\u001b[0m" : "";
  let result = "";
  let width = 0;
  let offset = 0;
  CSI.lastIndex = 0;
  for (const match of text.matchAll(CSI)) {
    const plain = text.slice(offset, match.index);
    for (const { segment } of GRAPHEMES.segment(plain)) {
      const nextWidth = graphemeWidth(segment);
      if (width + nextWidth > limit) return `${result}…${reset}`;
      result += segment;
      width += nextWidth;
    }
    result += match[0];
    offset = match.index + match[0].length;
  }
  for (const { segment } of GRAPHEMES.segment(text.slice(offset))) {
    const nextWidth = graphemeWidth(segment);
    if (width + nextWidth > limit) break;
    result += segment;
    width += nextWidth;
  }
  return `${result}…${reset}`;
}

export function sliceAnsiTerminalColumns(value, startColumn, maxColumns) {
  const text = String(value ?? "");
  const start = Math.max(0, startColumn || 0);
  if (maxColumns <= 0) return "";
  let prefix = "";
  let result = "";
  let column = 0;
  let resultWidth = 0;
  let offset = 0;
  let started = false;
  let stopped = false;
  CSI.lastIndex = 0;
  const appendPlain = (plain) => {
    for (const { segment } of GRAPHEMES.segment(plain)) {
      const width = graphemeWidth(segment);
      const nextColumn = column + width;
      if (nextColumn <= start) {
        column = nextColumn;
        continue;
      }
      if (column < start && nextColumn > start) {
        column = nextColumn;
        continue;
      }
      if (resultWidth + width > maxColumns) return false;
      if (!started) { result += prefix; started = true; }
      result += segment;
      resultWidth += width;
      column = nextColumn;
    }
    return true;
  };
  for (const match of text.matchAll(CSI)) {
    if (!appendPlain(text.slice(offset, match.index))) { stopped = true; break; }
    if (started) result += match[0]; else prefix += match[0];
    offset = match.index + match[0].length;
  }
  if (!stopped && resultWidth < maxColumns) appendPlain(text.slice(offset));
  return `${result}${text.includes("\u001b[") ? "\u001b[0m" : ""}`;
}

export function wrapAnsiTerminalLines(lines, maxColumns, gutterColumns = 0, continuationGutter = "") {
  const width = Math.max(1, maxColumns);
  const gutter = Math.min(Math.max(0, gutterColumns), Math.max(0, width - 1));
  const textWidth = Math.max(1, width - gutter);
  const fittedContinuation = fitAnsiTerminalColumns(continuationGutter, gutter);
  const continuation = gutter ? `${fittedContinuation}${" ".repeat(Math.max(0, gutter - terminalColumns(fittedContinuation)))}` : "";
  const rows = [];
  for (const [sourceRow, line] of lines.entries()) {
    const lineWidth = terminalColumns(line);
    const pieces = [];
    let pendingAnsi = "";
    let activeStyle = "";
    let column = 0;
    let offset = 0;
    const updateStyle = (style, sequence) => {
      if (!/^(?:\u001b\[|\u009b)[0-9;:]*m$/.test(sequence)) return style;
      const parameters = sequence.replace(/^(?:\u001b\[|\u009b)|m$/g, "").split(/[;:]/);
      const resets = parameters.includes("") || parameters.includes("0");
      if (!resets) {
        const combined = `${style}${sequence}`;
        return combined.length <= 2048 ? combined : sequence.length <= 2048 ? sequence : "";
      }
      return parameters.every((parameter) => !parameter || parameter === "0") ? "" : sequence;
    };
    const appendPlain = (plain) => {
      for (const { segment } of GRAPHEMES.segment(plain)) {
        const segmentWidth = graphemeWidth(segment);
        const nextColumn = column + segmentWidth;
        if (nextColumn <= gutter) {
          column = nextColumn;
          continue;
        }
        if (column < gutter) {
          column = nextColumn;
          continue;
        }
        pieces.push({ text: `${pendingAnsi}${segment}`, width: segmentWidth, wordBreak: /^\s+$/u.test(segment) });
        pendingAnsi = "";
        column = nextColumn;
      }
    };
    CSI.lastIndex = 0;
    for (const match of line.matchAll(CSI)) {
      appendPlain(line.slice(offset, match.index));
      if (column < gutter) activeStyle = updateStyle(activeStyle, match[0]);
      else pendingAnsi += match[0];
      offset = match.index + match[0].length;
    }
    appendPlain(line.slice(offset));
    let pieceIndex = 0;
    let startColumn = Math.min(gutter, lineWidth);
    let index = 0;
    do {
      let endIndex = pieceIndex;
      let usedColumns = 0;
      let wordEndIndex = pieceIndex;
      let wordEndColumns = 0;
      while (endIndex < pieces.length && usedColumns + pieces[endIndex].width <= textWidth) {
        usedColumns += pieces[endIndex].width;
        endIndex += 1;
        if (pieces[endIndex - 1].wordBreak) {
          wordEndIndex = endIndex;
          wordEndColumns = usedColumns;
        }
      }
      if (endIndex < pieces.length && wordEndColumns >= Math.ceil(textWidth / 3)) {
        endIndex = wordEndIndex;
        usedColumns = wordEndColumns;
      }
      if (endIndex === pieceIndex && pieceIndex < pieces.length) {
        usedColumns = pieces[pieceIndex].width;
        endIndex += 1;
      }
      const prefix = index === 0 ? sliceAnsiTerminalColumns(line, 0, gutter) : continuation;
      let text = `${prefix}${activeStyle}`;
      for (let current = pieceIndex; current < endIndex; current += 1) {
        text += pieces[current].text;
        CSI.lastIndex = 0;
        for (const match of pieces[current].text.matchAll(CSI)) activeStyle = updateStyle(activeStyle, match[0]);
      }
      if (endIndex === pieces.length) text += pendingAnsi;
      if (line.includes("\u001b[") || line.includes("\u009b")) text += "\u001b[0m";
      rows.push({
        text,
        sourceRow,
        startColumn,
        endColumn: startColumn + usedColumns,
      });
      startColumn += usedColumns;
      pieceIndex = endIndex;
      index += 1;
    } while (pieceIndex < pieces.length);
  }
  return rows;
}

export function padAnsiTerminalColumns(value, columns) {
  const fitted = fitAnsiTerminalColumns(value, columns);
  return `${fitted}${" ".repeat(Math.max(0, columns - terminalColumns(fitted)))}`;
}

export function compactTerminalPath(value, maxColumns) {
  const clean = sanitizeTerminalText(value);
  if (terminalColumns(clean) <= maxColumns) return clean;
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2) return truncateTerminalColumns(clean, maxColumns);
  const candidate = `${parts[0]}/…/${parts.at(-1)}`;
  if (terminalColumns(candidate) <= maxColumns) return candidate;
  const prefix = "…/";
  if (terminalColumns(prefix) >= maxColumns) return truncateTerminalColumns(clean, maxColumns);
  return `${prefix}${truncateTerminalColumns(parts.at(-1), Math.max(0, maxColumns - terminalColumns(prefix)))}`;
}

export function validPollInterval(value, fallback = 10_000) {
  return Number.isInteger(value) && value >= 1_000 && value <= 300_000 ? value : fallback;
}

export function jitteredPollInterval(interval, random = Math.random) {
  const boundedRandom = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.max(1, Math.round(interval * (0.9 + boundedRandom * 0.2)));
}

export function refreshStatusAfterSuccess(status, configErrors = []) {
  if (configErrors[0]) return configErrors[0];
  return String(status).startsWith("Refresh failed:") ? "Git state current" : status;
}

export function createCoalescedScheduler(callback, {
  delayMs = 125,
  minimumIntervalMs = 2_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  return {
    schedule() {
      if (timer) return;
      const wait = Math.max(delayMs, lastRunAt + minimumIntervalMs - now());
      timer = setTimer(() => {
        timer = undefined;
        lastRunAt = now();
        callback();
      }, wait);
      timer.unref?.();
    },
    cancel() {
      clearTimer(timer);
      timer = undefined;
    },
  };
}

export function stripSgrMouseEvents(value) {
  return String(value ?? "").replace(/\u001b\[<\d+;\d+;\d+[Mm]/g, "");
}

export function createTerminalInputDecoder(onEvent, escapeDelayMs = 12) {
  let pending = "";
  let timer;
  const scheduleFlush = () => {
    clearTimeout(timer);
    timer = setTimeout(() => drain(true), escapeDelayMs);
    timer.unref?.();
  };
  const drain = (force = false) => {
    clearTimeout(timer);
    timer = undefined;
    while (pending) {
      if (pending.startsWith("\u001b[")) {
        const complete = pending.match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
        if (complete) {
          pending = pending.slice(complete[0].length);
          onEvent(complete[0]);
          continue;
        }
        if (!force && /^\u001b\[[0-?]*[ -/]*$/.test(pending)) { scheduleFlush(); return; }
      } else if (pending === "\u001b" && !force) {
        scheduleFlush();
        return;
      }
      const event = Array.from(pending)[0];
      pending = pending.slice(event.length);
      onEvent(event);
    }
  };
  return {
    push(value) { pending += String(value ?? ""); drain(false); },
    flush() { drain(true); },
  };
}

export function commitExpansionState(query, matchingPaths, manuallyOpen, detailsLoaded) {
  const searching = Boolean(String(query ?? "").trim());
  const pathMatchOpen = searching && matchingPaths.length > 0;
  const open = searching ? pathMatchOpen || manuallyOpen : manuallyOpen;
  return {
    open,
    showAllFiles: searching && manuallyOpen && !pathMatchOpen,
    loading: open && !detailsLoaded && (!searching || manuallyOpen && !pathMatchOpen),
  };
}

export function createLatestSerialQueue(handler) {
  let generation = 0;
  let tail = Promise.resolve();
  return (value) => {
    const requestGeneration = ++generation;
    const task = tail.catch(() => {}).then(() => requestGeneration === generation ? handler(value) : undefined);
    tail = task;
    return task;
  };
}

export function createPointerClickTracker({ doubleClickIntervalMs = 700, clock = Date.now } = {}) {
  let previousIdentity = "";
  let previousAt = 0;
  return (identity) => {
    const currentIdentity = String(identity || "");
    const currentAt = clock();
    const elapsed = currentAt - previousAt;
    const isDoubleClick = Boolean(currentIdentity)
      && currentIdentity === previousIdentity
      && elapsed >= 0
      && elapsed <= doubleClickIntervalMs;
    previousIdentity = isDoubleClick ? "" : currentIdentity;
    previousAt = isDoubleClick ? 0 : currentAt;
    return isDoubleClick;
  };
}

export function activatePointerTarget(target, trackClick, report = (value) => value) {
  const doubleClick = trackClick(target?.label);
  if (target?.doubleAction && doubleClick) {
    report(target.doubleAction());
    return "double";
  }
  target?.action?.();
  return target ? "single" : "none";
}

export function interruptPointerClickSequence({ key = "", button = -1, phase = "" } = {}, trackClick) {
  const interrupted = Boolean(key) || phase === "M" && (button === 64 || button === 65);
  if (interrupted) trackClick("");
  return interrupted;
}

export function revealScrollOffset(rowIndex, currentOffset, visibleRows, totalRows) {
  const maximum = Math.max(0, totalRows - visibleRows);
  if (rowIndex < 0 || visibleRows <= 0) return Math.max(0, Math.min(currentOffset, maximum));
  if (rowIndex < currentOffset) return Math.max(0, Math.min(rowIndex, maximum));
  if (rowIndex >= currentOffset + visibleRows) return Math.max(0, Math.min(rowIndex - visibleRows + 1, maximum));
  return Math.max(0, Math.min(currentOffset, maximum));
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
  return descriptor?.kind === "clean" || descriptor?.kind === "filesystem" || metadata?.status === "clean" ? "raw" : "diff";
}

export function commitComparisonSource(descriptor) {
  return descriptor?.comparison === "first-parent" && descriptor?.parentHash === "" ? "empty tree" : "first parent";
}
