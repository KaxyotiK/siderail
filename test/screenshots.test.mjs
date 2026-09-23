import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { pngDimensions, verifyScreenshotMetadata } from "../scripts/verify-screenshots.mjs";

test("release screenshots have the declared dimensions and resolvable source commits", () => {
  const result = verifyScreenshotMetadata({ resolveCommits: false });
  assert.equal(result.candidateSha, null);
  assert.match(result.visualSourceSha, /^[0-9a-f]{40}$/);
  assert.match(result.captureSourceSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(pngDimensions(fs.readFileSync("docs/screenshots/siderail-52.png")), {
    pixelWidth: 660,
    pixelHeight: 2108,
  });
});
