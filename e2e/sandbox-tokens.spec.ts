import { expect, signIn, test } from "@testnotary/test-world/playwright";
import type { World } from "@testnotary/test-world";

// Sandbox tokens in the dashboard: a person with write access creates one for a repo, sees its
// value once, an agent's sandbox attests with it, and the person revokes it from the Tokens page.

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };

async function installedRepo(world: World, owner: string, name: string) {
  const fixture = await world.fixtureRepo({ config: PASSING });
  const repo = await world.hostOnGitHub(fixture, { owner, name, visibility: "private" });
  await world.github.installApp({ account: { login: owner, type: "Organization" }, repos: [repo] });
  return { fixture, repo };
}

/** `testnotary run --json` in an agent sandbox (Codex cloud's marker) with the token as its secret. */
async function runInSandbox(world: World, cwd: string, token: string) {
  const result = await world.runCli(["run", "--json"], { cwd, env: { TESTNOTARY_SANDBOX: "1", CODEX_CI: "1", TESTNOTARY_TOKEN: token } });
  return { exitCode: result.exitCode, json: JSON.parse(result.stdout) as Record<string, unknown>, stderr: result.stderr };
}

function inDays(days: number): string {
  const at = new Date(Date.now() + days * 86_400_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

test("a writer creates a sandbox token in Settings, sees it once, an agent attests with it, and revoking it stops it", async ({ page, world }) => {
  const devon = world.github.addUser({ login: "devon-agents" });
  const { fixture, repo } = await installedRepo(world, "fernpay", "agents-api");
  world.github.setPermission(repo, devon, "write");

  await signIn(page, world, devon);
  await page.goto("/fernpay/agents-api/settings");
  await page.getByText("Create sandbox token").click();
  await page.getByLabel("Name").fill("codex-cloud");
  await page.getByRole("button", { name: "Create token" }).click();

  const shown = page.getByLabel("New sandbox token value");
  await expect(shown).toHaveText(/^tns_[A-Za-z0-9_-]{40}$/);
  const token = (await shown.textContent())!;
  await expect(page.getByText("Copy it now: it is shown only this once.")).toBeVisible();
  const list = page.getByRole("table", { name: "Sandbox tokens" });
  await expect(list.getByRole("row")).toHaveCount(2);
  await expect(list.getByRole("row").nth(1)).toContainText("codex-cloud");
  await expect(list.getByRole("row").nth(1)).toContainText("@devon-agents");
  await expect(list.getByRole("row").nth(1)).toContainText(inDays(90));

  const attested = await runInSandbox(world, fixture.dir, token);
  expect(attested.json).toMatchObject({ outcome: "passed", attested: true });
  expect(attested.stderr).toMatch(/attesting as @devon-agents with sandbox token "codex-cloud"/);
  expect(await world.db.dump()).not.toContain(token);

  await page.reload();
  await expect(page.getByText(token)).toHaveCount(0);
  await expect(page.getByLabel("New sandbox token value")).toHaveCount(0);

  await page.goto("/settings/tokens");
  const mine = page.getByRole("table", { name: "Sandbox tokens you created" });
  const row = mine.getByRole("row").nth(1);
  await expect(row).toContainText("codex-cloud");
  await expect(row).toContainText("fernpay/agents-api");
  await expect(row.locator("time")).toHaveText("just now");
  await row.getByText("Revoke", { exact: true }).click();
  await page.getByRole("button", { name: "Revoke codex-cloud" }).click();
  await expect(page.getByRole("table", { name: "Sandbox tokens you created" })).toHaveCount(0);
  await expect(page.getByText("You have not created a sandbox token.")).toBeVisible();

  const after = await runInSandbox(world, fixture.dir, token);
  expect(after.exitCode).toBe(2);
  expect(after.json).toMatchObject({ outcome: "refused", refusal: "token_rejected" });
});

test("the Tokens page creates one for a repo you can write to, for up to a year; a reader can't create one", async ({ page, world }) => {
  const maria = world.github.addUser({ login: "maria-agents" });
  const { repo: web } = await installedRepo(world, "acme-agents", "web");
  const { repo: infra } = await installedRepo(world, "acme-agents", "infra");
  world.github.setPermission(web, maria, "write");
  world.github.setPermission(infra, maria, "read");

  await signIn(page, world, maria, "/settings/tokens");
  await page.getByText("Create sandbox token").click();
  await expect(page.getByLabel("Repository").locator("option")).toHaveText(["acme-agents/web"]);
  await page.getByLabel("Name").fill("claude-cloud");
  await page.getByLabel("Expires after").selectOption({ label: "1 year" });
  await page.getByRole("button", { name: "Create token" }).click();

  await expect(page.getByLabel("New sandbox token value")).toHaveText(/^tns_/);
  const row = page.getByRole("table", { name: "Sandbox tokens you created" }).getByRole("row").nth(1);
  await expect(row).toContainText("claude-cloud");
  await expect(row).toContainText("acme-agents/web");
  await expect(row).toContainText(inDays(365));
  await expect(row).toContainText("Not used yet");

  await page.goto("/acme-agents/infra/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByText("Create sandbox token")).toHaveCount(0);
  await expect(page.getByText("Write access to acme-agents/infra is needed to create a sandbox token.")).toBeVisible();
});

test("an admin sees every sandbox token of the repo in Settings, with who created it", async ({ page, world }) => {
  const priya = world.github.addUser({ login: "priya-agents" });
  const devon = world.github.addUser({ login: "devon-k" });
  const { repo } = await installedRepo(world, "fernpay", "payouts");
  world.github.setPermission(repo, priya, "admin");
  world.github.setPermission(repo, devon, "write");
  await world.sandboxToken({ creator: devon, repo, name: "copilot-agents" });

  await signIn(page, world, priya);
  await page.goto("/fernpay/payouts/settings");

  const row = page.getByRole("table", { name: "Sandbox tokens" }).getByRole("row").nth(1);
  await expect(row).toContainText("copilot-agents");
  await expect(row).toContainText("@devon-k");
});
