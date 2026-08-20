#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "test"];
const files = roots.flatMap((root) => fs.readdirSync(root, { recursive: true })
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => path.join(root, name)));
let failed = false;
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.endsWith("\n") || source.split("\n").some((line) => /[ \t]+$/.test(line))) {
    console.error(`${file}: formatting check failed`);
    failed = true;
  }
  const check = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (check.status !== 0) failed = true;
}
if (failed) process.exit(1);
