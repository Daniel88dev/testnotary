import { expect, test } from "@testnotary/test-world/playwright";

test("the web app publishes the testnotary.json schema at the URL configs name in $schema", async ({ request }) => {
  const response = await request.get("/schema/v1.json");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toMatchObject({
    $id: "https://testnotary.dev/schema/v1.json",
    title: "testnotary.json",
    required: ["suites"],
    additionalProperties: false,
  });
});
