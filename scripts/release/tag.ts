// The release job's local half, run in a clean checkout of main after `build.ts action`:
//
//   node scripts/release/tag.ts
//
// 1. Checks that the library and the action share one X.Y.Z version (a Changesets fixed group),
//    that no tracked file differs from HEAD, that vX.Y.Z does not exist yet, and that the bundle
//    action.yml runs (`runs.main`) and its notices were built into dist/.
// 2. Commits HEAD's tree plus dist/action/ and dist/licenses.txt as a new commit whose parent is
//    HEAD. No branch moves: the bundle is never committed to main (ADR 0001).
// 3. Tags that commit vX.Y.Z (annotated) and moves the plain major tag (v1) to it, locally.
// 4. Writes the release notes (the library's CHANGELOG section) to a file.
//
// It pushes nothing. The workflow pushes the tags, creates the release and publishes to npm, and
// only outside a dry run. Outputs (version, tag, major, commit, notes) go to $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = ["dist/action", "dist/licenses.txt"];

class Refusal extends Error {}

function git(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tagExists(name: string): string | undefined {
  try {
    return git(["rev-parse", "--quiet", "--verify", `refs/tags/${name}^{commit}`]);
  } catch {
    return undefined;
  }
}

function version(path: string): { name: string; version: string } {
  if (!existsSync(path)) throw new Refusal(`${path} is missing`);
  return JSON.parse(readFileSync(path, "utf8")) as { name: string; version: string };
}

/** The section `## <version>` of a Changesets changelog, without its heading. */
function releaseNotes(changelog: string, wanted: string): string | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${wanted}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

function main(): void {
  const library = version("packages/testnotary/package.json");
  const action = version("packages/action/package.json");
  if (library.version !== action.version) {
    throw new Refusal(`${library.name} is ${library.version} but ${action.name} is ${action.version}; they are released together under one version (run \`pnpm changeset version\`)`);
  }
  const v = library.version;
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Refusal(`version ${v} is not X.Y.Z; the release cuts vX.Y.Z and moves vX`);
  const tag = `v${v}`;
  const major = `v${v.split(".")[0]}`;

  if (git(["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Refusal("the checkout has uncommitted changes; the bundle is built only from the committed source");
  }
  if (tagExists(tag)) throw new Refusal(`${tag} already exists; bump the version with a changeset to release again`);
  const runsMain = /^runs:\s*\n(?:[ \t]+.*\n)*?[ \t]+main:\s*["']?([^\s"']+)/m.exec(readFileSync("action.yml", "utf8"))?.[1];
  if (!runsMain) throw new Refusal("action.yml names no runs.main");
  for (const path of [runsMain, "dist/licenses.txt"]) {
    if (!existsSync(path)) throw new Refusal(`${path} is missing; build it first with \`node scripts/release/build.ts action\``);
  }
  if (!runsMain.startsWith("dist/action/")) throw new Refusal(`action.yml's runs.main ${runsMain} is outside dist/action/`);

  const head = git(["rev-parse", "HEAD"]);
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "testnotary-release-"));
  let commit: string;
  try {
    // A throwaway index: HEAD's tree plus the bundle (ignored on main, so added with -f). The
    // checkout's own index and working tree stay as they are.
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    git(["read-tree", "HEAD"], env);
    git(["add", "--force", "--", ...BUNDLE], env);
    const tree = git(["write-tree"], env);
    commit = git(["commit-tree", tree, "-p", head, "-m", `Release ${tag}\n\nThe action bundle and its third-party notices, built from ${head}.`]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const previous = tagExists(major);
  git(["tag", "--annotate", "--message", tag, tag, commit]);
  git(["tag", "--force", major, commit]);

  const notesFile = join(process.env.RUNNER_TEMP ?? tmpdir(), `release-notes-${tag}.md`);
  const changelog = existsSync("packages/testnotary/CHANGELOG.md") ? readFileSync("packages/testnotary/CHANGELOG.md", "utf8") : "";
  writeFileSync(notesFile, `${releaseNotes(changelog, v) ?? `Release ${tag}.`}\n`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${v}\ntag=${tag}\nmajor=${major}\ncommit=${commit}\nnotes=${notesFile}\n`);
  }
  process.stdout.write(
    [
      `Prepared ${tag}. Nothing was pushed.`,
      `  commit ${commit}  detached: parent ${head}, adds ${BUNDLE.join(" and ")}`,
      `  tag    ${tag} -> ${commit}  (new)`,
      `  tag    ${major} -> ${commit}  (${previous ? `moved from ${previous}` : "new"})`,
      `  notes  ${notesFile}`,
      "",
    ].join("\n"),
  );
}

try {
  main();
} catch (error) {
  if (!(error instanceof Refusal)) throw error;
  process.stderr.write(`release: ${error.message}\n`);
  process.exit(1);
}
