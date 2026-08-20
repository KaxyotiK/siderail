const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

function plain(value) {
  return String(value ?? "").replace(ANSI_RE, "");
}

export function parseUnifiedDiff(value) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const sourceLine of plain(value).replace(/\n$/, "").split("\n")) {
    const hunk = sourceLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: sourceLine });
      continue;
    }
    if (!inHunk) {
      if (/^(diff --git |index |--- |\+\+\+ )/.test(sourceLine)) continue;
      if (sourceLine) rows.push({ kind: "meta", text: sourceLine });
      continue;
    }
    if (sourceLine.startsWith("+")) {
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
    }
  }
  return rows;
}

