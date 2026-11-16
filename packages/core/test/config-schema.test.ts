// The JSON schema for `testnotary.json` is published from the repo: the web app serves
// apps/web/public/schema/v1.json at https://testnotary.dev/schema/v1.json, the `$schema` URL that
// `init` writes. These tests read the published file as an editor would. That the file is current
// with the parser's schema is tooling's job, not a test's: `pnpm schema:check`, part of `pnpm lint`.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const publishedPath = fileURLToPath(new URL("../../../apps/web/public/schema/v1.json", import.meta.url));

async function published(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(publishedPath, "utf8")) as Record<string, unknown>;
}

const fullConfig = {
  $schema: "https://testnotary.dev/schema/v1.json",
  base: "main",
  platforms: ["linux/x64", "darwin"],
  env: { pass: ["DATABASE_URL"], set: { NODE_ENV: "test" } },
  guarded: ["scripts/**"],
  nodeVersionFile: ".nvmrc",
  signatures: "required",
  suites: { unit: { command: ["pnpm", "run", "test"], env: { pass: ["REDIS_URL"] } } },
};

describe("the published testnotary.json schema", () => {
  test("names its own URL and JSON Schema draft", async () => {
    expect(await published()).toMatchObject({
      $id: "https://testnotary.dev/schema/v1.json",
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
  });

  test.each([
    { name: "the full documented config", config: fullConfig, valid: true },
    { name: "the minimal config init writes", config: { suites: { unit: { command: ["npm", "test"] } } }, valid: true },
    { name: "an unknown top-level key", config: { ...fullConfig, sutes: {} }, valid: false },
    { name: "an unknown suite key", config: { suites: { unit: { command: ["npm", "test"], shell: true } } }, valid: false },
    { name: "a TESTNOTARY_* name in env.pass", config: { ...fullConfig, env: { pass: ["TESTNOTARY_TOKEN"] } }, valid: false },
    { name: "a TESTNOTARY_* name in env.set", config: { ...fullConfig, env: { set: { TESTNOTARY_URL: "x" } } }, valid: false },
    { name: "a command given as a string", config: { suites: { unit: { command: "npm test" } } }, valid: false },
    { name: "an empty command", config: { suites: { unit: { command: [] } } }, valid: false },
    { name: "no suites", config: { suites: {} }, valid: false },
    { name: "a platform not in Node's spelling", config: { ...fullConfig, platforms: ["linux/x86_64"] }, valid: false },
  ])("judges $name", async ({ config, valid }) => {
    const schema = z.fromJSONSchema(await published());

    expect(schema.safeParse(config).success).toBe(valid);
  });
});
