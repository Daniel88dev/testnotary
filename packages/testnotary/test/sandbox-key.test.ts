import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

// `testnotary sandbox-key <token-name>` on the creator's laptop. The happy path, through to CI
// skipping on the sandbox's signature, is in packages/action/test/signature-mode.test.ts.

const world = useWorld();

let n = 0;

async function creator() {
  const i = ++n;
  const fixture = await world.fixtureRepo();
  const repo = await world.hostOnGitHub(fixture, { owner: `keymaker-${i}`, name: "api" });
  await world.github.installApp({ account: { login: `keymaker-${i}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `keymaker-dev-${i}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return { fixture, repo, user, machine };
}

describe("testnotary sandbox-key", () => {
  test("outside a clone of the token's repo, it prints the line to add instead of writing it", async () => {
    const c = await creator();
    await world.sandboxToken({ creator: c.user, repo: c.repo, name: "devin" });

    const result = await world.runCli(["sandbox-key", "devin"], { cwd: c.machine.home, machine: c.machine });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(result.stderr).toContain(`testnotary: add this line to .testnotary/allowed_signers in ${c.repo.fullName}, in a pull request to the base branch:`);
    expect(result.stderr).toMatch(new RegExp(`testnotary: sandbox:[0-9a-f-]{36}/github:${c.user.id} namespaces="attestation@testnotary.dev" ssh-ed25519 `));
  });

  test("a name none of the person's live sandbox tokens has fails with token_not_found and lists theirs", async () => {
    const c = await creator();
    await world.sandboxToken({ creator: c.user, repo: c.repo, name: "devin" });

    const result = await world.runCli(["sandbox-key", "codex", "--json"], { cwd: c.fixture.dir, machine: c.machine });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: "token_not_found" });
    expect(result.stderr).toContain(`you have no live sandbox token named "codex"; yours: "devin" (${c.repo.fullName})`);
  });

  test("not signed in on this machine, it says so", async () => {
    const machine = await world.machine();

    const result = await world.runCli(["sandbox-key", "devin", "--json"], { cwd: machine.home, machine });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: "not_signed_in" });
  });

  test("a sandbox token can't list sandbox tokens", async () => {
    const c = await creator();
    const token = await world.sandboxToken({ creator: c.user, repo: c.repo, name: "devin" });

    const response = await fetch(`${world.service.url}/api/v1/tokens/sandbox`, { headers: { authorization: `Bearer ${token}` } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "token_rejected" });
  });
});
