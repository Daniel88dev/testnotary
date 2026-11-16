import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { guardedGlobs, guardedMatches, parseConfig } from "@testnotary/core";
import { repoRoot, run } from "./scripts.ts";

function onPath(tool: string): boolean {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("the workflows", () => {
  test.skipIf(!onPath("actionlint"))("are valid: actionlint finds nothing (with shellcheck over their scripts when installed)", async () => {
    const workflows = (await readdir(join(repoRoot, ".github/workflows"))).map((name) => join(".github/workflows", name));
    const result = await run("actionlint", workflows);
    expect(result.stdout + result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("pin every action to a full commit SHA with its release in a comment, so a moved tag runs nothing new", async () => {
    const names = await readdir(join(repoRoot, ".github/workflows"));
    const uses: string[] = [];
    for (const name of names) {
      const text = await readFile(join(repoRoot, ".github/workflows", name), "utf8");
      uses.push(...[...text.matchAll(/^\s*(?:- )?uses:\s*(.+)$/gm)].map((match) => `${name}: ${match[1]!.trim()}`));
    }
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      // A local action (`./…`) is the repo's own code at the same commit.
      if (/: \.\//.test(use)) continue;
      expect(use).toMatch(/: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });

  test("in the release workflow, every step that pushes, releases or publishes is skipped in a dry run", async () => {
    const text = await readFile(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const steps = text.split(/\n(?= {6}- )/).filter((step) => /^ {6}- /.test(step));
    const commands = (step: string) => step.replace(/(name|description): .*/g, "").replace(/#.*/g, "");
    const reaching = steps.filter((step) => /git push|gh release|npm publish(?![^\n]*--dry-run)|changeset publish/.test(commands(step)));
    expect(reaching.map((step) => /name: (.+)/.exec(step)?.[1])).toEqual([
      "Push the release tag",
      "Create the GitHub release",
      "Publish to npm with provenance",
      "Move the major tag",
    ]);
    for (const step of reaching) expect(step).toMatch(/if: \$\{\{ .*env\.DRY_RUN != 'true' \}\}/);
    expect(text).toMatch(/DRY_RUN: \$\{\{ vars\.RELEASE_PUBLISH != 'true' \|\| /);
  });
});

describe("Testnotary's own testnotary.json", () => {
  test("is a valid config, and a change to the lockfile or the pnpm workspace settings is guarded", async () => {
    const parsed = parseConfig(await readFile(join(repoRoot, "testnotary.json"), "utf8"));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.config.guarded).toEqual(expect.arrayContaining(["pnpm-lock.yaml"]));
    const matched = guardedMatches(["pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/core/src/config.ts"], guardedGlobs(parsed.config)).map((match) => match.path);
    expect(matched).toEqual(["pnpm-lock.yaml", "pnpm-workspace.yaml"]);
  });
});
