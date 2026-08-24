import path from "node:path";

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
  const visit = (node, depth, parent = "") => {
    const children = [...node.children.values()].sort((a, b) => Boolean(a.file) - Boolean(b.file) || a.name.localeCompare(b.name));
    for (const child of children) {
      const nodePath = parent ? `${parent}/${child.name}` : child.name;
      if (child.file) rows.push({ kind: "file", depth, file: child.file, name: child.name });
      else {
        rows.push({ kind: "folder", depth, path: nodePath, name: child.name });
        if (!collapsed.has(nodePath)) visit(child, depth + 1, nodePath);
      }
    }
  };
  visit(root);
  return rows;
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
