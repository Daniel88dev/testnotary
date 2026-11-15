import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Starts this worktree's own Postgres container once, migrates a template database, and hands
    // its address to every test file. Each test file then builds its own world (see useWorld).
    globalSetup: ["packages/test-world/src/vitest-global-setup.ts"],
    pool: "forks",
    // Several worktrees run their suites on one machine at once; keep each run modest.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
