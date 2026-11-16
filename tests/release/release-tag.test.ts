import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FixtureRepo } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";
import { releaseScript, repoRoot, run, scratch } from "./scripts.ts";

// The release job's local half (`scripts/release/tag.ts`, also its dry run): on a checkout of main
// with the action bundle built into dist/, it commits the bundle onto a detached commit, tags it
// vX.Y.Z and moves the major tag to it. Pushing the tags, the GitHub release and npm come after,
// in the workflow, and only outside a dry run.

const world = useWorld();

let out: { dir: string; remove: () => Promise<void> };

beforeAll(async () => {
  out = await scratch("testnotary-tag");
  const built = await releaseScript("build", ["action", "--out", join(out.dir, "dist")]);
  expect(built.exitCode, built.stderr).toBe(0);
}, 120_000);

afterAll(async () => {
  await out?.remove();
});

// The release job runs git with the runner's (empty) config and the bot's identity.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};

const CHANGELOG = "# testnotary\n\n## 1.4.0\n\n### Minor Changes\n\n- abc1234: Sandbox tokens name their agent.\n\n## 1.3.0\n\n### Patch Changes\n\n- def5678: An older fix.\n";

/** A checkout of main as the release job has it: the monorepo's release-relevant files, the bundle built into the ignored dist/. */
async function releaseCheckout(versions: { library: string; action: string } = { library: "1.4.0", action: "1.4.0" }): Promise<FixtureRepo> {
  const fixture = await world.fixtureRepo({
    files: {
      "action.yml": await readFile(join(repoRoot, "action.yml"), "utf8"),
      ".gitignore": "dist/\nnode_modules/\n",
      "packages/testnotary/package.json": `${JSON.stringify({ name: "testnotary", version: versions.library }, null, 2)}\n`,
      "packages/testnotary/CHANGELOG.md": CHANGELOG,
      "packages/action/package.json": `${JSON.stringify({ name: "@testnotary/action", version: versions.action, private: true }, null, 2)}\n`,
    },
  });
  await fixture.push();
  return fixture;
}

async function withBundle(fixture: FixtureRepo): Promise<FixtureRepo> {
  await cp(join(out.dir, "dist"), join(fixture.dir, "dist"), { recursive: true });
  return fixture;
}

