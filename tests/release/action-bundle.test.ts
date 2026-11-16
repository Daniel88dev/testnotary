import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installLibrary, type FakeRepo } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";
import { releaseScript, scratch } from "./scripts.ts";

// What the release job builds, run the way users get it: the action bundle as the action's entry
// point on a simulated runner, and the library build installed in the workspace. Both live in a
// temporary directory outside the repo, so nothing of the workspace's sources or node_modules can
// stand in for a missing piece of the bundle.

const world = useWorld();

let out: { dir: string; remove: () => Promise<void> };
let bundle: string;
let libraryCli: string;

beforeAll(async () => {
  out = await scratch("testnotary-bundle");
  const action = await releaseScript("build", ["action", "--out", join(out.dir, "action-dist")]);
  expect(action.stderr).toBe("");
  expect(action.exitCode).toBe(0);
  const library = await releaseScript("build", ["library", "--out", join(out.dir, "library-dist")]);
  expect(library.exitCode).toBe(0);
  bundle = join(out.dir, "action-dist", "action", "index.js");
  libraryCli = join(out.dir, "library-dist", "cli.js");
}, 120_000);

afterAll(async () => {
  await out?.remove();
});

const MARKED = (exitCode = 0) => ({
  suites: { test: { command: ["node", "-e", `require('fs').writeFileSync('ran.txt', 'x'); process.exit(${exitCode})`] } },
});

let repos = 0;

async function story(config = MARKED()) {
  const n = ++repos;
  const fixture = await world.fixtureRepo({
    config,
    files: { "package.json": `${JSON.stringify({ name: "gizmos", private: true, packageManager: "pnpm@10.34.9" })}\n`, ".gitignore": "node_modules\nran.txt\n" },
  });
  const repo = await world.hostOnGitHub(fixture, { owner: `bundle-${n}`, name: "gizmos" });
  await world.github.installApp({ account: { login: `bundle-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `bundler-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine, cli: libraryCli })).exitCode).toBe(0);
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  return { fixture, repo, user, machine };
}

async function enforce(repo: FakeRepo) {
  const sql = world.db.connect("app");
  await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
  await world.audits.forbid(repo);
}

describe("the action bundle", () => {
  test("a laptop attests with the library build, and the bundle on the pull request's merge commit skips in enforce", async () => {
    const s = await story();
    const attested = await world.runCli(["run"], { cwd: s.fixture.dir, machine: s.machine, cli: libraryCli });
    expect(attested.stderr).toMatch(/attested=true/);
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const workspace = await s.fixture.ciCheckout(merge.sha);
    await installLibrary(workspace, { cli: libraryCli });

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" }, entry: bundle });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ result: "skip", reason: "", ran: "false" });
    const [check] = world.github.checkRuns(s.repo);
    expect(check).toMatchObject({ name: "Testnotary / test", conclusion: "success" });
    expect(check!.output.title).toMatch(new RegExp(`^Skipped · test passed .+ ago · attested by @${s.user.login} · laptop token "`));
  });

  test("with no attestation the bundle falls back, runs the suite through the installed library build and exits with its exit code", async () => {
    const s = await story(MARKED(3));
    const merge = await s.fixture.testMerge({ base: "main", head: "feature" });
    await enforce(s.repo);
    const workspace = await s.fixture.ciCheckout(merge.sha);
    await installLibrary(workspace, { cli: libraryCli });

    const result = await world.runAction({ repo: s.repo, sha: merge.sha, workspace, inputs: { suite: "test" }, entry: bundle });

    expect(result.exitCode).toBe(3);
    expect(existsSync(join(workspace, "ran.txt"))).toBe(true);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "no_attestation", ran: "true" });
    expect(world.github.checkRuns(s.repo)[0]!.output.title).toMatch(/^Fell back: no_attestation, .* \(exit code 3\)$/);
  });

  test("the build is the bundle and its notices only: one JavaScript file, no TypeScript, no source maps", async () => {
    expect((await readdir(join(out.dir, "action-dist"), { recursive: true })).sort()).toEqual(["action", "action/index.js", "action/package.json", "licenses.txt"]);
    const code = await readFile(bundle, "utf8");
    expect(code).not.toMatch(/from "@testnotary\/|from "zod"|\.ts"/);
    expect(code).toContain("https://testnotary.dev");
  });
});

describe("the third-party notices", () => {
  test("licenses.txt names each bundled third-party package with its license and full license text, and no Testnotary package", async () => {
    const notices = await readFile(join(out.dir, "action-dist", "licenses.txt"), "utf8");

    expect(notices).toMatch(/^zod \d+\.\d+\.\d+\nLicense: MIT\n/m);
    expect(notices).toContain("Permission is hereby granted, free of charge");
    expect(notices).toContain("Colin McDonnell");
    expect(notices).not.toMatch(/@testnotary\//);
  });
});
