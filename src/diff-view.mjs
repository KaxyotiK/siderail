import { sanitizeTerminalText } from "./terminal-ui.mjs";

const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;

export function parseUnifiedDiff(value) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let combinedParents = 0;
  let parentLines = [];

  for (const unsafeLine of String(value ?? "").replace(/\n$/, "").split("\n")) {
    // Git owns color CSI in this stream. Strip it before sanitizing repository
    // content so hunk/file prefixes remain machine-readable without allowing
    // any terminal control sequence through to the renderer.
    const sourceLine = sanitizeTerminalText(unsafeLine.replace(CSI, ""));
    const hunk = sourceLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      combinedParents = 0;
      parentLines = [];
      rows.push({ kind: "hunk", text: sourceLine });
      continue;
    }
    const combined = sourceLine.match(/^(@{3,}) ((?:-\d+(?:,\d+)? ){2,})\+(\d+)(?:,\d+)? \1(.*)$/);
    if (combined) {
      parentLines = [...combined[2].matchAll(/-(\d+)(?:,\d+)?/g)].map((match) => Number(match[1]));
      combinedParents = parentLines.length;
      newLine = Number(combined[3]);
      inHunk = true;
      rows.push({ kind: "hunk", text: sourceLine, combined: true });
      continue;
    }
    if (!inHunk) {
      if (/^(diff --(?:git|cc|combined) |index |--- |\+\+\+ )/.test(sourceLine)) continue;
      if (sourceLine) rows.push({ kind: "meta", text: sourceLine });
      continue;
    }
    if (combinedParents) {
      const markers = sourceLine.slice(0, combinedParents);
      if (markers.length !== combinedParents || !/^[ +\-]+$/.test(markers)) {
        if (sourceLine.startsWith("\\")) rows.push({ kind: "note", text: sourceLine });
        else if (sourceLine) rows.push({ kind: "meta", text: sourceLine });
        continue;
      }
      const text = sourceLine.slice(combinedParents);
      const oldLines = parentLines.map((line, index) => markers[index] === "+" ? null : line);
      parentLines = parentLines.map((line, index) => markers[index] === "+" ? line : line + 1);
      const deleted = markers.includes("-") && !markers.includes("+");
      const kind = deleted ? "deleted" : markers.includes("+") ? "added" : "context";
      rows.push({ kind, oldLines, oldLine: oldLines.find((line) => line !== null) ?? null, newLine: deleted ? null : newLine, text, combined: true });
      if (!deleted) newLine += 1;
    } else if (sourceLine.startsWith("+")) {
      rows.push({ kind: "added", oldLine: null, newLine, text: sourceLine.slice(1) });
      newLine += 1;
    } else if (sourceLine.startsWith("-")) {
      rows.push({ kind: "deleted", oldLine, newLine: null, text: sourceLine.slice(1) });
      oldLine += 1;
    } else if (sourceLine.startsWith(" ")) {
      rows.push({ kind: "context", oldLine, newLine, text: sourceLine.slice(1) });
      oldLine += 1;
      newLine += 1;
    } else if (sourceLine.startsWith("\\")) {
      rows.push({ kind: "note", text: sourceLine });
    } else if (sourceLine) {
      rows.push({ kind: "meta", text: sourceLine });
      inHunk = false;
      combinedParents = 0;
    }
  }
  return rows;
}
