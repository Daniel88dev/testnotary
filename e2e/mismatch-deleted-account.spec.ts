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

  // The mismatch stays, under the shared deleted account. The payload's bytes name her GitHub id,
  // so a read withholds them (the mismatch keeps its copy); so does the verification's attestation.
  const read = await page.request.get(`/api/v1/verifications/${verification.id}`, { headers: { authorization: `Bearer ${await job()}` } });
  expect(read.status()).toBe(200);
  const after = (await read.json()) as {
    verification: {
      attestation: { payload: string | null; signature: unknown; attester: unknown } | null;
      mismatch: { account: unknown; token: { kind: string; name: string }; attestation: { payload: string | null; signature: unknown } } | null;
    };
  };
  // Token names are free text a person picks, so they are withheld too: the kind stays.
  expect(after.verification.mismatch).toMatchObject({ account: { id: 0, login: null }, token: { kind: "laptop", name: "" }, attestation: { payload: null, signature: null } });
  expect(after.verification.attestation).toMatchObject({ payload: null, signature: null, attester: { account: { id: 0, login: null }, token: { kind: "laptop", name: "" } } });
  for (const part of [after.verification.mismatch, after.verification.attestation]) {
    expect(JSON.stringify(part)).not.toContain("mira-mismatch");
    expect(JSON.stringify(part)).not.toMatch(new RegExp(`\\b${mira.id}\\b`));
  }

  // The Mismatches page, signed out on the public repo, names the deleted account and nothing of hers.
  await page.goto("/mira-mismatch/kiln/mismatches");
  const open = page.getByRole("region", { name: /^Open/ });
  await expect(open.getByRole("article")).toHaveCount(1);
  await expect(open.getByRole("article")).toContainText("deleted account, laptop token");
  await expect(open.getByRole("article")).not.toContainText("mira-mismatch");
  await expect(page.locator("main")).not.toContainText(new RegExp(`"account":\\s*${mira.id}\\b`));

  // The commit page shows the verification's attestation: neither it nor the HTML behind it (the
  // data the browser's components start from) carries her id.
  await page.goto(`/mira-mismatch/kiln/commit/${merge.sha}`);
  await expect(page.getByLabel("Attestation payload").first()).toContainText("(deleted account)");
  const html = await (await page.request.get(`/mira-mismatch/kiln/commit/${merge.sha}`)).text();
  expect(html).toContain(merge.sha.slice(0, 7));
  expect(html).not.toMatch(new RegExp(`account\\\\?"\\s*:\\s*${mira.id}\\b`));
});
