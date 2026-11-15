import { fileURLToPath } from "node:url";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, test } from "vitest";
import { useWorld } from "../src/vitest.ts";

// The harness's own checks: the simulated runner and the fake OIDC issuer behave as the live
// tests on research/live-github-tests recorded.

const world = useWorld();
const probe = fileURLToPath(new URL("./fixtures/oidc-probe-action.ts", import.meta.url));

async function pullRequest() {
  const fixture = await world.fixtureRepo();
  await fixture.branch("feature");
  await fixture.commit("Change", { "src/a.js": "export {}\n" });
  await fixture.push();
  const merge = await fixture.testMerge({ base: "main", head: "feature" });
  const repo = world.github.addRepo(fixture, { owner: "acme" });
  return { fixture, merge, repo };
}

describe("simulated runner", () => {
  test("a pull_request job gets an OIDC token naming the test merge commit, valid for 300 s either side", async () => {
    const { fixture, merge, repo } = await pullRequest();

    const result = await world.runAction({ repo, sha: merge.sha, workspace: fixture.dir, entry: probe });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(`Ran on pull_request at ${merge.sha}\n`);
    expect(result.outputs.service).toBe(world.service.url);
    const jwks = createRemoteJWKSet(new URL(world.github.oidc.jwksUrl));
    const { payload } = await jwtVerify(result.outputs.token!, jwks, {
      issuer: world.github.oidc.issuer,
      audience: "https://testnotary.dev",
    });
    expect(payload).toMatchObject({
      sha: merge.sha,
      ref: "refs/pull/1/merge",
      event_name: "pull_request",
      repository: repo.fullName,
      repository_id: String(repo.id),
    });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(payload.iat! - payload.nbf!).toBe(300);
    expect(decodeProtectedHeader(result.outputs.token!).alg).toBe("RS256");
  });

  test("an enterprise job's token names the slug issuer", async () => {
    const { fixture, merge, repo } = await pullRequest();

    const result = await world.runAction({ repo, sha: merge.sha, workspace: fixture.dir, entry: probe, enterpriseSlug: "acme-corp" });

    const { payload } = await jwtVerify(result.outputs.token!, createRemoteJWKSet(new URL(world.github.oidc.jwksUrl)));
    expect(payload.iss).toBe(`${world.github.oidc.issuer}/acme-corp`);
  });

  test("a Dependabot run gets a token, a fork run gets none", async () => {
    const { fixture, merge, repo } = await pullRequest();

    const dependabot = await world.runAction({ repo, sha: merge.sha, workspace: fixture.dir, entry: probe, actor: "dependabot[bot]" });
    const fork = await world.runAction({ repo, sha: merge.sha, workspace: fixture.dir, entry: probe, fork: true });
    const noPermission = await world.runAction({ repo, sha: merge.sha, workspace: fixture.dir, entry: probe, idToken: false });

    const { payload } = await jwtVerify(dependabot.outputs.token!, createRemoteJWKSet(new URL(world.github.oidc.jwksUrl)));
    expect(payload.actor).toBe("dependabot[bot]");
    expect(fork.outputs.token).toBe("none");
    expect(noPermission.outputs.token).toBe("none");
  });

  test("the token request endpoint refuses an unknown request token", async () => {
    const response = await fetch(`${world.github.oidc.issuer}/_request?api-version=2.0`, {
      headers: { authorization: "Bearer not-a-job" },
    });

    expect(response.status).toBe(401);
  });

  test("an override answers an endpoint differently until removed, and requests are recorded", async () => {
    const { merge, repo } = await pullRequest();
    const path = `/repos/${repo.fullName}/git/commits/${merge.sha}`;
    const restore = world.github.override("GET", "/repos/:owner/:repo/git/commits/:sha", () =>
      Response.json({ message: "Server Error" }, { status: 500 }),
    );

    const overridden = await fetch(`${world.github.url}${path}`);
    restore();
    const normal = await fetch(`${world.github.url}${path}`);

    expect([overridden.status, normal.status]).toEqual([500, 200]);
    expect(world.github.requestsTo("GET", "/repos/:owner/:repo/git/commits/:sha").map((r) => r.path)).toEqual([path, path]);
  });
});
