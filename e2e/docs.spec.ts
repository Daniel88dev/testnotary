import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FALLBACK_REASONS, REFUSAL_CODES, SESSION_AGENTS, VERIFICATION_RESULTS, WARNING_CODES, parseConfig } from "@testnotary/core";
import { LINKS, githubDeniedCause, loginError } from "@testnotary/protocol";
import { expect, test } from "@testnotary/test-world/playwright";

// The docs tree as the spec lists it ("Docs": 28 pages in six groups, plus the licensing and
// security pages added later). The Reference group is T-831's: its pages exist as stubs here.
const WRITTEN: Record<string, string[]> = {
  "Start here": ["What Testnotary does", "Setup guide", "How a skip is decided"],
  Guides: ["Agents and sandbox tokens", "Shadow mode and enforce", "Audits and mismatches", "Forks, Dependabot and Copilot"],
  "Workflow recipes": ["Gate job", "Matrix jobs", "Merge queues and up-to-date branches", "Coverage and test reports"],
  "Test command recipes": [
    "Build before the tests",
    "Postgres and other services",
    "Playwright and other caches",
    "Shell features and .env files",
    "Run the suite in Docker",
    "A pre-push hook",
  ],
  Reference: [
    "testnotary.json",
    "CLI commands",
    "Exit codes and output",
    "Refusal codes",
    "Action inputs and outputs",
    "Fallback reason codes",
    "What the pull request shows",
    "Guarded files",
  ],
  Trust: ["What Testnotary can’t prove", "What leaves your machine", "Limits in v1", "Security", "Licensing"],
};

// The CLI's own failure codes (`{"error": …}` with `--json`), which the CLI reference names.
const CLI_ERRORS = [
  ...loginError.options,
  ...githubDeniedCause.options,
  "login_in_sandbox",
  "service_error",
  "token_not_found",
  "token_ambiguous",
  "ssh_keygen_failed",
  "no_package_json",
  "no_test_script",
];

