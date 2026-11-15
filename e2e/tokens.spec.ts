import { expect, signIn, test } from "@testnotary/test-world/playwright";

test("the Tokens page shows a laptop token's last use, renames it and revokes it", async ({ page, world }) => {
  const maria = world.github.addUser({ login: "maria-k" });
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(maria);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const used = Date.now();
  expect((await world.runCli(["whoami"], { cwd: machine.home, machine })).exitCode).toBe(0);

  await signIn(page, world, maria, "/settings/tokens");

  const table = page.getByRole("table", { name: "Laptop tokens" });
  const rows = table.getByRole("row");
  await expect(rows).toHaveCount(2);
  const lastUse = rows.nth(1).locator("time");
  await expect(lastUse).toHaveText("just now");
  const usedAt = Date.parse((await lastUse.getAttribute("datetime"))!);
  expect(Math.abs(usedAt - used)).toBeLessThan(60_000);

  await rows.nth(1).getByText("Rename").click();
  await rows.nth(1).getByRole("textbox").fill("work laptop");
  await rows.nth(1).getByRole("button", { name: "Save name" }).click();
  await expect(rows.nth(1)).toContainText("work laptop");
  const whoami = await world.runCli(["whoami", "--json"], { cwd: machine.home, machine });
  expect(JSON.parse(whoami.stdout)).toMatchObject({ token: { name: "work laptop" } });

  await rows.nth(1).getByText("Revoke", { exact: true }).click();
  await page.getByRole("button", { name: "Revoke work laptop" }).click();
  await expect(page.getByRole("table", { name: "Laptop tokens" })).toHaveCount(0);
  await expect(page.getByText("No laptop token.")).toBeVisible();
  const after = await world.runCli(["whoami", "--json"], { cwd: machine.home, machine });
  expect(after.exitCode).toBe(1);
  expect(JSON.parse(after.stdout)).toMatchObject({ error: "token_rejected" });
});

test("someone else's laptop tokens are not on your Tokens page", async ({ page, world }) => {
  const devon = world.github.addUser({ login: "devon-ruiz" });
  const priya = world.github.addUser({ login: "priya-n" });
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(devon);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);

  await signIn(page, world, priya, "/settings/tokens");

  await expect(page.getByText("No laptop token.")).toBeVisible();
});
