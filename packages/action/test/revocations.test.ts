import { afterEach, describe, expect, test } from "vitest";
import { installLibrary, type FakeAccount, type FakeRepo, type FixtureRepo, type Machine } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// Revoking or blocking a token voids its unexpired attestations at once, and so does the token
// expiring: the next verification falls back with `attestation_revoked` and CI runs its tests. A
// block is on one repo; the token still attests on the others.

const world = useWorld();

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };
const HOUR = 3_600_000;

afterEach(() => world.clock.reset());

let n = 0;

interface Repo {
  fixture: FixtureRepo;
  repo: FakeRepo;
  admin: FakeAccount;
  /** The action in `mode: verify` on the pull request's test merge commit, in enforce mode. */
  gate(): ReturnType<typeof world.runAction>;
}

/** An installed repo in enforce mode with a pushed feature branch, and its admin. */
async function installedRepo(owner = `revo-${++n}`): Promise<Repo> {
  const fixture = await world.fixtureRepo({ config: PASSING });
  const repo = await world.hostOnGitHub(fixture, { owner, name: "ledger" });
  await world.github.installApp({ account: { login: owner, type: "Organization" }, repos: [repo] });
  const admin = world.github.addUser({ login: `${owner}-admin` });
  world.github.setPermission(repo, admin, "admin");
  await world.db.connect("app")`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
            values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  return {
    fixture,
    repo,
    admin,
    async gate() {
      // These tests are about voiding; a key version under which nothing attested is audited.
      await world.audits.forbid(repo);
      const merge = await fixture.testMerge({ base: "main", head: "feature" });
      return world.runAction({ repo, sha: merge.sha, workspace: fixture.dir, inputs: { suite: "test", mode: "verify" } });
    },
  };
}

/** A developer with write access on `repos`, signed in on their laptop. */
async function developer(repos: Repo[]): Promise<{ user: FakeAccount; machine: Machine; token(): Promise<string>; run(r: Repo): ReturnType<typeof world.runCli> }> {
  const user = world.github.addUser({ login: `dev-revo-${++n}` });
  for (const r of repos) world.github.setPermission(r.repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    user,
    machine,
    async token() {
      return (await machine.keychain())[0]!.secret;
    },
    run: (r) => world.runCli(["run", "--json"], { cwd: r.fixture.dir, machine }),
  };
}

async function attest(run: ReturnType<typeof world.runCli>) {
  const result = await run;
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true });
}

describe("revoking a token voids its attestations", () => {
  test("an admin revokes a sandbox token: the next verification falls back with attestation_revoked", async () => {
    const r = await installedRepo();
    const creator = world.github.addUser({ login: `agent-owner-${++n}` });
    world.github.setPermission(r.repo, creator, "write");
    const token = await world.sandboxToken({ creator, repo: r.repo, name: "codex-cloud" });
    await attest(world.runCli(["run", "--json"], { cwd: r.fixture.dir, machine: await world.machine(), env: { TESTNOTARY_TOKEN: token } }));
    expect((await r.gate()).outputs).toMatchObject({ result: "skip" });

    expect(await world.revokeSandboxToken({ admin: r.admin, repo: r.repo, token })).toBe(true);
    const result = await r.gate();

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "attestation_revoked", skip: "false", ran: "false" });
  });

  test("an admin of another repo cannot revoke this repo's sandbox token", async () => {
    const r = await installedRepo();
    const creator = world.github.addUser({ login: `agent-owner-${++n}` });
    world.github.setPermission(r.repo, creator, "write");
    const token = await world.sandboxToken({ creator, repo: r.repo });
    const other = await installedRepo();

    expect(await world.revokeSandboxToken({ admin: other.admin, repo: other.repo, token })).toBe(false);
    await attest(world.runCli(["run", "--json"], { cwd: r.fixture.dir, machine: await world.machine(), env: { TESTNOTARY_TOKEN: token } }));
    expect((await r.gate()).outputs).toMatchObject({ result: "skip" });
  });

  test("the owner revokes their own laptop token (logout): the next verification falls back with attestation_revoked", async () => {
    const r = await installedRepo();
    const dev = await developer([r]);
    await attest(dev.run(r));
    expect((await r.gate()).outputs).toMatchObject({ result: "skip" });

    expect((await world.runCli(["logout"], { cwd: dev.machine.home, machine: dev.machine })).exitCode).toBe(0);
    const result = await r.gate();

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "attestation_revoked", skip: "false" });
  });
});

describe("blocking a laptop token on a repo", () => {
  test("voids its attestations there, refuses its next run there, and leaves other repos alone", async () => {
    const blockedOn = await installedRepo();
    const elsewhere = await installedRepo();
    const dev = await developer([blockedOn, elsewhere]);
    await attest(dev.run(blockedOn));

    expect(await world.blockLaptopToken({ admin: blockedOn.admin, repo: blockedOn.repo, token: await dev.token(), note: "lost laptop" })).toBe(true);

    expect((await blockedOn.gate()).outputs).toMatchObject({ result: "fallback", reason: "attestation_revoked" });
    const refused = await dev.run(blockedOn);
    expect(refused.exitCode).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ outcome: "refused", refusal: "token_rejected", attested: false });
    expect(refused.stderr).toMatch(/blocked/);
    await attest(dev.run(elsewhere));
    expect((await elsewhere.gate()).outputs).toMatchObject({ result: "skip" });
  });

  test("an admin of another repo cannot block a token that never ran there", async () => {
    const r = await installedRepo();
    const other = await installedRepo();
    const dev = await developer([r, other]);
    await attest(dev.run(r));

    // The token never ran on `other`: nothing of it shows there to block.
    expect(await world.blockLaptopToken({ admin: other.admin, repo: other.repo, token: await dev.token() })).toBe(false);
    expect((await r.gate()).outputs).toMatchObject({ result: "skip" });
  });
});

describe("a token expiring voids its attestations", () => {
  test("a sandbox token that expires after its attestation: attestation_revoked, though the attestation is under 24 h old", async () => {
    const r = await installedRepo();
    const creator = world.github.addUser({ login: `agent-owner-${++n}` });
    world.github.setPermission(r.repo, creator, "write");
    // Made 23.5 h ago for 1 day: it expires half an hour from now.
    world.clock.set(new Date(Date.now() - 23.5 * HOUR));
    const token = await world.sandboxToken({ creator, repo: r.repo, days: 1 });
    world.clock.reset();
    await attest(world.runCli(["run", "--json"], { cwd: r.fixture.dir, machine: await world.machine(), env: { TESTNOTARY_TOKEN: token } }));
    expect((await r.gate()).outputs).toMatchObject({ result: "skip" });

    world.clock.advance(HOUR);
    const result = await r.gate();

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "attestation_revoked" });
  });
});

describe("the pull request line", () => {
  test("names what voided the attestation", async () => {
    const r = await installedRepo();
    const dev = await developer([r]);
    await attest(dev.run(r));
    await world.blockLaptopToken({ admin: r.admin, repo: r.repo, token: await dev.token() });
    await world.audits.forbid(r.repo);
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const workspace = await r.fixture.ciCheckout(merge.sha);
    await installLibrary(workspace);

    const result = await world.runAction({ repo: r.repo, sha: merge.sha, workspace, inputs: { suite: "test" } });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "attestation_revoked", ran: "true" });
    expect(world.github.checkRuns(r.repo)[0]!.output.title).toMatch(/^Fell back: attestation_revoked \(token blocked on this repo\), /);
  });
});
