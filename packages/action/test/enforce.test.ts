import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// A repo admin moves a repo from shadow to enforce on evidence, and handles a mismatch: the
// Settings section's mode toggle and rates, and the Mismatches section's *explain*, reached the way
// the dashboard reaches them once GitHub says the person is an admin (the browser tests click
// them). What CI does afterwards is read through the action's entry point.

const world = useWorld();

const SUITE = "test";
/** Passes, unless a file named `fails-here` exists: a test drops it in CI's workspace to make CI disagree with the laptop. */
const PASSING = { suites: { [SUITE]: { command: ["node", "-e", "process.exit(require('fs').existsSync('fails-here') ? 1 : 0)"] } } };

interface Story {
  fixture: FixtureRepo;
  repo: FakeRepo;
  admin: FakeAccount;
  machine: Machine;
  /** Pushes a branch off main with one change, attests it on the laptop, and returns GitHub's test merge commit. */
  attestedPullRequest(branch: string, number: number): Promise<{ sha: string; tree: string }>;
  gate(sha: string): ReturnType<typeof world.runAction>;
  ci(sha: string, options?: { fails?: boolean }): ReturnType<typeof world.runAction>;
}

let repos = 0;

/** An installed organization repo in shadow mode, its admin, and a developer with write access signed in on a laptop. */
async function story(): Promise<Story> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: PASSING, files: { ".gitignore": "node_modules\nfails-here\n" } });
  const repo = await world.hostOnGitHub(fixture, { owner: `enforce-${n}`, name: "kiln" });
  await world.github.installApp({ account: { login: `enforce-${n}`, type: "Organization" }, repos: [repo] });
  const admin = world.github.addUser({ login: `enforce-admin-${n}` });
  world.github.setPermission(repo, admin, "admin");
  const developer = world.github.addUser({ login: `enforce-dev-${n}` });
  world.github.setPermission(repo, developer, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(developer);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    fixture,
    repo,
    admin,
    machine,
    async attestedPullRequest(branch, number) {
      await fixture.checkout("main");
      await fixture.branch(branch);
      await fixture.commit(`Change ${branch}`, { [`src/${branch}.js`]: `export const ${branch} = ${number};\n` });
      await fixture.push();
      const run = await world.runCli(["run"], { cwd: fixture.dir, machine });
      expect(run.stderr).toMatch(/attested=true/);
      return fixture.testMerge({ base: "main", head: branch, number });
    },
    gate: (sha) => world.runAction({ repo, sha, workspace: fixture.dir, inputs: { suite: SUITE, mode: "verify" } }),
    async ci(sha, { fails = false } = {}) {
      const workspace = await fixture.ciCheckout(sha);
      await installLibrary(workspace);
      if (fails) await writeFile(join(workspace, "fails-here"), "");
      return world.runAction({ repo, sha, workspace, inputs: { suite: SUITE } });
    },
  };
}

describe("switching to enforce", () => {
  test("with fewer than 20 agreeing comparisons warns and still switches: CI skips", async () => {
    const s = await story();
    const merge = await s.attestedPullRequest("feature", 1);
    expect((await s.ci(merge.sha)).outputs).toMatchObject({ result: "would_skip", ran: "true" });

    const change = await world.changeRepoSettings({ admin: s.admin, repo: s.repo, mode: "enforce" });

    expect(change).toMatchObject({ ok: true, settings: { mode: "enforce" } });
    expect(change.ok && change.warnings).toEqual(["Fewer than 20 agreeing comparisons: 1 so far."]);
    await world.audits.forbid(s.repo);
    expect((await s.gate(merge.sha)).outputs).toMatchObject({ result: "skip", skip: "true" });
  });

  test("back to shadow needs no evidence and gives no warning: CI runs its tests again", async () => {
    const s = await story();
    const merge = await s.attestedPullRequest("feature", 1);
    await world.changeRepoSettings({ admin: s.admin, repo: s.repo, mode: "enforce" });

    expect(await world.changeRepoSettings({ admin: s.admin, repo: s.repo, mode: "shadow" })).toMatchObject({ ok: true, warnings: [], settings: { mode: "shadow" } });
    expect((await s.gate(merge.sha)).outputs).toMatchObject({ result: "would_skip", skip: "false" });
  });
});

