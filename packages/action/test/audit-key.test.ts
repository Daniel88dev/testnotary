import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { installLibrary } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// A service deployed without its AUDIT_MASTER_KEY can't make the audit draw, so it never decides a
// skip in enforce mode: it answers 503 `not_configured` before recording anything, and CI runs its
// tests. The world here starts the service with no key.

const world = useWorld({ auditMasterKey: null });

const MARKED = { suites: { test: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x')"] } } };

test("without AUDIT_MASTER_KEY an attested pull request in enforce mode is answered 503 not_configured, and CI runs its tests", async () => {
  const fixture = await world.fixtureRepo({ config: MARKED, files: { ".gitignore": "node_modules\nran.txt\n" } });
  const repo = await world.hostOnGitHub(fixture, { owner: "keyless-org", name: "tally" });
  await world.github.installApp({ account: { login: "keyless-org", type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: "keyless-dev" });
  world.github.setPermission(repo, user, "admin");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  expect((await world.runCli(["run"], { cwd: fixture.dir, machine })).stderr).toMatch(/attested=true/);
  expect(await world.changeRepoSettings({ admin: user, repo, mode: "enforce" })).toMatchObject({ ok: true });
  const merge = await fixture.testMerge({ base: "main", head: "feature" });
  const workspace = await fixture.ciCheckout(merge.sha);
  await installLibrary(workspace);
  // As any client meets it: no decision, nothing recorded.
  const token = await world.github.oidc.tokenFor({ repo, sha: merge.sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, "https://testnotary.dev");
  const answer = await fetch(`${world.service.url}/api/v1/verifications`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ suite: "test", environment: { os: "Linux", arch: "X64", image: null, imageVersion: null, node: "v24.11.0" } }),
  });
  expect({ status: answer.status, body: (await answer.json()) as unknown }).toEqual({ status: 503, body: { error: "not_configured" } });
  world.clock.set(new Date());

  let result;
  try {
    result = await world.runAction({ repo, sha: merge.sha, workspace, inputs: { suite: "test" } });
  } finally {
    world.clock.reset();
  }

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(workspace, "ran.txt"))).toBe(true);
  expect(result.outputs).toMatchObject({ result: "fallback", reason: "service_error", ran: "true" });
});
