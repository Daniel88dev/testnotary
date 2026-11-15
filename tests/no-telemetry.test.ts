import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

// Sentry is for the service only. The library and the action send nothing anywhere but the
// Testnotary service, even when the machine they run on has a Sentry DSN configured.

const world = useWorld();

const repoRoot = realpathSync(join(import.meta.dirname, ".."));

describe("the library and the action send no telemetry", () => {
  test("testnotary sends nothing to Sentry, even with SENTRY_DSN set", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: { command: ["node", "-e", "process.exit(0)"] } } } });
    const env = { SENTRY_DSN: world.sentry.dsn };

    const results = [
      await world.runCli(["--version"], { cwd: repo.dir, env }),
      await world.runCli(["exec", "unit"], { cwd: repo.dir, env }),
      await world.runCli(["exec", "no-such-suite"], { cwd: repo.dir, env }),
    ];

    expect(results.map((result) => result.exitCode)).toEqual([0, 0, expect.any(Number)]);
    expect(world.sentry.envelopes).toEqual([]);
  });

  test("the action sends nothing to Sentry, even with SENTRY_DSN set", async () => {
    const repo = await world.fixtureRepo();
    const remote = world.github.addRepo(repo, { owner: "acme", name: "widgets" });

    const result = await world.runAction({
      repo: remote,
      sha: await repo.revParse("HEAD"),
      workspace: repo.dir,
      inputs: { suite: "test" },
      env: { SENTRY_DSN: world.sentry.dsn },
    });

    expect(result.exitCode).toBe(0);
    expect(world.sentry.envelopes).toEqual([]);
  });

  test.each(["packages/testnotary", "packages/action"])("%s bundles no telemetry or error-reporting package", (dir) => {
    const bundled = dependencyClosure(join(repoRoot, dir));

    expect(bundled.size).toBeGreaterThan(0);
    expect([...bundled].filter((name) => TELEMETRY.test(name))).toEqual([]);
  });
});

const TELEMETRY =
  /sentry|opentelemetry|posthog|segment|amplitude|mixpanel|datadog|dd-trace|newrelic|bugsnag|rollbar|honeybadger|applicationinsights|logrocket|analytics|telemetry/i;

/**
 * Every package the release bundles into the library or the action: its dependencies and
 * devDependencies (the bundle inlines both), followed through workspace packages and node_modules.
 * The test world is a devDependency for tests only and is never bundled.
 */
function dependencyClosure(packageDir: string): Set<string> {
  const seen = new Set<string>();
  const visit = (dir: string, includeDev: boolean) => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const names = Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...(includeDev ? manifest.devDependencies : {}),
    }).filter((name) => name !== "@testnotary/test-world");
    for (const name of names) {
      if (seen.has(name)) continue;
      const found = locate(dir, name);
      seen.add(name);
      if (found) visit(found, false);
    }
  };
  visit(packageDir, true);
  return seen;
}

/** Node's lookup: `node_modules/<name>` in the package's real directory and each parent. */
function locate(fromDir: string, name: string): string | undefined {
  let dir = realpathSync(fromDir);
  while (true) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
