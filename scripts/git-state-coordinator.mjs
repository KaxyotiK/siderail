#!/usr/bin/env node

import { runGitStateCoordinator } from "../src/git-state-runtime.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";

assertSupportedNode();

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : String(process.argv[index + 1] || "");
}

const runtime = await runGitStateCoordinator({
  expectedNamespaceId: argument("--namespace"),
  expectedSocketPath: argument("--socket"),
  expectedLeasePath: argument("--lease"),
  nonce: argument("--nonce"),
});
await runtime.done;
