import assert from "node:assert/strict";
import test from "node:test";
import { FilesViewModelCache } from "../src/files-view-model.mjs";

test("20k-path files model materializes only the viewport at supported widths", () => {
  const files = Array.from({ length: 20_000 }, (_value, index) => ({ path: `folder-${String(index % 100).padStart(3, "0")}/file-${String(index).padStart(5, "0")}.txt` }));
  for (const width of [36, 52, 100]) {
    const cache = new FilesViewModelCache();
    const rows = cache.rows(`${width}`, files, { mode: width > 88 ? "tree" : "grouped", scope: "files" });
    const first = cache.materialize(rows, 0, 30, (row) => row.file?.path || row.folder || row.path);
    const middle = cache.materialize(rows, Math.floor(rows.length / 2), 30, (row) => row.file?.path || row.folder || row.path);
    const final = cache.materialize(rows, rows.length - 30, 30, (row) => row.file?.path || row.folder || row.path);
    assert.equal(first.length, 30);
    assert.equal(middle.length, 30);
    assert.equal(final.length, 30);
    assert.equal(cache.instrumentation.materializedRows, 90);
    assert.equal(cache.instrumentation.regenerations, 1);
    cache.rows(`${width}`, files, { mode: width > 88 ? "tree" : "grouped", scope: "files" });
    assert.equal(cache.instrumentation.regenerations, 1);
    cache.invalidate();
    cache.rows(`${width}`, files, { mode: width > 88 ? "tree" : "grouped", scope: "files" });
    assert.equal(cache.instrumentation.regenerations, 2);
  }
});