async function tag(fixture: FixtureRepo) {
  const runner = await mkdtemp(join(out.dir, "runner-"));
  const outputFile = join(runner, "output");
  await writeFile(outputFile, "");
  const result = await releaseScript("tag", [], { cwd: fixture.dir, env: { ...GIT_ENV, GITHUB_OUTPUT: outputFile, RUNNER_TEMP: runner } });
  const outputs = Object.fromEntries(
    (await readFile(outputFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { ...result, outputs };
}

const git = async (dir: string, ...args: string[]) => (await run("git", args, { cwd: dir, env: GIT_ENV })).stdout.trim();

describe("a dry run of the release tags a detached commit holding the bundle", () => {
  test("vX.Y.Z and the moved v1 point at one new commit, whose parent is main and which no branch contains", async () => {
    const fixture = await withBundle(await releaseCheckout());
    const main = await fixture.revParse("HEAD");
    await fixture.git("tag", "v1", `${main}`);
    await fixture.commit("Version packages");
    await fixture.push();
    const tip = await fixture.revParse("HEAD");

    const result = await tag(fixture);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const released = await git(fixture.dir, "rev-parse", "v1.4.0^{commit}");
    expect(await git(fixture.dir, "rev-parse", "v1^{commit}")).toBe(released);
    expect(await git(fixture.dir, "rev-parse", `${released}^`)).toBe(tip);
    expect(await git(fixture.dir, "branch", "--all", "--contains", released)).toBe("");
    expect(await git(fixture.dir, "cat-file", "-t", "v1.4.0")).toBe("tag");
    expect(await fixture.revParse("HEAD")).toBe(tip);
    expect(await git(fixture.dir, "status", "--porcelain")).toBe("");
    expect(result.stdout).toContain("Nothing was pushed");
    expect(result.outputs).toMatchObject({ version: "1.4.0", tag: "v1.4.0", major: "v1", commit: released });
  });

  test("the tagged commit holds the bundle and its notices; main does not", async () => {
    const fixture = await withBundle(await releaseCheckout());

    await tag(fixture);

    const tagged = (await git(fixture.dir, "ls-tree", "-r", "--name-only", "v1.4.0")).split("\n");
    expect(tagged).toEqual(expect.arrayContaining(["action.yml", "dist/action/index.js", "dist/action/package.json", "dist/licenses.txt"]));
    expect(await git(fixture.dir, "ls-tree", "-r", "--name-only", "main")).not.toContain("dist/");
    expect(await git(fixture.dir, "show", "v1.4.0:dist/licenses.txt")).toBe((await readFile(join(out.dir, "dist", "licenses.txt"), "utf8")).trimEnd());
  });

  test("nothing reaches the remote: origin has no new tag and main is where it was", async () => {
    const fixture = await withBundle(await releaseCheckout());
    const before = await git(fixture.remoteDir, "rev-parse", "main");

    await tag(fixture);

    expect(await git(fixture.remoteDir, "tag", "--list")).toBe("");
    expect(await git(fixture.remoteDir, "rev-parse", "main")).toBe(before);
  });

  test("the release notes are the library's changelog section for this version", async () => {
    const fixture = await withBundle(await releaseCheckout());

    const result = await tag(fixture);

    const notes = await readFile(result.outputs.notes!, "utf8");
    expect(notes).toContain("Sandbox tokens name their agent.");
    expect(notes).not.toContain("An older fix.");
  });

  test("`uses: owner/repo@v1` at the tagged commit runs: the action from a checkout of v1 verifies a pull request", async () => {
    const release = await withBundle(await releaseCheckout());
    await tag(release);
    const checkout = join(out.dir, `checkout-${Date.now()}`);
    await run("git", ["clone", "--quiet", release.dir, checkout], { env: GIT_ENV });
    await run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", "v1"], { cwd: checkout, env: GIT_ENV });
    const main = /\n\s+main:\s*(\S+)/.exec(await readFile(join(checkout, "action.yml"), "utf8"))![1]!;

    const user = await world.fixtureRepo();
    const repo = await world.hostOnGitHub(user, { owner: "tagged-release", name: "widgets" });
    await world.github.installApp({ account: { login: "tagged-release", type: "Organization" }, repos: [repo] });
    await user.branch("feature");
    await user.commit("Add a", { "src/a.js": "export const a = 1;\n" });
    await user.push();
    const merge = await user.testMerge({ base: "main", head: "feature" });

    const result = await world.runAction({ repo, sha: merge.sha, workspace: user.dir, inputs: { suite: "test", mode: "verify" }, entry: join(checkout, main) });

    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "would_fall_back", reason: "no_attestation" });
  });
});

describe("the release refuses, and tags nothing", () => {
  test("when the library and the action carry different versions", async () => {
    const fixture = await withBundle(await releaseCheckout({ library: "1.4.0", action: "1.3.2" }));

    const result = await tag(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("testnotary is 1.4.0 but @testnotary/action is 1.3.2");
    expect(await git(fixture.dir, "tag", "--list")).toBe("");
  });

  test("when the version's tag already exists (it was released)", async () => {
    const fixture = await withBundle(await releaseCheckout());
    await fixture.git("tag", "v1.4.0");

    const result = await tag(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("v1.4.0 already exists");
  });

  test("when the bundle was not built", async () => {
    const fixture = await releaseCheckout();

    const result = await tag(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dist/action/index.js is missing");
    expect(await git(fixture.dir, "tag", "--list")).toBe("");
  });

  test("when a tracked file differs from the commit (the bundle must come from reviewed source)", async () => {
    const fixture = await withBundle(await releaseCheckout());
    await fixture.write({ "action.yml": "name: changed\n" });

    const result = await tag(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("uncommitted changes");
  });
});
