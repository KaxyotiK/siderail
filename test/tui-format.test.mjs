import assert from "node:assert/strict";
import test from "node:test";
import { compactAge } from "../src/tui-format.mjs";

test("compact commit ages preserve value and unit", () => {
  assert.equal(compactAge("just now"), "now");
  assert.equal(compactAge("5 minutes ago"), "5m");
  assert.equal(compactAge("an hour ago"), "1h");
  assert.equal(compactAge("3 days ago"), "3d");
  assert.equal(compactAge("2 weeks ago"), "2w");
  assert.equal(compactAge("8 months ago"), "8mo");
  assert.equal(compactAge("1 year ago"), "1y");
});
