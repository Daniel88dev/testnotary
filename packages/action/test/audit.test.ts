import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The audit draw: in enforce mode CI runs the tests anyway on a random share of the trees an
// attestation covers, HMAC(per-repo key, tree + suite) against the rate. The world's audit master
// key is fixed, so a tree is drawn or not, every time; a test finds trees of each kind.

const world = useWorld();

const SUITE = "test";
const PASSING = { suites: { [SUITE]: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x')"] } } };

interface Story {
  fixture: FixtureRepo;
  repo: FakeRepo;
  user: FakeAccount;
  machine: Machine;
  /** `testnotary run` on the developer's laptop; must attest. */
  attest(): Promise<void>;
  /** The action in a gate job (`mode: verify`) on a commit. */
  gate(sha: string, options?: { event?: string; ref?: string }): ReturnType<typeof world.runAction>;
}

let repos = 0;

/** An installed repo in enforce mode at the default rates, and a developer with write access signed in on their laptop. */
async function story(): Promise<Story> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({
    config: PASSING,
    files: { "package.json": '{ "name": "widgets", "private": true, "packageManager": "pnpm@10.34.9" }\n', ".gitignore": "node_modules\nran.txt\n" },
  });
  const repo = await world.hostOnGitHub(fixture, { owner: `audit-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `audit-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `audit-dev-${n}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  await setMode(repo, "enforce");
  return {
    fixture,
    repo,
    user,
    machine,
    async attest() {
      const result = await world.runCli(["run"], { cwd: fixture.dir, machine });
      expect(result.stderr).toMatch(/attested=true/);
      expect(result.exitCode).toBe(0);
    },
    gate: (sha, { event, ref } = {}) => world.runAction({ repo, sha, event, ref, workspace: fixture.dir, inputs: { suite: SUITE, mode: "verify" } }),
  };
}

/** A setting change, as an admin's would be (the Settings page comes with T-828). */
async function setMode(repo: FakeRepo, mode: "shadow" | "enforce", rates: { auditOneIn?: number; sandboxAuditOneIn?: number } = {}) {
  const sql = world.db.connect("app");
  await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, ${mode}, ${rates.auditOneIn ?? 10}, ${rates.sandboxAuditOneIn ?? 5}, null, 'test')`;
}

/**
 * A feature branch whose one commit has a tree the draw treats as `wanted` says, found by trying
 * one small file after another (no key version is touched), pushed. Returns the tree.
 */
async function featureWithTree(s: Story, wanted: (tree: string) => Promise<boolean>): Promise<string> {
  await s.fixture.branch("feature");
  for (let attempt = 0; attempt < 500; attempt++) {
    await s.fixture.write({ "src/a.js": `export const a = ${attempt};\n` });
    await s.fixture.git("add", "--all");
    const tree = (await s.fixture.git("write-tree")).trim();
    if (await wanted(tree)) {
      await s.fixture.commit("Add a");
      await s.fixture.push();
      return tree;
    }
  }
  throw new Error("no tree of the kind wanted in 500 attempts");
}

const drawnAt = (s: Story, tokenKind: "laptop" | "sandbox") => (tree: string) => world.audits.drawn(s.repo, { tree, suite: SUITE, tokenKind });

describe("the audit draw, under the world's fixed master key", () => {
  test("at 1 in 10, a tree the draw picks reads audit, every time, and a tree it doesn't pick skips", async () => {
    const drawn = await story();
    const tree = await featureWithTree(drawn, drawnAt(drawn, "laptop"));
    await drawn.attest();
    const merge = await drawn.fixture.testMerge({ base: "main", head: "feature" });
    expect(merge.tree).toBe(tree);

    const first = await drawn.gate(merge.sha);
    const again = await drawn.gate(merge.sha);

    expect(first.outputs).toMatchObject({ result: "audit", reason: "audit", skip: "false", ran: "false" });
    expect(again.outputs).toMatchObject({ result: "audit", skip: "false" });

    const skipped = await story();
    await featureWithTree(skipped, async (candidate) => !(await drawnAt(skipped, "sandbox")(candidate)));
    await skipped.attest();
    const other = await skipped.fixture.testMerge({ base: "main", head: "feature" });

    expect((await skipped.gate(other.sha)).outputs).toMatchObject({ result: "skip", skip: "true" });
  });
});
