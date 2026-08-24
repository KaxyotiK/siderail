function splitNul(output) {
  const parts = String(output || "").split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

export function statusName(code) {
  if (code === "A" || code === "?") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  if (code === "U") return "conflicted";
  if (code === "T") return "type-changed";
  return "modified";
}

export function parseCommitLogZ(output) {
  const fields = splitNul(output);
  const commits = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [hash, shortHash, message, author, age] = fields.slice(index, index + 5);
    if (hash) commits.push({ hash, shortHash, message, author, age });
  }
  return commits;
}

export function parseCommitPathsRawLogZ(output) {
  const tokens = splitNul(output);
  const pathsByCommit = new Map();
  let currentPaths;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index].replace(/^\n/, "");
    if (/^[0-9a-f]{40}$/i.test(token)) {
      currentPaths = [];
      pathsByCommit.set(token, currentPaths);
      index += 1;
      continue;
    }
    if (!currentPaths || !token.startsWith(":")) {
      index += 1;
      continue;
    }
    const statusToken = token.slice(1).split(" ").at(-1) || "";
    const pathCount = statusToken[0] === "R" || statusToken[0] === "C" ? 2 : 1;
    for (let offset = 1; offset <= pathCount && index + offset < tokens.length; offset += 1) {
      currentPaths.push(tokens[index + offset]);
    }
    index += pathCount + 1;
  }
  return pathsByCommit;
}

export function parsePorcelainV2Z(output) {
  const tokens = splitNul(output);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record || record[0] === "#" || record[0] === "!") continue;
    if (record.startsWith("? ")) {
      entries.push({ path: record.slice(2), indexCode: "?", worktreeCode: "?", untracked: true });
      continue;
    }
    const fields = record.split(" ");
    const kind = fields[0];
    if (kind === "1" && fields.length >= 9) {
      const xy = fields[1];
      entries.push({
        path: fields.slice(8).join(" "),
        indexCode: xy[0],
        worktreeCode: xy[1],
        submodule: fields[2] !== "N...",
        headMode: fields[3],
        indexMode: fields[4],
        worktreeMode: fields[5],
      });
    } else if (kind === "2" && fields.length >= 10) {
      const xy = fields[1];
      entries.push({
        path: fields.slice(9).join(" "),
        oldPath: tokens[++index] || "",
        indexCode: xy[0],
        worktreeCode: xy[1],
        submodule: fields[2] !== "N...",
        headMode: fields[3],
        indexMode: fields[4],
        worktreeMode: fields[5],
        score: fields[8],
      });
    } else if (kind === "u" && fields.length >= 11) {
      entries.push({
        path: fields.slice(10).join(" "),
        indexCode: "U",
        worktreeCode: "U",
        conflict: fields[1],
        submodule: fields[2] !== "N...",
      });
    }
  }
  return entries;
}

function parseNumstatZ(output) {
  const tokens = splitNul(output);
  const stats = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    let oldPath;
    if (!filePath) {
      oldPath = tokens[++index] || "";
      filePath = tokens[++index] || "";
    }
    if (!filePath) continue;
    stats.set(filePath, {
      additions: additionsText === "-" ? 0 : Number.parseInt(additionsText, 10) || 0,
      deletions: deletionsText === "-" ? 0 : Number.parseInt(deletionsText, 10) || 0,
      binary: additionsText === "-" && deletionsText === "-",
      ...(oldPath ? { oldPath } : {}),
    });
  }
  return stats;
}

export function parseLsFilesStageZ(output) {
  return splitNul(output).map((record) => {
    const tab = record.indexOf("\t");
    const metadata = record.slice(0, tab).split(" ");
    return { path: record.slice(tab + 1), mode: metadata[0], objectId: metadata[1], stage: Number(metadata[2]) };
  }).filter((entry) => entry.path);
}

function parseRawDiffTokens(tokens) {
  const metadata = new Map();
  let index = 0;
  while (index < tokens.length) {
    const header = tokens[index++];
    if (!header?.startsWith(":")) {
      index -= 1;
      break;
    }
    const [oldMode, newMode, oldObjectId, newObjectId, statusToken] = header.slice(1).split(" ");
    const status = statusToken?.[0] || "M";
    let oldPath;
    let filePath;
    if (status === "R" || status === "C") {
      oldPath = tokens[index++] || "";
      filePath = tokens[index++] || "";
    } else filePath = tokens[index++] || "";
    if (!filePath) continue;
    metadata.set(filePath, {
      path: filePath,
      status: statusName(status),
      ...(statusToken?.slice(1) ? { score: statusToken.slice(1) } : {}),
      mode: newMode,
      oldMode,
      newMode,
      oldObjectId,
      newObjectId,
      executableChange: oldMode !== newMode && (oldMode === "100755" || newMode === "100755"),
      executable: newMode === "100755",
      oldSymlink: oldMode === "120000",
      symlink: newMode === "120000",
      oldSubmodule: oldMode === "160000",
      submodule: newMode === "160000",
      ...(oldPath ? { oldPath } : {}),
    });
  }
  return { metadata, nextIndex: index };
}

export function parseRawNumstatZ(output) {
  const tokens = splitNul(output);
  const { metadata, nextIndex } = parseRawDiffTokens(tokens);
  // With `--raw --numstat -z`, Git writes the complete raw section first and
  // the numstat section second. Consume the structured raw records to find the
  // boundary instead of guessing from path text, which may itself contain tabs.
  const stats = parseNumstatZ(tokens.slice(nextIndex).join("\0"));
  return mergeStats([...metadata.values()], stats);
}

function mergeStats(files, stats) {
  return files.map((file) => ({
    ...file,
    ...(stats.get(file.path) || { additions: 0, deletions: 0, binary: false }),
  }));
}
