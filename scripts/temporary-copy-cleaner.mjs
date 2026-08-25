#!/usr/bin/env node
import { assertSupportedNode } from "../src/node-version.mjs";
import { runTemporaryCopyCleaner } from "../src/temporary-copy-retention.mjs";

assertSupportedNode();
const [temporaryRoot, lockDirectory] = process.argv.slice(2);
if (!temporaryRoot || !lockDirectory) throw new Error("Missing GitRail retention-worker paths");
await runTemporaryCopyCleaner(temporaryRoot, lockDirectory);
