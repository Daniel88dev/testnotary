import { expect, signIn, test } from "@testnotary/test-world/playwright";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine, World } from "@testnotary/test-world";
import type { Page } from "@playwright/test";

// A repo admin cuts off a token they no longer trust and sees who and what attests: People
// with each account's counts and tokens, blocking a laptop token there, revoking anyone's sandbox
// token in Settings, and the owner revoking their own laptop token on the Tokens page. Each voids
// the token's attestations at once: the next verification falls back with `attestation_revoked`.

const PASSING = { suites: { unit: { command: ["node", "-e", "process.exit(0)"] } } };
const CI_ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261101.1", node: "v24.11.0" };
/** What Codex cloud shows a process: its marker and its thread id. */
const CODEX = { TESTNOTARY_SANDBOX: "1", CODEX_CI: "1", CODEX_THREAD_ID: "thr_quill01" };

interface Repo {
  fixture: FixtureRepo;
  repo: FakeRepo;
  /** A pull request's test merge commit, the first time; the same one after. */
  merge(): Promise<string>;
  /** Asks the service, as the gate job does, about the pull request; enforce mode, no audit drawn. */
  verify(page: Page): Promise<{ result: string; reason: string | null }>;
}

async function installedRepo(world: World, owner: string, name: string, visibility: "public" | "private" = "private"): Promise<Repo> {
  const fixture = await world.fixtureRepo({ config: PASSING, files: { ".gitignore": "node_modules\n" } });
  const repo = await world.hostOnGitHub(fixture, { owner, name, visibility });
  await world.github.installApp({ account: { login: owner, type: "Organization" }, repos: [repo] });
  const sql = world.db.connect("app");
  try {
    await sql`insert into repo_setting_changes (repo_id, mode, audit_one_in, sandbox_audit_one_in, changed_by, reason)
              values (${repo.id}, 'enforce', 10, 5, null, 'test')`;
  } finally {
    await sql.end({ timeout: 1 });
  }
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  let sha: string | undefined;
  const merge = async () => (sha ??= (await fixture.testMerge({ base: "main", head: "feature", number: 7 })).sha);
  return {
    fixture,
    repo,
    merge,
    async verify(page) {
      await world.audits.forbid(repo);
      const token = await world.github.oidc.tokenFor({ repo, sha: await merge(), ref: "refs/pull/7/merge", eventName: "pull_request" }, "https://testnotary.dev");
      const response = await page.request.post("/api/v1/verifications", {
        headers: { authorization: `Bearer ${token}` },
        data: { suite: "unit", environment: CI_ENVIRONMENT },
      });
      expect(response.status()).toBe(200);
      return ((await response.json()) as { verification: { result: string; reason: string | null } }).verification;
    },
  };
}

/** A developer signed in on a laptop, with write access on `repos`. */
async function developer(world: World, login: string, repos: Repo[]): Promise<{ user: FakeAccount; machine: Machine; run(r: Repo): Promise<Record<string, unknown>> }> {
  const user = world.github.addUser({ login });
  for (const r of repos) world.github.setPermission(r.repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    user,
    machine,
    async run(r) {
      const result = await world.runCli(["run", "--json"], { cwd: r.fixture.dir, machine });
      return JSON.parse(result.stdout) as Record<string, unknown>;
    },
  };
}