test("the package-manager tabs switch every code panel on the page and the choice is remembered", async ({ page }) => {
  await page.goto("/docs/setup");
  const article = page.getByRole("main");
  const switching = article.locator("figure.code").filter({ has: page.getByRole("tablist", { name: "Package manager" }) });
  // The terminal, testnotary.json, AGENTS.md, the workflow, the sign-in and the first run at least.
  expect(await switching.count()).toBeGreaterThanOrEqual(6);
  await expect(article).toContainText("pnpm add -D testnotary");
  await expect(article).toContainText("pnpm install --frozen-lockfile");

  // One tab, in the workflow panel, switches all of them.
  const workflow = switching.filter({ hasText: ".github/workflows/ci.yml" }).first();
  await workflow.getByRole("tab", { name: "npm", exact: true }).click();
  for (const panel of await switching.all()) await expect(panel.getByRole("tab", { name: "npm", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(article).toContainText("npm install -D testnotary");
  await expect(article).toContainText("- run: npm ci");
  await expect(article).toContainText('"command": ["npm", "test"]');
  await expect(article).toContainText("npx testnotary run test");
  await expect(article).not.toContainText("pnpm/action-setup");
  await expect(article).not.toContainText("pnpm exec");

  // Remembered across a reload and on another page.
  await page.reload();
  await expect(article).toContainText("npm install -D testnotary");
  await page.goto("/docs/hook");
  await expect(page.getByRole("main")).toContainText("exec npx testnotary run unit --require-attestation");

  await page.getByRole("main").getByRole("tab", { name: "yarn" }).first().click();
  await page.goto("/docs/setup");
  await expect(page.getByRole("main")).toContainText("yarn add -D testnotary");
  await expect(page.getByRole("main")).toContainText("yarn install --immutable");
});

test("search filters the page tree by title and by heading, and links straight to a matching heading", async ({ page }) => {
  await page.goto("/docs/intro");
  const tree = page.getByRole("navigation", { name: "Docs" });
  const search = page.getByRole("searchbox", { name: "Search the docs" });

  // "/" focuses the box.
  await page.keyboard.press("/");
  await expect(search).toBeFocused();

  // By title.
  await search.fill("matrix");
  await expect(tree.getByRole("link", { name: "Matrix jobs", exact: true })).toBeVisible();
  await expect(tree.getByRole("link", { name: "Setup guide", exact: true })).toBeHidden();
  await expect(tree.getByRole("heading", { name: "Workflow recipes" })).toBeVisible();
  await expect(tree.getByRole("heading", { name: "Trust" })).toBeHidden();

  // By a heading inside a page whose title doesn't match: the GitHub Enterprise section of "Limits in v1".
  await search.fill("enterprise");
  await expect(tree.getByRole("link", { name: "Limits in v1", exact: true })).toBeVisible();
  const hit = tree.getByRole("link", { name: "GitHub Enterprise", exact: true });
  await expect(hit).toHaveAttribute("href", "/docs/limits#github-enterprise");
  await expect(tree.getByRole("link", { name: "Gate job", exact: true })).toBeHidden();

  // A setup-guide step is a heading too.
  await search.fill("sandbox token");
  await expect(tree.getByRole("link", { name: "Give each agent a sandbox token" })).toHaveAttribute("href", "/docs/setup#agents");
  await expect(tree.getByRole("link", { name: "Agents and sandbox tokens", exact: true })).toBeVisible();

  await search.fill("enterprise");
  await tree.getByRole("link", { name: "GitHub Enterprise", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/limits#github-enterprise$/);
  await expect(page.getByRole("heading", { level: 2, name: "GitHub Enterprise" })).toBeInViewport();

  await search.fill("no such words anywhere");
  await expect(tree).toContainText("No page or heading matches");
  await search.fill("");
  await expect(tree.getByRole("link", { name: "Setup guide", exact: true })).toBeVisible();
});

test("on a phone the page tree is a full-screen menu and “On this page” is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/docs/setup");
  const tree = page.getByRole("navigation", { name: "Docs" });
  const menu = page.getByRole("button", { name: "Menu" });

  await expect(page.getByRole("complementary", { name: "On this page" })).toBeHidden();
  await expect(tree).toBeHidden();

  await menu.click();
  await expect(tree).toBeVisible();
  const box = (await tree.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(375);
  expect(box.y + box.height).toBeGreaterThanOrEqual(812 - 1);

  await tree.getByRole("link", { name: "Gate job", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/gate$/);
  await expect(tree).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Gate job" })).toBeVisible();

  // Typing a search on a phone opens the tree to show what matches.
  await page.getByRole("searchbox", { name: "Search the docs" }).fill("docker");
  await expect(tree.getByRole("link", { name: "Run the suite in Docker", exact: true })).toBeVisible();

  // On a wide screen both are there, with the guide's parts and steps in "On this page".
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs/setup");
  const toc = page.getByRole("complementary", { name: "On this page" });
  await expect(toc).toBeVisible();
  await expect(toc.getByRole("link", { name: "Set up who attests" })).toHaveAttribute("href", "#who");
  await expect(toc.getByRole("link", { name: "Switch the repo to enforce" })).toHaveAttribute("href", "#enforce");
  await expect(page.getByRole("navigation", { name: "Docs" })).toBeVisible();

  // Scroll spy: the step in view and its part are marked.
  await page.locator("#login").evaluate((step) => (step as unknown as { scrollIntoView(options: object): void }).scrollIntoView({ block: "start" }));
  await expect(toc.getByRole("link", { name: "Sign in on your laptop" })).toHaveAttribute("aria-current", "location");
  await expect(toc.getByRole("link", { name: "Set up who attests" })).toHaveAttribute("aria-current", "location");
  await expect(toc.getByRole("link", { name: "Install the GitHub App" })).not.toHaveAttribute("aria-current", /.*/);
});

test("the setup guide has nine numbered steps in three parts at the anchors the dashboard and the CLI link", async ({ page }) => {
  await page.goto("/docs/setup");
  const parts = { repo: "Set up the repo", who: "Set up who attests", skip: "Get to the first skip" };
  const steps = ["install-app", "pin", "library", "action", "merge", "login", "agents", "first-pr", "enforce"];
  for (const [id, title] of Object.entries(parts)) await expect(page.locator(`#${id}`).getByRole("heading", { level: 2 })).toHaveText(title);
  for (const [i, id] of steps.entries()) {
    const step = page.locator(`li#${id}`);
    await expect(step).toBeVisible();
    // The number continues across the parts.
    await expect(step.locator(".num")).toHaveText(String(i + 1));
  }

  // The workflow snippet grants the same three permissions everywhere (open decision 1).
  const workflow = page.locator("figure.code").filter({ hasText: ".github/workflows/ci.yml" }).first();
  await expect(workflow).toContainText("contents: read");
  await expect(workflow).toContainText("id-token: write");
  await expect(workflow).toContainText("checks: write");
  await expect(workflow).toContainText("TESTNOTARY_DISABLED: ${{ vars.TESTNOTARY_DISABLED }}");
  await expect(workflow).toContainText("uses: Daniel88dev/testnotary@v1");

  // The CLI's links land on real sections.
  for (const url of [LINKS.githubEnterpriseLimits, LINKS.sandboxTokens, LINKS.setupGuide]) {
    const { pathname, hash } = new URL(url);
    await page.goto(pathname + hash);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (hash) await expect(page.locator(hash)).toBeInViewport();
  }
});

test("every testnotary.json the docs show is one the library accepts", async ({ page }) => {
  let seen = 0;
  for (const slug of ["setup", "build", "services", "caches", "shell", "docker", "security", "config", "guarded"]) {
    await page.goto(`/docs/${slug}`);
    for (const panel of await page.locator("figure.code").filter({ hasText: /^testnotary\.json/ }).all()) {
      const text = await panel.locator("pre").innerText();
      const parsed = parseConfig(text);
      // The shell page's second example is a mistake on purpose: valid JSON, but it runs `vitest` with "&&" as an argument.
      expect(parsed.ok, `${slug}: ${text}`).toBe(true);
      seen++;
    }
  }
  expect(seen).toBeGreaterThanOrEqual(10);
});

test("the setup guide shows the testnotary.json init writes, and the suite it names runs through the guide", async ({ page, world }) => {
  const repo = await world.fixtureRepo({ config: null, files: { "package.json": '{ "packageManager": "pnpm@10.34.9", "scripts": { "test": "vitest run" } }\n' } });
  const init = await world.runCli(["init", "--yes"], { cwd: repo.dir });
  expect(init.exitCode).toBe(0);
  const written = parseConfig(await readFile(join(repo.dir, "testnotary.json"), "utf8"));
  if (!written.ok) throw new Error(written.problems.join("\n"));
  const [suite] = Object.keys(written.config.suites);

  await page.goto("/docs/setup");
  const article = page.getByRole("main");
  const panel = article.locator("li#library figure.code").filter({ hasText: /^testnotary\.json/ });
  const shown = parseConfig(await panel.locator("pre").innerText());
  if (!shown.ok) throw new Error(shown.problems.join("\n"));
  expect(shown.config).toEqual(written.config);

  // init asks about the two files only, and the rest of the guide runs the suite it wrote.
  await expect(article.locator("li#library")).not.toContainText("asks for your suites");
  await expect(article).toContainText(`pnpm exec testnotary run ${suite}`);
  for (const label of await article.locator("figure.code.check figcaption").allInnerTexts()) expect(label).toContain(`/ Testnotary / ${suite} (`);
});

// The spec's "Accepted limits the docs must state", each as words a page must carry.
const ACCEPTED_LIMITS = [
  "A person who controls their machine can fake a pass. Audits make that detectable, not impossible.",
  "A compromised service can leave audits out undetected in signature mode.",
  "A repo that doesn’t opt into signatures trusts the service.",
  "stale-base hole",
  "Codex cloud has no sandbox marker, so TESTNOTARY_SANDBOX=1 covers it",
  "Hand edits inside node_modules go unnoticed.",
  "A history flag hidden deeper than one script level is left to audits.",
];

test("every accepted limit is stated on a Trust or Security page", async ({ page }) => {
  const text: string[] = [];
  for (const path of ["/docs/limit", "/docs/data", "/docs/limits", "/docs/security"]) {
    await page.goto(path);
    text.push(await page.getByRole("main").innerText());
  }
  const all = text.join("\n").replace(/\s+/g, " ");
  for (const limit of ACCEPTED_LIMITS) expect(all, limit).toContain(limit);

  // The security page also covers SHA pinning with a Dependabot-kept version comment, and signature mode.
  await page.goto("/docs/security");
  const security = page.getByRole("main");
  await expect(security).toContainText(/uses: Daniel88dev\/testnotary@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  await expect(security).toContainText("package-ecosystem: github-actions");
  await expect(security).toContainText('"signatures": "required"');
});

test("“How a skip is decided” lists the product-default guarded files the verification uses", async ({ page }) => {
  await page.goto("/docs/how");

  const listed = await page.getByRole("main").locator("ul.guarded-defaults code").allInnerTexts();
  // The spec's defaults: workflows, actions, the config, allowed signers, every lockfile, every package.json, the Node version files.
  for (const glob of [".github/workflows/**", ".github/actions/**", "testnotary.json", ".testnotary/allowed_signers", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "package.json", ".nvmrc", ".node-version", ".tool-versions"]) {
    expect(listed, glob).toContain(glob);
  }
});

test("“Agents and sandbox tokens” lists the agents the library detects, from the library’s own table", async ({ page }) => {
  await page.goto("/docs/agents");
  const table = page.getByRole("main").getByRole("table", { name: "Agent detection" });
  const agents = (await table.locator("tbody tr td:first-child").allInnerTexts()).map((text) => text.trim());
  expect(agents).toEqual([...SESSION_AGENTS.map((agent) => agent.vendor), "Any other"]);
  // Each row names the variables the library reads, in code.
  for (const row of await table.locator("tbody tr").all()) expect(await row.locator("td:nth-child(2) code").count()).toBeGreaterThan(0);
});

test("“What leaves your machine” links the privacy policy, and the docs footer links the terms and the privacy policy", async ({ page }) => {
  await page.goto("/docs/data");
  const privacy = page.getByRole("main").getByRole("link", { name: "privacy policy" });
  expect(await privacy.count()).toBeGreaterThan(0);
  for (const link of await privacy.all()) await expect(link).toHaveAttribute("href", "/privacy");

  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  await expect(footer.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
});

test("the docs use only real codes, the checks-list shape and none of the banned words, and load nothing from a third party", async ({ page, world }) => {
  const origins = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "data:") origins.add(url.origin);
  });

  await page.goto("/docs/intro");
  const hrefs = await page
    .getByRole("navigation", { name: "Docs" })
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")!));
  // Codes the docs may name: refusals, fallback reasons, results, warnings and the CLI's failure
  // codes, as the product spells them. GitHub's event names, node_modules and the variable npm sets
  // for the tools it starts look the same, and are fine.
  const known = new Set<string>([
    ...REFUSAL_CODES,
    ...FALLBACK_REASONS,
    ...VERIFICATION_RESULTS,
    ...WARNING_CODES,
    ...CLI_ERRORS,
    "pull_request",
    "merge_group",
    "pull_request_target",
    "workflow_run",
    "issue_comment",
    "workflow_dispatch",
    "node_modules",
    "npm_config_user_agent",
  ]);

  for (const href of hrefs) {
    await page.goto(href);
    await page.waitForLoadState("networkidle");
    const main = page.getByRole("main");
    const text = await main.innerText();
    expect(text, href).not.toMatch(/\bproofs?\b|verified pass|can[’']t fake/i);

    for (const code of await main.locator("code").allInnerTexts()) {
      if (/^[a-z]+(_[a-z]+)+$/.test(code)) expect(known.has(code), `${href}: ${code}`).toBe(true);
    }
    // A picture of the checks list names the check as GitHub shows it.
    for (const label of await main.locator("figure.code.check figcaption").allInnerTexts()) {
      expect(label, href).toMatch(/^\S+ \/ Testnotary \/ \S+ \(\w+\)$/);
    }
  }

  expect([...origins]).toEqual([world.service.url]);
});

test("every page in the tree exists with content, and every link inside the docs resolves", async ({ page, request }) => {
  await page.goto("/docs/setup");
  const tree = page.getByRole("navigation", { name: "Docs" });

  for (const [group, titles] of Object.entries(WRITTEN)) {
    await expect(tree.getByRole("heading", { name: group, exact: true })).toBeVisible();
    for (const title of titles) {
      const href = await tree.getByRole("link", { name: title, exact: true }).getAttribute("href");
      expect(href, title).toMatch(/^\/docs\/[a-z-]+$/);
      await page.goto(href!);
      // The guide keeps its approved heading; every other page is headed by its title.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title === "Setup guide" ? "Set up Testnotary" : title);
      await expect(page).toHaveTitle(new RegExp(`^${title.replace(/[.?]/g, "\\$&")} · Testnotary docs$`));
      const article = page.getByRole("main");
      await expect(article).not.toContainText("This page will hold");
      // Content, not a title alone: at least a few paragraphs of text.
      expect((await article.innerText()).length, title).toBeGreaterThan(600);
    }
  }

  // No page is left a stub: the tree holds exactly the pages above.
  await page.goto("/docs/setup");
  const listed = await tree.getByRole("link").allInnerTexts();
  expect(listed.sort()).toEqual(Object.values(WRITTEN).flat().sort());

  // Every link inside the docs resolves, and an in-page anchor lands on an element of that id.
  const hrefs = new Set<string>();
  for (const link of await page.locator("a[href^='/docs']").all()) hrefs.add((await link.getAttribute("href"))!.split("#")[0]!);
  const anchors = new Map<string, string>();
  for (const href of hrefs) {
    await page.goto(href);
    for (const link of await page.getByRole("main").locator("a[href^='/docs']").all()) {
      const [target = "", anchor] = (await link.getAttribute("href"))!.split("#");
      expect((await request.get(target)).status(), `${href} → ${target}`).toBe(200);
      if (anchor) anchors.set(`${target}#${anchor}`, href);
    }
  }
  for (const [target, from] of anchors) {
    const [path = "", id = ""] = target.split("#");
    await page.goto(path);
    expect(await page.locator(`[id="${id}"]`).count(), `${from} → ${target}`).toBe(1);
  }
});
