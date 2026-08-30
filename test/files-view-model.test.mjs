import assert from "node:assert/strict";
import test from "node:test";
import { FilesViewModelCache, folderCollapseKeys, treeBranchPrefix } from "../src/files-view-model.mjs";

test("folder collapse keys cover every tree ancestor and grouped folder", () => {
  const files = [
    { path: "docs/screenshots/capture.png" },
    { path: "docs/INSTALLATION.md" },
    { path: "README.md" },
  ];
  assert.deepEqual([...folderCollapseKeys(files, { mode: "tree" })].sort(), ["docs", "docs/screenshots"]);
  assert.deepEqual([...folderCollapseKeys(files, { mode: "grouped", scope: "files" })].sort(), [
    "files:docs",
    "files:docs/screenshots",
  ]);
});

test("tree rows retain enough ancestry to distinguish siblings from nested children", () => {
  const files = [
    { path: "docs/screenshots/capture.png" },
    { path: "docs/INSTALLATION.md" },
    { path: "test/helpers/environment.mjs" },
    { path: "test/auto-open.test.mjs" },
    { path: "README.md" },
  ];
  const rows = new FilesViewModelCache().rows("branches", files, { mode: "tree" });
  const shape = rows.map((row) => ({
    name: row.name,
    depth: row.depth,
    ancestorContinues: row.ancestorContinues,
    isLast: row.isLast,
  }));
  assert.deepEqual(shape, [
    { name: "docs", depth: 0, ancestorContinues: [], isLast: false },
    { name: "screenshots", depth: 1, ancestorContinues: [], isLast: false },
    { name: "capture.png", depth: 2, ancestorContinues: [true], isLast: true },
    { name: "INSTALLATION.md", depth: 1, ancestorContinues: [], isLast: true },
    { name: "test", depth: 0, ancestorContinues: [], isLast: false },
    { name: "helpers", depth: 1, ancestorContinues: [], isLast: false },
    { name: "environment.mjs", depth: 2, ancestorContinues: [true], isLast: true },
    { name: "auto-open.test.mjs", depth: 1, ancestorContinues: [], isLast: true },
    { name: "README.md", depth: 0, ancestorContinues: [], isLast: true },
  ]);
  assert.equal(treeBranchPrefix(rows[1], 36), "├─ ");
  assert.equal(treeBranchPrefix(rows[2], 36), "│ └─ ");
  assert.equal(treeBranchPrefix(rows[2], 100), "│  └─ ");
  assert.equal(treeBranchPrefix(rows[3], 100), "└─ ");
  assert.equal(treeBranchPrefix(rows[0], 100), "");
});

test("20k-path files model materializes only the viewport at supported widths", () => {
  const files = Array.from({ length: 20_000 }, (_value, index) => ({ path: `folder-${String(index % 100).padStart(3, "0")}/file-${String(index).padStart(5, "0")}.txt` }));
  for (const width of [36, 52, 100]) {
    const cache = new FilesViewModelCache();
    const rows = cache.rows(`${width}`, files, { mode: width > 88 ? "tree" : "grouped", scope: "files" });
    const selectablePaths = rows.filter((row) => row.kind === "file").map((row) => row.file.path);
    const first = cache.materialize(rows, 0, 30, (row) => row.file?.path || row.folder || row.path);
    const middle = cache.materialize(rows, Math.floor(rows.length / 2), 30, (row) => row.file?.path || row.folder || row.path);
    const final = cache.materialize(rows, rows.length - 30, 30, (row) => row.file?.path || row.folder || row.path);
    assert.equal(first.length, 30);
    assert.equal(middle.length, 30);
    assert.equal(final.length, 30);
    assert.equal(cache.instrumentation.materializedRows, 90);
    assert.equal(cache.instrumentation.regenerations, 1);
    assert.equal(selectablePaths.length, files.length);
    assert.ok(selectablePaths.includes(files[0].path));
    assert.ok(selectablePaths.includes(files[Math.floor(files.length / 2)].path));
    assert.ok(selectablePaths.includes(files.at(-1).path));
    cache.rows(`${width}`, files, { mode: width > 88 ? "tree" : "grouped", scope: "files" });
    assert.equal(cache.instrumentation.regenerations, 1);
    cache.invalidate();
    cache.rows(`${width}`, files, { mode: width > 88 ? "tree" : "grouped", scope: "files" });
    assert.equal(cache.instrumentation.regenerations, 2);
    cache.rows(`${width}:search`, files.slice(0, 20), { mode: width > 88 ? "tree" : "grouped", scope: "files:search" });
    cache.rows(`${width}:resize`, files, { mode: "tree", scope: "files" });
    cache.rows(`${width}:view`, files, { mode: "grouped", scope: "files" });
    cache.rows(`${width}:collapse`, files, { mode: "tree", collapsed: new Set(["folder-000"]), scope: "files" });
    cache.invalidate();
    cache.rows(`${width}:refresh`, files, { mode: width > 88 ? "tree" : "grouped", scope: "files" });
    assert.equal(cache.instrumentation.regenerations, 7);
  }
});