async function sandboxRun(world: World, r: Repo, token: string): Promise<Record<string, unknown>> {
  const result = await world.runCli(["run", "--json"], { cwd: r.fixture.dir, env: { ...CODEX, TESTNOTARY_TOKEN: token } });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const cells = (row: ReturnType<Page["getByRole"]>) => row.getByRole("cell");

test("People lists each account's counts with its tokens and unverified labels, and an admin blocks a laptop token on one repo", async ({ page, world }) => {
  const ledger = await installedRepo(world, "quill-ink", "ledger");
  const journal = await installedRepo(world, "quill-ink", "journal");
  const admin = world.github.addUser({ login: "quill-admin" });
  world.github.setPermission(ledger.repo, admin, "admin");
  const dev = await developer(world, "quill-dev", [ledger, journal]);
  const agentOwner = world.github.addUser({ login: "quill-agents" });
  world.github.setPermission(ledger.repo, agentOwner, "write");
  const sandbox = await world.sandboxToken({ creator: agentOwner, repo: ledger.repo, name: "codex-cloud" });

  expect(await dev.run(ledger)).toMatchObject({ outcome: "passed", attested: true });
  expect(await ledger.verify(page)).toMatchObject({ result: "skip" });
  // The agent attests main's tree, not the pull request's: only the laptop's attestation names it.
  await ledger.fixture.checkout("main");
  expect(await sandboxRun(world, ledger, sandbox)).toMatchObject({ outcome: "passed", attested: true });
  await ledger.fixture.checkout("feature");

  await signIn(page, world, admin);
  await page.goto("/quill-ink/ledger/people");
  const people = page.getByRole("table", { name: "People" });
  const devRows = people.getByRole("rowgroup", { name: "@quill-dev" }).getByRole("row");
  await expect(devRows).toHaveCount(2);
  // Runs, attestations, skips earned, audits, mismatches.
  await expect(cells(devRows.nth(0))).toHaveText(["@quill-dev", "1", "1", "1", "0", "0", /.+/, ""]);
  await expect(devRows.nth(1)).toContainText("laptop token");
  const agentRows = people.getByRole("rowgroup", { name: "@quill-agents" }).getByRole("row");
  await expect(cells(agentRows.nth(0))).toHaveText(["@quill-agents", "1", "1", "0", "0", "0", /.+/, ""]);
  await expect(agentRows.nth(1)).toContainText("codex-cloud sandbox token");
  await expect(agentRows.nth(1)).toContainText("Codex · 1 session · unverified labels");
  // Blocking is for laptop tokens: the sandbox token has no Block control.
  await expect(agentRows.nth(1).getByText("Block on this repo")).toHaveCount(0);

  await devRows.nth(1).getByText("Block on this repo").click();
  await devRows.nth(1).getByLabel("Note (optional)").fill("lost laptop");
  await devRows.nth(1).getByRole("button", { name: /^Block laptop token / }).click();
  await expect(people.getByRole("rowgroup", { name: "@quill-dev" }).getByRole("row").nth(1)).toContainText("Blocked");
  await expect(people.getByText("Block on this repo")).toHaveCount(0);

  await page.goto("/quill-ink/ledger/settings");
  const blocked = page.getByRole("table", { name: "Blocked laptop tokens" }).getByRole("row").nth(1);
  await expect(blocked).toContainText("@quill-dev");
  await expect(blocked).toContainText("@quill-admin lost laptop");

  // Voided at once on this repo, refused here from now on, and still attesting elsewhere.
  expect(await ledger.verify(page)).toMatchObject({ result: "fallback", reason: "attestation_revoked" });
  expect(await dev.run(ledger)).toMatchObject({ outcome: "refused", refusal: "token_rejected", attested: false });
  expect(await dev.run(journal)).toMatchObject({ outcome: "passed", attested: true });
  expect(await journal.verify(page)).toMatchObject({ result: "skip" });
});

test("an admin revokes someone else's sandbox token in Settings, and the owner revokes their laptop token on the Tokens page", async ({ page, world }) => {
  const press = await installedRepo(world, "quill-press", "api");
  const admin = world.github.addUser({ login: "quill-press-admin" });
  world.github.setPermission(press.repo, admin, "admin");
  const agentOwner = world.github.addUser({ login: "quill-press-agents" });
  world.github.setPermission(press.repo, agentOwner, "write");
  const sandbox = await world.sandboxToken({ creator: agentOwner, repo: press.repo, name: "claude-cloud" });
  expect(await sandboxRun(world, press, sandbox)).toMatchObject({ outcome: "passed", attested: true });
  expect(await press.verify(page)).toMatchObject({ result: "skip" });

  await signIn(page, world, admin);
  await page.goto("/quill-press/api/settings");
  const row = page.getByRole("table", { name: "Sandbox tokens" }).getByRole("row").nth(1);
  await expect(row).toContainText("@quill-press-agents");
  await row.getByText("Revoke", { exact: true }).click();
  await page.getByRole("button", { name: "Revoke claude-cloud" }).click();
  await expect(page.getByRole("table", { name: "Sandbox tokens" })).toHaveCount(0);

  expect(await press.verify(page)).toMatchObject({ result: "fallback", reason: "attestation_revoked" });
  expect(await sandboxRun(world, press, sandbox)).toMatchObject({ outcome: "refused", refusal: "token_rejected" });

  // The owner of a laptop token revokes it themselves, with the same effect.
  const studio = await installedRepo(world, "quill-studio", "api");
  const owner = await developer(world, "quill-studio-dev", [studio]);
  expect(await owner.run(studio)).toMatchObject({ outcome: "passed", attested: true });
  expect(await studio.verify(page)).toMatchObject({ result: "skip" });
  await page.context().clearCookies();
  await signIn(page, world, owner.user, "/settings/tokens");
  const laptop = page.getByRole("table", { name: "Laptop tokens" }).getByRole("row").nth(1);
  await laptop.getByText("Revoke", { exact: true }).click();
  await laptop.getByRole("button", { name: /^Revoke .+/ }).click();
  await expect(page.getByRole("table", { name: "Laptop tokens" })).toHaveCount(0);

  expect(await studio.verify(page)).toMatchObject({ result: "fallback", reason: "attestation_revoked" });
});

test("non-admins see no revoke or block controls, and a public repo's People reads signed out without them", async ({ page, world }) => {
  const shop = await installedRepo(world, "quill-shop", "web", "public");
  const writer = await developer(world, "quill-shop-dev", [shop]);
  const agentOwner = world.github.addUser({ login: "quill-shop-agents" });
  world.github.setPermission(shop.repo, agentOwner, "write");
  const sandbox = await world.sandboxToken({ creator: agentOwner, repo: shop.repo, name: "cursor-bg" });
  expect(await writer.run(shop)).toMatchObject({ outcome: "passed", attested: true });
  expect(await sandboxRun(world, shop, sandbox)).toMatchObject({ outcome: "passed", attested: true });

  await page.goto("/quill-shop/web/people");
  await expect(page.getByRole("rowgroup", { name: "@quill-shop-dev" })).toBeVisible();
  await expect(page.getByText("Block on this repo")).toHaveCount(0);

  await signIn(page, world, writer.user);
  await page.goto("/quill-shop/web/people");
  await expect(page.getByRole("rowgroup", { name: "@quill-shop-agents" })).toContainText("cursor-bg");
  await expect(page.getByText("Block on this repo")).toHaveCount(0);
  await page.goto("/quill-shop/web/settings");
  // A writer sees only their own sandbox tokens; someone else's is neither listed nor revocable.
  await expect(page.getByText("cursor-bg")).toHaveCount(0);
  await expect(page.getByText("Revoke", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No laptop token is blocked on quill-shop/web.")).toBeVisible();
});
