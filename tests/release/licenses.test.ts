import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { releaseScript, scratch } from "./scripts.ts";

// The CI license allowlist (`pnpm licenses:check`): every installed package must carry an
// OSI-approved license, or be a named exception under the license it was reviewed with. The
// check reads `pnpm licenses list --json -r`; these tests hand it that output directly.

let out: { dir: string; remove: () => Promise<void> };
let inputs = 0;

beforeAll(async () => {
  out = await scratch("testnotary-licenses");
});

afterAll(async () => {
  await out?.remove();
});

/** `pnpm licenses list --json` output for these packages (it groups them by license). */
async function listing(packages: { name: string; version?: string; license: string }[]): Promise<string> {
  const grouped: Record<string, { name: string; versions: string[]; paths: string[]; license: string }[]> = {};
  for (const pkg of packages) {
    (grouped[pkg.license] ??= []).push({ name: pkg.name, versions: [pkg.version ?? "1.0.0"], paths: [`/x/${pkg.name}`], license: pkg.license });
  }
  const file = join(out.dir, `listing-${++inputs}.json`);
  await writeFile(file, JSON.stringify(grouped));
  return file;
}

const check = async (packages: Parameters<typeof listing>[0]) => releaseScript("check-licenses", ["--input", await listing(packages)]);

describe("the license allowlist", () => {
  test("passes permissive and other OSI licenses, and an OR expression with one allowed side", async () => {
    const result = await check([
      { name: "a", license: "MIT" },
      { name: "b", license: "Apache-2.0" },
      { name: "c", license: "BSD-3-Clause" },
      { name: "d", license: "LGPL-3.0-or-later" },
      { name: "e", license: "(MIT OR CC0-1.0)" },
    ]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^5 packages checked: all allowed\.$/m);
  });

  test("fails on a non-OSI license, naming the package, its version and its license", async () => {
    const result = await check([
      { name: "fine", license: "MIT" },
      { name: "mongo-ish", version: "2.3.4", license: "SSPL-1.0" },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('mongo-ish@2.3.4: "SSPL-1.0" is not an allowed license (OSI-approved licenses only)');
    expect(result.stderr).not.toContain("fine@");
  });

  test("fails on an AND expression with one non-OSI side, and on a missing license", async () => {
    const result = await check([
      { name: "half", license: "(MIT AND CC-BY-NC-4.0)" },
      { name: "unlabelled", license: "Unknown" },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^half@1\.0\.0: /m);
    expect(result.stderr).toMatch(/^unlabelled@1\.0\.0: /m);
  });

  test("`@sentry/cli` under FSL-1.1-MIT passes as the named exception, and the run says so", async () => {
    const result = await check([{ name: "@sentry/cli", version: "2.58.0", license: "FSL-1.1-MIT" }]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^@sentry\/cli@2\.58\.0: FSL-1\.1-MIT, allowed as an exception: /m);
  });

  test("the same non-OSI license on any other package fails", async () => {
    const result = await check([{ name: "some-cli", version: "1.2.0", license: "FSL-1.1-MIT" }]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('some-cli@1.2.0: "FSL-1.1-MIT" is not an allowed license');
  });

  test("an excepted package that changes its license fails until the exception is reviewed again", async () => {
    const result = await check([{ name: "@sentry/cli", version: "3.0.0", license: "BUSL-1.1" }]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('@sentry/cli@3.0.0: "BUSL-1.1" is not allowed: its exception was reviewed under "FSL-1.1-MIT"');
  });

  test("the repo's own installed dependencies pass", async () => {
    const result = await releaseScript("check-licenses");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
