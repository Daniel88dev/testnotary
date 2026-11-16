import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FALLBACK_REASONS, GUARDED_DEFAULTS, REFUSAL_CODES, VERIFICATION_RESULTS, WARNING_CODES, matchesGuardedGlob } from "@testnotary/core";
import { expect, test } from "@testnotary/test-world/playwright";
import type { Page } from "@playwright/test";
import { EXIT } from "../packages/testnotary/src/report.ts";

// The Reference group of the docs, checked against what the product does: every list on these
// pages is the code's list, read here from the packages (or from the CLI and action.yml), never
// retyped.

/** The rows of a reference table: the first cell's code, then the other cells' text. */
async function tableRows(page: Page, name: string): Promise<string[][]> {
  const table = page.getByRole("main").getByRole("table", { name });
  await expect(table).toBeVisible();
  return table.locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())),
  );
}

const CODE_PAGES = [
  { path: "/docs/refusals", table: "Refusal codes", codes: REFUSAL_CODES },
  { path: "/docs/reasons", table: "Fallback reason codes", codes: FALLBACK_REASONS },
  { path: "/docs/output", table: "Warning codes", codes: WARNING_CODES },
] as const;

for (const { path, table, codes } of CODE_PAGES) {
  test(`${path} lists exactly the ${table.toLowerCase()} the code has, in its order, each with a cause and a fix`, async ({ page }) => {
    await page.goto(path);
    const rows = await tableRows(page, table);

    expect(rows.map(([code]) => code)).toEqual([...codes]);
    for (const [code, cause = "", fix = ""] of rows) {
      expect(cause.length, `${code}: cause`).toBeGreaterThan(20);
      expect(fix.length, `${code}: fix`).toBeGreaterThan(10);
    }
    // Each code has its own anchor, so a line or another page can link straight to it.
    for (const code of codes) await expect(page.locator(`tr#${code}`)).toHaveCount(1);
  });
}

/** The first cell of every row of each docs table whose first header is `header`, one list per table. */
async function firstColumns(page: Page, header: string): Promise<string[][]> {
  const lists: string[][] = [];
  for (const table of await page.getByRole("main").locator("table").all()) {
    if ((await table.locator("thead th").first().innerText()).trim() !== header) continue;
    lists.push((await table.locator("tbody tr td:first-child").allInnerTexts()).map((text) => text.trim()));
  }
  return lists;
}

test("/docs/cli documents exactly the commands and flags `testnotary --help` lists, one section each", async ({ page, world }) => {
  const repo = await world.fixtureRepo();
  const help = await world.runCli(["--help"], { cwd: repo.dir });
  expect(help.exitCode).toBe(0);
  // `  testnotary run [suite] [--base <branch>] …  Run a suite …`: the usage is everything before the two-space gap.
  const usages = help.stdout
    .split("\n")
    .filter((line) => line.startsWith("  testnotary "))
    .map((line) => line.trim().split(/\s{2,}/)[0]!);
  expect(usages.length).toBeGreaterThanOrEqual(9);

  await page.goto("/docs/cli");
  const main = page.getByRole("main");
  const documented = (await main.locator("figure.code").filter({ has: page.locator(".code-head .name", { hasText: /^usage$/ }) }).locator("pre").allInnerTexts()).map((text) => text.trim());
  expect(documented.sort()).toEqual([...usages].sort());

  // Each command has its own section, headed by its name (`/docs/cli#testnotary-run`).
  for (const usage of usages.filter((u) => u !== "testnotary --version")) {
    const name = usage.split(" ")[1]!;
    await expect(main.locator(`h2#testnotary-${name}`)).toHaveText(`testnotary ${name}`);
  }

  // `init --json`'s object, as the page shows it, has the fields init really prints.
  const fresh = await world.fixtureRepo({ config: null, files: { "package.json": '{ "scripts": { "test": "node -e \\"\\"" } }\n' } });
  const init = await world.runCli(["init", "--yes", "--json"], { cwd: fresh.dir });
  expect(init.exitCode).toBe(0);
  const printed = JSON.parse(init.stdout) as Record<string, unknown>;
  const shown = JSON.parse(await main.locator("h2#testnotary-init ~ figure.code").filter({ has: page.locator(".code-head .name", { hasText: /^stdout$/ }) }).first().locator("pre").innerText()) as Record<string, unknown>;
  const shape = (object: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(object).map(([key, value]) => [key, value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : typeof value]));
  expect(shape(shown)).toEqual(shape(printed));
});

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  $id?: string;
}

