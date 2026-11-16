import { expect, test } from "@testnotary/test-world/playwright";
import type { Locator } from "@playwright/test";
import type { World } from "@testnotary/test-world";

// The Overview: a repo admin judges at a glance whether Testnotary pays off and what to fix. A repo
// with no verification yet shows the setup checklist instead. Every person and repo here is this
// file's own.

const PASSING = { suites: { unit: { command: ["node", "-e", "process.exit(0)"] } } };

async function installedRepo(world: World, owner: string, name: string, config: Record<string, unknown> | null) {
  const user = world.github.addUser({ login: owner });
  const fixture = await world.fixtureRepo({ config, files: { ".gitignore": "node_modules\n" } });
  const repo = await world.hostOnGitHub(fixture, { owner, name, visibility: "public" });
  await world.github.installApp({ account: { login: owner }, repos: [repo] });
  return { user, fixture, repo };
}

const item = (checklist: Locator, name: string | RegExp) => checklist.getByRole("listitem").filter({ hasText: name });

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** How the chart's table names a day `days` ago (UTC). */
const dayLabel = (days: number) => {
  if (days === 0) return "Today";
  const at = new Date(Date.now() - days * DAY_MS);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
};
const CI_ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };
const hex = () => Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

interface PastVerification {
  daysAgo: number;
  suite: string;
  result: "skip" | "audit" | "fallback" | "would_skip" | "would_fall_back";
  reason?: string;
  /** The job's reports, in arrival order: outcome and the test command's duration in seconds. */
  reports?: ["passed" | "failed" | "refused", number][];
}

/**
 * Verifications and job reports as CI left them on past days. The browser world's service keeps
 * real time, so history in the past is written as the rows the service writes (app role, insert only).
 */
