import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

describe("the test world", () => {
  test("the service answers its health route from Postgres", async () => {
    const response = await fetch(`${world.service.url}/api/v1/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "ok" });
  });

  test("the fake GitHub serves a fixture repo's pull request merge commit with its tree", async () => {
    const repo = await world.fixtureRepo();
    await repo.branch("feature");
    const head = await repo.commit("Add a test", { "test/a.test.js": "// a\n" });
    await repo.push("feature");
    const merge = await repo.testMerge({ base: "main", head: "feature" });
    const remote = world.github.addRepo(repo, { owner: "acme", name: "widgets" });

    const response = await fetch(`${world.github.url}/repos/acme/widgets/git/commits/${merge.sha}`);

    expect(response.status).toBe(200);
    const commit = (await response.json()) as { sha: string; tree: { sha: string }; parents: { sha: string }[] };
    expect(commit.sha).toBe(merge.sha);
    expect(commit.tree.sha).toBe(await repo.tree(merge.sha));
    expect(commit.parents.map((parent) => parent.sha)).toEqual([await repo.revParse("main"), head]);
    expect(remote.id).toBeGreaterThan(0);
  });

  test("the fake GitHub answers 404 for a commit it does not have", async () => {
    const repo = await world.fixtureRepo();
    world.github.addRepo(repo, { owner: "acme", name: "gadgets" });

    const response = await fetch(`${world.github.url}/repos/acme/gadgets/git/commits/${"0".repeat(40)}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "Not Found" });
  });

  test("the fixture repo's base branch carries testnotary.json and the remote knows its default branch", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: { command: ["node", "--test"] } } } });

    expect(JSON.parse(await repo.git("show", "origin/main:testnotary.json"))).toEqual({
      suites: { unit: { command: ["node", "--test"] } },
    });
    expect((await repo.git("symbolic-ref", "refs/remotes/origin/HEAD")).trim()).toBe("refs/remotes/origin/main");
  });
});
