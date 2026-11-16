import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { installLibrary } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// action.yml is what GitHub reads, and what the docs' inputs page is checked against: every output
// the action sets must be declared there, so `steps.<id>.outputs.<name>` is documented where
// workflows look it up.

const world = useWorld();

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/** The keys of a top-level section of action.yml (`inputs:` or `outputs:`): its two-space-indented names. */
async function declared(section: "inputs" | "outputs"): Promise<string[]> {
  const lines = (await readFile(join(repoRoot, "action.yml"), "utf8")).split("\n");
  const start = lines.indexOf(`${section}:`);
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^ {2}([\w-]+):/.exec(line);
    if (key) keys.push(key[1]!);
  }
  return keys;
}

async function workspace() {
  const fixture = await world.fixtureRepo({ config: { suites: { unit: { command: ["node", "-e", ""] } } } });
  const repo = await world.hostOnGitHub(fixture, { owner: "metadata-owner", name: `widgets-${Math.random().toString(36).slice(2, 8)}` });
  return { fixture, repo };
}

test("every output the gate job sets is declared in action.yml", async () => {
  const { fixture, repo } = await workspace();
  const sha = (await fixture.git("rev-parse", "HEAD")).trim();

  const result = await world.runAction({ repo, sha, workspace: fixture.dir, inputs: { suite: "unit", mode: "verify" }, env: { TESTNOTARY_DISABLED: "true" } });

  expect(Object.keys(result.outputs).sort()).toEqual(["ran", "reason", "result", "skip", "verification"]);
  expect(await declared("outputs")).toEqual(expect.arrayContaining(Object.keys(result.outputs)));
});

test("every output a test step sets is declared in action.yml, and every input it reads is too", async () => {
  const { fixture, repo } = await workspace();
  const sha = (await fixture.git("rev-parse", "HEAD")).trim();
  await installLibrary(fixture.dir);

  const result = await world.runAction({ repo, sha, workspace: fixture.dir, inputs: { suite: "unit" }, env: { TESTNOTARY_DISABLED: "true" } });

  expect(result.outputs).toMatchObject({ result: "fallback", reason: "disabled", ran: "true" });
  expect(await declared("outputs")).toEqual(expect.arrayContaining(Object.keys(result.outputs)));
  expect(await declared("inputs")).toEqual(["suite", "mode", "verification", "github-token"]);
});
