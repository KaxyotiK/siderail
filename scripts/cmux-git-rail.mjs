#!/usr/bin/env node

process.env.GIT_RAIL_HOST = "cmux";
process.env.GIT_RAIL_PROJECT_CWD ||= process.cwd();
await import("./git-rail.mjs");
