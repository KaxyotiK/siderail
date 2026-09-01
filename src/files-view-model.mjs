import path from "node:path";

export function folderStateScope(scope, query = "") {
  return query.trim() ? `${scope}:search` : scope;
}

export function filesContentSignature(files) {
  let hash = 2166136261;
  for (const file of files) {
    const value = [
      file.path,
      file.status,
      file.additions,
      file.deletions,
      file.binary,
      file.statsUnavailable,
      file.oldPath,
      file.descriptor?.kind,
      file.descriptor?.baseRef,
      file.descriptor?.commitHash,
    ].join("\0");
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${files.length}:${(hash >>> 0).toString(36)}`;
}

export function folderCollapseKeys(files, { mode, scope = "files" }) {
  const keys = new Set();
  for (const file of files) {
    const parts = file.path.split("/");
    if (mode === "grouped") {
      const folder = path.dirname(file.path) === "." ? "" : path.dirname(file.path);
      if (folder) keys.add(`${scope}:${folder}`);
      continue;
    }
    for (let index = 1; index < parts.length; index += 1) keys.add(parts.slice(0, index).join("/"));
  }
  return keys;
}

export function syncFolderCollapseState(collapsed, knownFolders, discoveredFolders, expandByDefault = false) {
  for (const key of discoveredFolders) {
    if (!knownFolders.has(key) && !expandByDefault) collapsed.add(key);
    knownFolders.add(key);
  }
}

export function toggleFolderCollapseState(collapsed, key) {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
}

function treeRows(files, collapsed) {
  const root = { children: new Map() };
  for (const file of files) {
    let node = root;
    file.path.split("/").forEach((part, index, parts) => {
      if (!node.children.has(part)) node.children.set(part, { name: part, file: index === parts.length - 1 ? file : null, children: new Map() });
      node = node.children.get(part);
    });
  }
  const rows = [];
  const visit = (node, depth, parent = "", ancestorContinues = []) => {
    const children = [...node.children.values()].sort((a, b) => Boolean(a.file) - Boolean(b.file) || a.name.localeCompare(b.name));
    children.forEach((child, index) => {
      const nodePath = parent ? `${parent}/${child.name}` : child.name;
      const isLast = index === children.length - 1;
      const branch = { depth, ancestorContinues, isLast };
      if (child.file) rows.push({ kind: "file", ...branch, file: child.file, name: child.name });
      else {
        rows.push({ kind: "folder", ...branch, path: nodePath, name: child.name });
        if (!collapsed.has(nodePath)) {
          const childAncestors = depth === 0 ? [] : [...ancestorContinues, !isLast];
          visit(child, depth + 1, nodePath, childAncestors);
        }
      }
    });
  };
  visit(root, 0);
  return rows;
}

export function treeBranchPrefix(row, width) {
  if (!row.depth) return "";
  const narrow = width <= 46;
  const ancestors = row.ancestorContinues
    .map((continues) => continues ? (narrow ? "│ " : "│  ") : (narrow ? "  " : "   "))
    .join("");
  return `${ancestors}${row.isLast ? "└─ " : "├─ "}`;
}

function groupedRows(files, collapsed, scope) {
  const groups = new Map();
  for (const file of files) {
    const folder = path.dirname(file.path) === "." ? "" : path.dirname(file.path);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(file);
  }
  const rows = [];
  for (const [folder, entries] of [...groups.entries()].sort(([left], [right]) => {
    if (!left && right) return 1;
    if (left && !right) return -1;
    return left.localeCompare(right);
  })) {
    entries.sort((a, b) => a.path.localeCompare(b.path));
    if (!folder) {
      rows.push(...entries.map((file) => ({ kind: "file", file, prefix: " " })));
      continue;
    }
    const key = `${scope}:${folder}`;
    const open = !collapsed.has(key);
    rows.push({ kind: "group", folder, count: entries.length, key, open });
    if (open) rows.push(...entries.map((file, index) => ({
      kind: "file",
      file,
      prefix: index === entries.length - 1 ? "last" : "middle",
    })));
  }
  return rows;
}

export class FilesViewModelCache {
  constructor() {
    this.cache = new Map();
    this.instrumentation = { regenerations: 0, materializedRows: 0 };
  }

  invalidate() {
    this.cache.clear();
  }

  rows(key, files, { mode, collapsed = new Set(), scope = "files" }) {
    if (this.cache.has(key)) return this.cache.get(key);
    const rows = mode === "tree" ? treeRows(files, collapsed) : groupedRows(files, collapsed, scope);
    this.cache.set(key, rows);
    this.instrumentation.regenerations += 1;
    return rows;
  }

  materialize(rows, offset, height, render) {
    const visible = rows.slice(offset, offset + height);
    this.instrumentation.materializedRows += visible.length;
    return visible.map(render);
  }
}
