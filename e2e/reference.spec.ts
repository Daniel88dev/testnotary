import { FALLBACK_REASONS, REFUSAL_CODES, WARNING_CODES } from "@testnotary/core";
import { expect, test } from "@testnotary/test-world/playwright";
import type { Page } from "@playwright/test";

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
