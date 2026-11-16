import { describe, expect, test } from "vitest";
import type { FakeRepo, FixtureRepo } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The job report through the API, as any CI client meets it: `POST /api/v1/verifications/<id>/report`
// with a fresh Actions OIDC token. The action's side is in packages/action/test/run-mode.test.ts.

const world = useWorld();

const AUDIENCE = "https://testnotary.dev";
const ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };
let n = 0;

interface Pull {
  fixture: FixtureRepo;
  repo: FakeRepo;
  merge: { sha: string };
  token(sha?: string): Promise<string>;
}

/** An installed repo with a pull request's merge commit. */
async function pull(): Promise<Pull> {
  const i = ++n;
  const fixture = await world.fixtureRepo({ config: { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } } });
  const repo = await world.hostOnGitHub(fixture, { owner: `org-${i}`, name: "app" });
  await world.github.installApp({ account: { login: `org-${i}`, type: "Organization" }, repos: [repo] });
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  const merge = await fixture.testMerge({ base: "main", head: "feature" });
  return {
    fixture,
    repo,
    merge,
    token: (sha = merge.sha) => world.github.oidc.tokenFor({ repo, sha, ref: "refs/pull/1/merge", eventName: "pull_request" }, AUDIENCE),
  };
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${world.service.url}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function verified(p: Pull): Promise<string> {
  const answer = await call("POST", "/verifications", await p.token(), { suite: "test", environment: ENVIRONMENT });
  expect(answer.status).toBe(200);
  return (answer.body.verification as { id: string }).id;
}

const REPORT = { outcome: "failed", durationMs: 4_210, environment: ENVIRONMENT };

describe("the job report", () => {
  test("is stored against the job's verification, and the verification then shows its outcome", async () => {
    const p = await pull();
    const id = await verified(p);
    expect((await call("GET", `/verifications/${id}`, await p.token())).body.verification).toMatchObject({ jobReport: null });

    const answer = await call("POST", `/verifications/${id}/report`, await p.token(), REPORT);

    expect(answer.status).toBe(201);
    expect(answer.body.jobReport).toMatchObject({ outcome: "failed", durationMs: 4_210 });
    expect((await call("GET", `/verifications/${id}`, await p.token())).body.verification).toMatchObject({ jobReport: { outcome: "failed", durationMs: 4_210 } });
  });

  test("a later report (a re-run job) is the one the verification shows", async () => {
    const p = await pull();
    const id = await verified(p);

    await call("POST", `/verifications/${id}/report`, await p.token(), REPORT);
    await call("POST", `/verifications/${id}/report`, await p.token(), { ...REPORT, outcome: "passed", durationMs: 3_000 });

    expect((await call("GET", `/verifications/${id}`, await p.token())).body.verification).toMatchObject({ jobReport: { outcome: "passed", durationMs: 3_000 } });
  });

  test("is refused for another repo's verification, another commit's, or an id that isn't one", async () => {
    const p = await pull();
    const id = await verified(p);
    const other = await pull();

    expect(await call("POST", `/verifications/${id}/report`, await other.token(), REPORT)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await call("POST", `/verifications/${id}/report`, await p.token("0".repeat(40)), REPORT)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await call("POST", "/verifications/not-an-id/report", await p.token(), REPORT)).toEqual({ status: 404, body: { error: "not_found" } });
  });

  test("needs a valid job token", async () => {
    const p = await pull();
    const id = await verified(p);

    expect(await call("POST", `/verifications/${id}/report`, "not-a-jwt", REPORT)).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("carries what the job did in the end when it fell back on its own, and the verification shows it beside the service's answer", async () => {
    const p = await pull();
    const id = await verified(p);
    // The action's signature check, say, turned the service's answer into a fallback.
    const local = { result: "would_fall_back", reason: "signature_invalid", detail: "tree: signed for another tree" };

    const answer = await call("POST", `/verifications/${id}/report`, await p.token(), { ...REPORT, outcome: "passed", ...local });

    expect(answer.status).toBe(201);
    expect(answer.body.jobReport).toMatchObject({ outcome: "passed", ...local });
    const { verification } = (await call("GET", `/verifications/${id}`, await p.token())).body as { verification: Record<string, unknown> };
    expect(verification).toMatchObject({ result: "would_fall_back", reason: "no_attestation", jobReport: { outcome: "passed", ...local } });
  });

  test("from an older action, without what the job did, is stored as before and shows none", async () => {
    const p = await pull();
    const id = await verified(p);

    const answer = await call("POST", `/verifications/${id}/report`, await p.token(), REPORT);

    expect(answer.status).toBe(201);
    expect(answer.body.jobReport).toMatchObject({ outcome: "failed", result: null, reason: null, detail: null });
  });

  test("takes only the outcome, duration, environment and what the job did", async () => {
    const p = await pull();
    const id = await verified(p);

    const extra = await call("POST", `/verifications/${id}/report`, await p.token(), { ...REPORT, log: "…" });
    const badOutcome = await call("POST", `/verifications/${id}/report`, await p.token(), { ...REPORT, outcome: "cancelled" });
    const badResult = await call("POST", `/verifications/${id}/report`, await p.token(), { ...REPORT, result: "skipped" });

    expect(extra.status).toBe(400);
    expect(badOutcome.status).toBe(400);
    expect(badResult.status).toBe(400);
  });
});
