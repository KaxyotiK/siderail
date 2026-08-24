#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function validateArchiveMembers(text) {
  const members = text.split(/\r?\n/).filter(Boolean).map((member) => member.replace(/^\.\//, ""));
  const forbidden = members.filter((member) => member === ".git-rail.json"
    || member === "schema" || member.startsWith("schema/")
    || member === "node_modules" || member.startsWith("node_modules/"));
  if (forbidden.length) throw new Error(`forbidden release archive members: ${forbidden.join(", ")}`);
  for (const required of ["herdr-plugin.toml", "package.json", "scripts/uninstall-herdr-plugin.mjs"]) {
    if (!members.includes(required)) throw new Error(`release archive is missing ${required}`);
  }
  return members;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const members = validateArchiveMembers(fs.readFileSync(0, "utf8"));
  process.stdout.write(`Verified ${members.length} release archive members\n`);
}