async function pastHistory(world: World, repoId: number, rows: PastVerification[]): Promise<void> {
  const sql = world.db.connect("app");
  try {
    for (const row of rows) {
      const at = new Date(Date.now() - row.daysAgo * DAY_MS - (row.daysAgo === 0 ? 5_000 : 0));
      const sha = hex();
      const [inserted] = await sql<{ id: string }[]>`
        insert into verifications (repo_id, suite, commit, tree, event, iss, mode, result, reason, environment, created_at)
        values (${repoId}, ${row.suite}, ${sha}, ${hex()}, 'pull_request', 'https://token.actions.githubusercontent.com',
                ${row.result.startsWith("would") ? "shadow" : "enforce"}, ${row.result}, ${row.reason ?? null}, ${sql.json(CI_ENVIRONMENT)}, ${at})
        returning id`;
      for (const [index, [outcome, seconds]] of (row.reports ?? []).entries()) {
        await sql`insert into job_reports (verification_id, outcome, duration_ms, environment, created_at)
                  values (${inserted!.id}, ${outcome}, ${seconds * 1000}, ${sql.json(CI_ENVIRONMENT)}, ${new Date(at.getTime() + 60_000 * (index + 1))})`;
      }
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

test("the KPIs, the daily chart, the suites and the fallback reasons count the retained verifications", async ({ page, world }) => {
  const { user, fixture, repo } = await installedRepo(world, "olek-overview", "tally", {
    suites: { unit: { command: ["node", "-e", "process.exit(0)"] }, e2e: { command: ["node", "-e", "process.exit(0)"] } },
  });
  await pastHistory(world, repo.id, [
    // unit: 4 skips this week; its CI test jobs took 60, 180 and 120 s (a refused job ran no tests).
    { daysAgo: 0, suite: "unit", result: "skip" },
    { daysAgo: 1, suite: "unit", result: "skip" },
    { daysAgo: 2, suite: "unit", result: "skip" },
    { daysAgo: 3, suite: "unit", result: "skip" },
    { daysAgo: 1, suite: "unit", result: "fallback", reason: "no_attestation", reports: [["passed", 60]] },
    { daysAgo: 2, suite: "unit", result: "fallback", reason: "no_attestation", reports: [["failed", 180]] },
    { daysAgo: 3, suite: "unit", result: "fallback", reason: "guarded_file_changed", reports: [["passed", 120]] },
    { daysAgo: 4, suite: "unit", result: "fallback", reason: "no_attestation", reports: [["refused", 5]] },
    // Older than the last 14 days, still retained: one more skip and a 120 s job.
    { daysAgo: 20, suite: "unit", result: "skip" },
    { daysAgo: 20, suite: "unit", result: "fallback", reason: "no_attestation", reports: [["passed", 120]] },
    // Past retention: counted nowhere, not even in the median.
    { daysAgo: 91, suite: "unit", result: "skip" },
    { daysAgo: 91, suite: "unit", result: "fallback", reason: "no_attestation", reports: [["passed", 1000]] },
    // e2e: 2 skips; audits agreed (300 s), failed (600 s) and agreed on a re-run (900 s, then 500 s);
    // a shadow comparison agreed (400 s). Median of 300, 400, 500, 600 = 450 s.
    { daysAgo: 0, suite: "e2e", result: "skip" },
    { daysAgo: 1, suite: "e2e", result: "skip" },
    { daysAgo: 0, suite: "e2e", result: "audit", reason: "audit", reports: [["passed", 300]] },
    { daysAgo: 1, suite: "e2e", result: "audit", reason: "audit", reports: [["failed", 600]] },
    { daysAgo: 2, suite: "e2e", result: "audit", reason: "audit", reports: [["failed", 900], ["passed", 500]] },
    { daysAgo: 2, suite: "e2e", result: "would_skip", reports: [["passed", 400]] },
    { daysAgo: 3, suite: "e2e", result: "would_fall_back", reason: "no_attestation" },
  ]);
  // Two local runs of unit today, 30 s and 45 s, uploaded with the developer's laptop token.
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const token = (await machine.keychain())[0]!.secret;
  const tree = await fixture.tree("HEAD");
  const commit = await fixture.revParse("HEAD");
  for (const seconds of [30, 45]) {
    const endedAt = new Date(Date.now() - 1_000);
    const response = await page.request.post("/api/v1/runs", {
      headers: { authorization: `Bearer ${token}` },
      data: {
        repository: repo.fullName,
        outcome: "failed",
        suite: "unit",
        tree,
        commit,
        command: ["node", "-e", "process.exit(0)"],
        exitCode: 1,
        startedAt: new Date(endedAt.getTime() - seconds * 1000).toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: seconds * 1000,
        environment: { os: "linux", osVersion: "6.8.0", arch: "x64", node: "v24.11.0", packageManager: null, tz: "UTC", locale: "C.UTF-8" },
        session: null,
        passedEnv: [],
        guardedMatched: [],
        warnings: [],
        notPinned: [],
        baselineOverrides: [],
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto("/olek-overview/tally");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Setup checklist" })).toHaveCount(0);
  const kpis = page.getByRole("group", { name: "Key numbers" });
  const saved = kpis.getByRole("link", { name: /Test time saved/ });
  const skipped = kpis.getByRole("link", { name: /Test jobs skipped/ });
  const audits = kpis.getByRole("link", { name: /Audits agreed/ });
  // Last 14 days: unit 4 skips × 120 s + e2e 2 skips × 450 s = 1380 s, an estimate.
  await expect(saved).toContainText("23 m 00 s");
  await expect(saved).toContainText("estimate");
  await expect(saved).toContainText("6 skipped jobs × median CI test time");
  // Total local run time sits beside the savings.
  await expect(kpis).toContainText("Local run time 1 m 15 s across 2 runs");
  await expect(skipped).toContainText("40%");
  await expect(skipped).toContainText("6 of 15 test jobs");
  await expect(audits).toContainText("3 / 4");
  await expect(audits).toContainText("1 mismatch");

  // Each KPI switches the daily chart; its table view gives the numbers per day.
  await expect(skipped).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("img", { name: "Test jobs per day by result" })).toBeVisible();
  const perDay = page.getByRole("table", { name: "Per day" });
  // The table view under the chart opens on demand and stays open across metrics.
  const showNumbers = async () => {
    if (!(await perDay.isVisible())) await page.getByText("Numbers per day").click();
  };
  await showNumbers();
  await expect(perDay.getByRole("row", { name: new RegExp(`^${dayLabel(2)} `) })).toHaveText(/^\s*\S+ \S+\s*1\s*1\s*1\s*1\s*0\s*$/);

  await saved.click();
  await expect(page).toHaveURL(/\/olek-overview\/tally\?metric=saved$/);
  await expect(saved).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("img", { name: "Test time saved per day" })).toBeVisible();
  await showNumbers();
  await expect(perDay.getByRole("row", { name: /^Today / })).toContainText("9 m 30 s");
  await expect(perDay.getByRole("row", { name: new RegExp(`^${dayLabel(3)} `) })).toContainText("2 m 00 s");

  await audits.click();
  await expect(page).toHaveURL(/\?metric=audits$/);
  await expect(page.getByRole("img", { name: "Audits and shadow comparisons per day" })).toBeVisible();
  await showNumbers();
  await expect(perDay.getByRole("row", { name: new RegExp(`^${dayLabel(1)} `) })).toHaveText(/^\s*\S+ \S+\s*0\s*1\s*$/);
  await expect(perDay.getByRole("row", { name: new RegExp(`^${dayLabel(2)} `) })).toHaveText(/^\s*\S+ \S+\s*2\s*0\s*$/);

  // By suite: jobs, skipped, audited, the median CI test time the savings use, saved and local run time.
  const suites = page.getByRole("table", { name: "By suite" });
  await expect(suites.getByRole("row", { name: /^unit/ })).toContainText(/8\s*4\s*0\s*2 m 00 s\s*8 m 00 s\s*1 m 15 s/);
  await expect(suites.getByRole("row", { name: /^e2e/ })).toContainText(/7\s*2\s*3\s*7 m 30 s\s*15 m 00 s/);

  // Why jobs ran: top reason first, each linking to the Verifications filtered by it.
  const reasons = page.getByRole("list", { name: "Why jobs ran" }).getByRole("listitem");
  await expect(reasons).toHaveCount(3);
  await expect(reasons.nth(0)).toContainText(/No attestation for this tree\s*4/);
  await expect(reasons.nth(1)).toContainText(/Drawn for an audit\s*3/);
  await expect(reasons.nth(2)).toContainText(/Guarded file changed\s*1/);

  // A longer period takes in the older retained rows, never the ones past 90 days.
  await page.getByRole("combobox", { name: "Period" }).selectOption({ label: "Last 30 days" });
  await expect(page).toHaveURL(/\?metric=audits&period=30$/);
  await expect(saved).toContainText("25 m 00 s");
  await expect(skipped).toContainText("7 of 17 test jobs");
  await page.getByRole("combobox", { name: "Period" }).selectOption({ label: "Last 90 days" });
  await expect(page).toHaveURL(/period=90$/);
  await expect(saved).toContainText("25 m 00 s");
  await expect(skipped).toContainText("7 of 17 test jobs");
  await expect(reasons.nth(0)).toContainText(/No attestation for this tree\s*5/);

  await reasons.nth(0).getByRole("link").click();
  await expect(page).toHaveURL(/\/olek-overview\/tally\/verifications\?reason=no_attestation$/);
  await expect(page.getByRole("heading", { level: 1, name: "Verifications" })).toBeVisible();
});

test("a repo with no verifications shows the setup checklist with the missing step marked", async ({ page, world }) => {
  const { user, fixture } = await installedRepo(world, "ines-setup", "atlas", PASSING);

  await page.goto("/ines-setup/atlas");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const checklist = page.getByRole("list", { name: "Setup checklist" });
  await expect(item(checklist, "App installed")).toContainText("Done");
  await expect(item(checklist, "testnotary.json on the default branch")).toContainText("Done");
  await expect(item(checklist, "A first run from a laptop")).toContainText("Missing");
  await expect(item(checklist, "A first verification from CI")).toContainText("Missing");
  await expect(item(checklist, "Sandbox tokens for agents")).toContainText("Optional");
  await expect(item(checklist, "Enforce")).toContainText("Later");
  await expect(page.getByRole("region", { name: "Set up" })).toContainText("2 of 5 done");
  // Each item links its step of the setup guide.
  await expect(item(checklist, "App installed").getByRole("link")).toHaveAttribute("href", "/docs/setup#install-app");
  await expect(item(checklist, "A first verification from CI").getByRole("link", { name: "Add the action" })).toHaveAttribute("href", "/docs/setup#action");
  await expect(item(checklist, "A first run from a laptop").getByRole("link")).toHaveAttribute("href", "/docs/setup#login");
  // Nothing else of the Overview is shown yet.
  await expect(page.getByRole("region", { name: "Live verifications" })).toHaveCount(0);

  // The developer signs in on a laptop and attests: the laptop step is done.
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  expect((await world.runCli(["run"], { cwd: fixture.dir, machine })).stderr).toMatch(/attested=true/);
  await page.reload();
  await expect(item(checklist, "A first run from a laptop")).toContainText("Done");
  await expect(page.getByRole("region", { name: "Set up" })).toContainText("3 of 5 done");

  // A repo whose default branch has no testnotary.json misses that step.
  await installedRepo(world, "ines-bare", "orrery", null);
  await page.goto("/ines-bare/orrery");
  await expect(item(checklist, "testnotary.json on the default branch")).toContainText("Missing");
  await expect(page.getByRole("region", { name: "Set up" })).toContainText("1 of 5 done");
});

test("the live log shows new verifications without a reload", async ({ page, world }) => {
  const { user, fixture, repo } = await installedRepo(world, "pavel-live", "signal", PASSING);
  const pullRequest = async (branch: string, files: Record<string, string>) => {
    await fixture.checkout("main");
    await fixture.branch(branch);
    await fixture.commit(`Change on ${branch}`, files);
    await fixture.push();
  };
  const verify = async (branch: string, number: number) => {
    const merge = await fixture.testMerge({ base: "main", head: branch, number });
    const token = await world.github.oidc.tokenFor({ repo, sha: merge.sha, ref: `refs/pull/${number}/merge`, eventName: "pull_request" }, "https://testnotary.dev");
    const response = await page.request.post("/api/v1/verifications", {
      headers: { authorization: `Bearer ${token}` },
      data: { suite: "unit", environment: CI_ENVIRONMENT },
    });
    expect(response.status()).toBe(200);
    return merge.sha;
  };

  // Shadow mode, no attestation: the job would have fallen back.
  await pullRequest("first", { "src/a.js": "export const a = 1;\n" });
  const first = await verify("first", 1);

  await page.goto("/pavel-live/signal");
  const log = page.getByRole("log", { name: "Live verifications" });
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log.getByRole("listitem").nth(0)).toContainText(new RegExp(`would_run\\s*${first.slice(0, 7)} unit · no_attestation`));
  await expect(log.getByRole("link", { name: first.slice(0, 7) })).toHaveAttribute("href", `/pavel-live/signal/commit/${first}`);
  await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));

  // The developer attests the next pull request and CI asks: the row arrives on the open page.
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  await pullRequest("second", { "src/b.js": "export const b = 2;\n" });
  expect((await world.runCli(["run"], { cwd: fixture.dir, machine })).stderr).toMatch(/attested=true/);
  const second = await verify("second", 2);

  await expect(log.getByRole("listitem")).toHaveCount(2, { timeout: 20_000 });
  await expect(log.getByRole("listitem").nth(0)).toContainText(new RegExp(`would_skip\\s*${second.slice(0, 7)} unit · @pavel-live laptop`));
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);

  // The log of a private repo is not found for someone GitHub does not let read it.
  const owner = world.github.addUser({ login: "pavel-private" });
  const hidden = await world.hostOnGitHub(await world.fixtureRepo({ config: PASSING }), { owner: owner.login, name: "vault", visibility: "private" });
  await world.github.installApp({ account: { login: owner.login }, repos: [hidden] });
  await pastHistory(world, hidden.id, [{ daysAgo: 0, suite: "unit", result: "would_fall_back", reason: "no_attestation" }]);
  expect((await page.request.get("/api/live/pavel-private/vault")).status()).toBe(404);
  expect((await page.request.get("/api/live/pavel-live/signal")).status()).toBe(200);
});