describe("after a mismatch", () => {
  test("enforce is refused until an admin explains it; the explanation alone does not switch enforce back on", async () => {
    const s = await story();
    const merge = await s.attestedPullRequest("feature", 1);
    await world.changeRepoSettings({ admin: s.admin, repo: s.repo, mode: "enforce" });
    await world.audits.force(s.repo);
    const failed = await s.ci(merge.sha, { fails: true });
    expect(failed.outputs).toMatchObject({ result: "audit", ran: "true" });
    const mismatch = /- Verification: `([0-9a-f-]{36})`/.exec(failed.summary)![1]!;
    expect((await s.gate(merge.sha)).outputs.result).toBe("would_skip");

    const refused = await world.changeRepoSettings({ admin: s.admin, repo: s.repo, mode: "enforce" });

    expect(refused).toEqual({ ok: false, problem: "Explain the open mismatch before switching to enforce." });
    expect((await s.gate(merge.sha)).outputs.result).toBe("would_skip");

    expect(await world.explainMismatch({ admin: s.admin, repo: s.repo, verification: mismatch, cause: "flaky_test", note: "The clock test races." })).toBe(true);
    expect((await s.gate(merge.sha)).outputs.result).toBe("would_skip");

    const next = await s.attestedPullRequest("next", 2);
    expect(await world.changeRepoSettings({ admin: s.admin, repo: s.repo, mode: "enforce" })).toMatchObject({ ok: true, settings: { mode: "enforce" } });
    await world.audits.forbid(s.repo);
    expect((await s.gate(next.sha)).outputs).toMatchObject({ result: "skip" });
  });

  test("an explanation needs one of the four causes, and a mismatch is explained once", async () => {
    const s = await story();
    const merge = await s.attestedPullRequest("feature", 1);
    const failed = await s.ci(merge.sha, { fails: true });
    const verification = /- Verification: `([0-9a-f-]{36})`/.exec(failed.summary)![1]!;

    expect(await world.explainMismatch({ admin: s.admin, repo: s.repo, verification, cause: "bad luck" })).toBe(false);
    expect(await world.explainMismatch({ admin: s.admin, repo: s.repo, verification, cause: "environment_difference" })).toBe(true);
    expect(await world.explainMismatch({ admin: s.admin, repo: s.repo, verification, cause: "other", note: "again" })).toBe(false);
  });
});

describe("audit rates", () => {
  test.each([
    { auditOneIn: 11 },
    { auditOneIn: 0 },
    { auditOneIn: 2.5 },
    { sandboxAuditOneIn: 6 },
  ])("below the defaults, or not a whole 1 in N, are refused: %o", async (rates) => {
    const s = await story();

    const change = await world.changeRepoSettings({ admin: s.admin, repo: s.repo, ...rates });

    expect(change).toMatchObject({ ok: false, problem: expect.stringMatching(/never lowered below 1 in (10|5)/) });
  });

  test("the sandbox rate defaults to twice the repo's", async () => {
    const s = await story();

    expect(await world.changeRepoSettings({ admin: s.admin, repo: s.repo, auditOneIn: 4 })).toMatchObject({ ok: true, settings: { auditOneIn: 4, sandboxAuditOneIn: 2 } });
    expect(await world.changeRepoSettings({ admin: s.admin, repo: s.repo, auditOneIn: 9, sandboxAuditOneIn: "default" })).toMatchObject({
      ok: true,
      settings: { auditOneIn: 9, sandboxAuditOneIn: 4 },
    });
    expect(await world.changeRepoSettings({ admin: s.admin, repo: s.repo, sandboxAuditOneIn: 1 })).toMatchObject({ ok: true, settings: { auditOneIn: 9, sandboxAuditOneIn: 1 } });
    // Once set apart from the default, the sandbox rate stays where the admin put it.
    expect(await world.changeRepoSettings({ admin: s.admin, repo: s.repo, auditOneIn: 10 })).toMatchObject({ ok: true, settings: { auditOneIn: 10, sandboxAuditOneIn: 1 } });
  });

  test("a raised rate takes effect: at 1 in 1 every attested tree is audited", async () => {
    const s = await story();
    const merge = await s.attestedPullRequest("feature", 1);
    await world.audits.forbid(s.repo);
    await world.changeRepoSettings({ admin: s.admin, repo: s.repo, mode: "enforce" });
    expect((await s.gate(merge.sha)).outputs.result).toBe("skip");

    await world.changeRepoSettings({ admin: s.admin, repo: s.repo, auditOneIn: 1 });

    expect((await s.gate(merge.sha)).outputs.result).toBe("audit");
  });
});