/** Every key path the schema allows: `env.pass`, and `suites.<name>.command` for a map's entries. */
function keyPaths(node: SchemaNode, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) paths.push(`${prefix}${key}`, ...keyPaths(child, `${prefix}${key}.`));
  // A map whose entries are objects (`suites`): its entries' keys, under `<name>`. A map of strings (`env.set`) has none.
  const entry = node.additionalProperties;
  if (entry && typeof entry === "object" && entry.properties) paths.push(...keyPaths(entry, `${prefix}<name>.`));
  return paths;
}

test("/docs/config documents every key the published schema has, and no other", async ({ page, request }) => {
  const schema = (await (await request.get("/schema/v1.json")).json()) as SchemaNode;
  const keys = keyPaths(schema);
  expect(keys).toContain("suites.<name>.env.pass");

  await page.goto("/docs/config");
  expect(await firstColumns(page, "Key")).toEqual([keys]);
  // Every key has words, and the page links the schema it describes.
  for (const [key, , meaning = ""] of await tableRows(page, "testnotary.json keys")) expect(meaning.length, key).toBeGreaterThan(15);
  await expect(page.getByRole("main")).toContainText(`"$schema": "${schema.$id}"`);
});

/** The keys of a top-level section of action.yml (`inputs:` or `outputs:`), in its order. */
async function actionKeys(section: "inputs" | "outputs"): Promise<string[]> {
  const lines = (await readFile(join(process.cwd(), "action.yml"), "utf8")).split("\n");
  const keys: string[] = [];
  for (const line of lines.slice(lines.indexOf(`${section}:`) + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^ {2}([\w-]+):/.exec(line);
    if (key) keys.push(key[1]!);
  }
  return keys;
}

test("/docs/inputs documents exactly the inputs and outputs action.yml declares, and every result and reason", async ({ page }) => {
  const inputs = await actionKeys("inputs");
  const outputs = await actionKeys("outputs");
  expect(inputs).toContain("suite");
  expect(outputs).toContain("skip");

  await page.goto("/docs/inputs");
  expect(await firstColumns(page, "Input")).toEqual([inputs]);
  expect(await firstColumns(page, "Output")).toEqual([outputs]);
  const main = page.getByRole("main");
  for (const result of VERIFICATION_RESULTS) await expect(main.locator("code", { hasText: new RegExp(`^${result}$`) }).first()).toBeVisible();
  await expect(main.getByRole("link", { name: "Fallback reason codes" }).first()).toHaveAttribute("href", "/docs/reasons");
});

test("/docs/guarded lists exactly the product defaults the verification uses, and a repo's own globs match as it says", async ({ page }) => {
  await page.goto("/docs/guarded");
  const main = page.getByRole("main");
  expect(await main.locator("ul.guarded-defaults code").allInnerTexts()).toEqual([...GUARDED_DEFAULTS]);

  // The worked examples of a repo's own globs: each "matches" / "doesn't match" row agrees with the matcher.
  const rows = await tableRows(page, "How guarded globs match");
  expect(rows.length).toBeGreaterThanOrEqual(6);
  for (const [glob = "", path = "", verdict = ""] of rows) {
    expect(matchesGuardedGlob(glob, path), `${glob} ${verdict} ${path}`).toBe(verdict === "matches");
  }
});

test("/docs/output lists the CLI's exit codes and the fields its --json objects really have", async ({ page, world }) => {
  await page.goto("/docs/output");
  expect(await firstColumns(page, "Exit code")).toEqual([Object.values(EXIT).sort((a, b) => a - b).map(String)]);

  // The objects, from the CLI as a process: `exec --json` prints the run object, `check --json` its own.
  const repo = await world.fixtureRepo({ config: { suites: { unit: { command: ["node", "-e", ""] } } } });
  const exec = await world.runCli(["exec", "unit", "--json"], { cwd: repo.dir });
  const check = await world.runCli(["check", "unit", "--json"], { cwd: repo.dir });
  const [runFields, checkFields] = await firstColumns(page, "Field");
  expect(runFields).toEqual(Object.keys(JSON.parse(exec.stdout) as object));
  expect(checkFields).toEqual(Object.keys(JSON.parse(check.stdout) as object));
});
