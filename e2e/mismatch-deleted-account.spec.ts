import { expect, signIn, test } from "@testnotary/test-world/playwright";

// A mismatch is recorded against an account, and a mismatch states a fact: it is never removed on
// request. Deleting the account anonymises it: the mismatch then names the shared *deleted
// account*, never the account's id or login.

const ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };

test("a deleted account's mismatch reads deleted account", async ({ page, world }) => {
  const mira = world.github.addUser({ login: "mira-mismatch" });
  const fixture = await world.fixtureRepo({ config: { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } } });
  const repo = await world.hostOnGitHub(fixture, { owner: "mira-mismatch", name: "kiln", visibility: "public" });
  await world.github.installApp({ account: { login: "mira-mismatch" }, repos: [repo] });
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();

  // Mira attests on her laptop; in shadow mode CI would have skipped, ran the tests, and they failed.
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(mira);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  expect((await world.runCli(["run"], { cwd: fixture.dir, machine })).stderr).toMatch(/attested=true/);
  const merge = await fixture.testMerge({ base: "main", head: "feature" });
  const job = () => world.github.oidc.tokenFor({ repo, sha: merge.sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
  const verified = await page.request.post("/api/v1/verifications", {
    headers: { authorization: `Bearer ${await job()}` },
    data: { suite: "test", environment: ENVIRONMENT },
  });
  const { verification } = (await verified.json()) as { verification: { id: string; result: string } };
  expect(verification.result).toBe("would_skip");
  const reported = await page.request.post(`/api/v1/verifications/${verification.id}/report`, {
    headers: { authorization: `Bearer ${await job()}` },
    data: { outcome: "failed", durationMs: 1200, environment: ENVIRONMENT },
  });
  expect(reported.status()).toBe(201);
  const { mismatch } = (await reported.json()) as { mismatch: { account: unknown } };
  expect(mismatch.account).toEqual({ id: mira.id, login: "mira-mismatch" });

  // She deletes her account.
  await signIn(page, world, mira);
  const rail = page.getByRole("navigation", { name: "Testnotary" });
  await rail.getByLabel("Account menu").click();
  await rail.getByRole("menuitem", { name: "Delete account" }).click();
  await page.getByRole("button", { name: "Delete account…" }).click();
  await page.getByRole("dialog", { name: "Delete your account?" }).getByRole("button", { name: "Delete my account" }).click();
  await expect(page.getByRole("status")).toContainText("Your account is deleted.");

  // The mismatch stays, under the shared deleted account.
  const read = await page.request.get(`/api/v1/verifications/${verification.id}`, { headers: { authorization: `Bearer ${await job()}` } });
  expect(read.status()).toBe(200);
  const after = (await read.json()) as { verification: { mismatch: { account: unknown; token: { kind: string } } | null } };
  expect(after.verification.mismatch).toMatchObject({ account: { id: 0, login: null }, token: { kind: "laptop" } });
  expect(JSON.stringify(after.verification.mismatch)).not.toContain("mira-mismatch");
});
