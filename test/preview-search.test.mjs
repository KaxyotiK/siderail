import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SEARCH_CACHE_BYTES,
  MAX_SEARCH_QUERY_SCALARS,
  PreviewSearchIndex,
} from "../src/preview-search.mjs";

test("preview search normalizes content once and narrows prior candidates", () => {
  const index = new PreviewSearchIndex(["Alpha", "alphabet", "beta", "ALPINE"]);
  assert.deepEqual(index.matches("a").map((match) => match.row), [0, 1, 2, 3]);
  const examined = index.operations.examined;
  assert.deepEqual(index.matches("al").map((match) => match.row), [0, 1, 3]);
  assert.equal(index.operations.examined - examined, 4);
  assert.equal(index.operations.normalizations, 4);
  assert.deepEqual(index.matches("a").map((match) => match.row), [0, 1, 2, 3]);
  assert.equal(index.operations.normalizations, 4);
});

test("preview search restores cached prefixes, handles Unicode, and resets by content", () => {
  const index = new PreviewSearchIndex(["CAFÉ", "cafe", "λ-value"]);
  assert.deepEqual(index.matches("café").map((match) => match.row), [0]);
  assert.deepEqual(index.matches("caf").map((match) => match.row), [0, 1]);
  index.reset(["new café"]);
  assert.deepEqual(index.matches("café").map((match) => match.row), [0]);
  assert.equal(index.operations.normalizations, 1);
});

test("preview search bounds query and retained candidate memory", () => {
  const lines = Array.from({ length: 100_000 }, (_value, index) => `common row ${index}`);
  const index = new PreviewSearchIndex(lines);
  assert.equal([...index.clampQuery("x".repeat(300))].length, MAX_SEARCH_QUERY_SCALARS);
  index.matches("common");
  assert.ok(index.cacheBytes <= MAX_SEARCH_CACHE_BYTES);
  index.matches("missing");
  assert.ok(index.cacheBytes <= MAX_SEARCH_CACHE_BYTES);
});
