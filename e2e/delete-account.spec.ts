import { expect, signIn, test } from "@testnotary/test-world/playwright";

// *Delete account*: one confirmation, then at once the account's tokens are revoked, its session
// ends, and its records show the shared *deleted account* instead of its name.

const ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };

test("Delete account revokes the tokens, ends the session and shows deleted account on the account's records", async ({ page, world }) => {
  const rosa = world.github.addUser({ login: "rosa-leaves" });
  const fixture = await world.fixtureRepo({ config: { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } } });
  const repo = await world.hostOnGitHub(fixture, { owner: "rosa-leaves", name: "shop", visibility: "public" });
  await world.github.installApp({ account: { login: "rosa-leaves" }, repos: [repo] });
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();

  // Rosa attests on her laptop, and CI's verification matches her attestation.
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(rosa);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  expect((await world.runCli(["run"], { cwd: fixture.dir, machine })).stderr).toMatch(/attested=true/);
  const merge = await fixture.testMerge({ base: "main", head: "feature" });
  const job = () => world.github.oidc.tokenFor({ repo, sha: merge.sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
  const verified = await page.request.post("/api/v1/verifications", {
    headers: { authorization: `Bearer ${await job()}` },
    data: { suite: "test", environment: ENVIRONMENT },
  });
  const { verification } = (await verified.json()) as { verification: { id: string; attestation: { attester: { account: unknown } } } };
  expect(verification.attestation.attester.account).toEqual({ id: rosa.id, login: "rosa-leaves" });

  // One confirmation from the account menu.
  await signIn(page, world, rosa);
  const rail = page.getByRole("navigation", { name: "Testnotary" });
  await rail.getByLabel("Account menu").click();
  await rail.getByRole("menuitem", { name: "Delete account" }).click();
  await page.getByRole("button", { name: "Delete account…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(dialog).toContainText("deleted account");
  const signedInCookies = await page.context().cookies();
  await dialog.getByRole("button", { name: "Delete my account" }).click();

  await expect(page.getByRole("status")).toContainText("Your account is deleted.");
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();

  // Her laptop token no longer works.
  const whoami = await world.runCli(["whoami", "--json"], { cwd: machine.home, machine });
  expect(whoami.exitCode).toBe(1);
  expect(JSON.parse(whoami.stdout)).toMatchObject({ error: "token_rejected" });

  // The session is over, even for a copy of its cookies.
  await page.context().addCookies(signedInCookies);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Sign in to see your repositories" })).toBeVisible();

  // Her records stay, under the shared deleted account.
  const read = await page.request.get(`/api/v1/verifications/${verification.id}`, { headers: { authorization: `Bearer ${await job()}` } });
  expect(read.status()).toBe(200);
  const after = (await read.json()) as { verification: { attestation: { attester: { account: unknown } } } };
  expect(after.verification.attestation.attester.account).toEqual({ id: 0, login: null });

  // Signing in again starts afresh: none of the old tokens come back.
  await page.context().clearCookies();
  await signIn(page, world, rosa, "/settings/tokens");
  await expect(page.getByText("No laptop token.")).toBeVisible();
});
