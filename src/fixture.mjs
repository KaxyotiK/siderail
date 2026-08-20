import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "./process.mjs";

async function write(root, relativePath, contents, mode = 0o600) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, contents, { mode });
}

async function git(root, args, env = {}) {
  return runGit(root, args, {
    env: {
      GIT_AUTHOR_NAME: "GitRail Fixture",
      GIT_AUTHOR_EMAIL: "fixture@git-rail.invalid",
      GIT_COMMITTER_NAME: "GitRail Fixture",
      GIT_COMMITTER_EMAIL: "fixture@git-rail.invalid",
      GIT_AUTHOR_DATE: "2026-01-02T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-02T12:00:00Z",
      ...env,
    },
  });
}

export async function createFixtureRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-rail-fixture-"));
  await fs.chmod(root, 0o700);
  await git(root, ["init", "--initial-branch=main"]);
  await write(root, "README.md", "# GitRail fixture\n\nA real repository powers this demo.\n");
  await write(root, "src/rail.mjs", "export const sections = ['against', 'commits'];\n");
  await write(root, "src/status.mjs", "export const status = 'clean';\n");
  await write(root, "docs/usage.md", "# Usage\n\nOpen the rail in Herdr.\n");
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "seed fixture repository"]);
  await git(root, ["switch", "-c", "feature/sidebar"]);
  await write(root, "src/rail.mjs", "export const sections = ['against', 'commits', 'staged', 'unstaged'];\n");
  await write(root, "docs/preview.md", "# Exact previews\n\nEvery row keeps its Git scope.\n");
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "add descriptor-aware rail"], { GIT_AUTHOR_DATE: "2026-01-03T12:00:00Z", GIT_COMMITTER_DATE: "2026-01-03T12:00:00Z" });
  await write(root, "src/status.mjs", "export const status = 'staged';\nexport const refresh = 'preserved';\n");
  await git(root, ["add", "src/status.mjs"]);
  await write(root, "src/status.mjs", "export const status = 'partially-staged';\nexport const refresh = 'preserved';\nexport const parser = 'nul-delimited';\n");
  await write(root, "notes/production ready.md", "# Production ready\n\nThis untracked file is rendered from disk.\n");
  await write(root, "assets/binary.dat", Buffer.from([0, 1, 2, 3, 255]));
  return root;
}

export async function removeFixtureRepository(root) {
  if (root && path.basename(root).startsWith("git-rail-fixture-")) await fs.rm(root, { recursive: true, force: true });
}
