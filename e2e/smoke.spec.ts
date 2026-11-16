import { expect, test } from "@testnotary/test-world/playwright";

test("the web app serves its home page and its health route from the world's database", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Pass once\.\s*Skip in CI\./);

  const health = await request.get("/api/v1/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok", database: "ok" });
});
