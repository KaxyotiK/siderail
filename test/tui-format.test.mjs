import assert from "node:assert/strict";
import test from "node:test";
import { compactAge, compareFolderGroups, neutralFileGlyph } from "../src/tui-format.mjs";

test("compact commit ages preserve value and unit", () => {
  assert.equal(compactAge("just now"), "now");
  assert.equal(compactAge("5 minutes ago"), "5m");
  assert.equal(compactAge("an hour ago"), "1h");
  assert.equal(compactAge("3 days ago"), "3d");
  assert.equal(compactAge("2 weeks ago"), "2w");
  assert.equal(compactAge("8 months ago"), "8mo");
  assert.equal(compactAge("1 year ago"), "1y");
});

test("root files sort after every folder group", () => {
  const groups = [["", []], ["src", []], ["docs", []], [".github/workflows", []]];
  assert.deepEqual(groups.sort(compareFolderGroups).map(([folder]) => folder), [".github/workflows", "docs", "src", ""]);
});

test("neutral files use distinct one-column glyphs by type", () => {
  assert.equal(neutralFileGlyph({ path: "README.md" }), "≡");
  assert.equal(neutralFileGlyph({ path: "src/index.mjs" }), "λ");
  assert.equal(neutralFileGlyph({ path: "config.toml" }), "◇");
  assert.equal(neutralFileGlyph({ path: "logo.png" }), "▧");
  assert.equal(neutralFileGlyph({ path: "release.tgz" }), "▣");
  assert.equal(neutralFileGlyph({ path: "run", executable: true }), "▶");
  assert.equal(neutralFileGlyph({ path: "current", symlink: true }), "↗");
  assert.equal(neutralFileGlyph({ path: "LICENSE" }), "□");
});
