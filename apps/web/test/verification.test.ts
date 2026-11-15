import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { describe, expect, test } from "vitest";
import { githubError, type FakeRepo, type FixtureRepo } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// Verification through the API, as any CI client meets it: what the service accepts as a job's
// OIDC token, and where it takes the tree from. The action's side is in
// packages/action/test/verify.test.ts.

const world = useWorld();

const AUDIENCE = "https://testnotary.dev";
const ENVIRONMENT = { os: "Linux", arch: "X64", image: "ubuntu24", imageVersion: "20261110.1", node: "v24.11.0" };
let n = 0;

interface Installed {
  fixture: FixtureRepo;
  repo: FakeRepo;
  /** A fresh OIDC token for a job building `sha`, as the runner would hand the action. */
  token(sha: string, options?: { event?: string; claims?: JWTPayload; audience?: string }): Promise<string>;
}

/** An installed repo whose `feature` branch a developer with write access attested on their laptop. */
async function installed(options: { attest?: boolean; install?: boolean; visibility?: "public" | "private" } = {}): Promise<Installed> {
  const i = ++n;
  const fixture = await world.fixtureRepo({ config: { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } } });
  const repo = await world.hostOnGitHub(fixture, { owner: `org-${i}`, name: "app", visibility: options.visibility });
  if (options.install !== false) await world.github.installApp({ account: { login: `org-${i}`, type: "Organization" }, repos: [repo] });
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  if (options.attest) {
    const user = world.github.addUser({ login: `writer-${i}` });
    world.github.setPermission(repo, user, "write");
    const machine = await world.machine();
    world.github.deviceFlow.approveNext(user);
    expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
    const run = await world.runCli(["run"], { cwd: fixture.dir, machine });
    expect(run.stderr).toMatch(/attested=true/);
  }
  return {
    fixture,
    repo,
    token: (sha, { event = "pull_request", claims, audience = AUDIENCE } = {}) =>
      world.github.oidc.tokenFor({ repo, sha, ref: event === "pull_request" ? "refs/pull/1/merge" : "refs/heads/main", eventName: event, claims }, audience),
  };
}

async function verify(token: string, body: Record<string, unknown> = { suite: "test", environment: ENVIRONMENT }) {
  const response = await fetch(`${world.service.url}/api/v1/verifications`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { verification?: Record<string, unknown>; error?: string } };
}

describe("the OIDC token a verification sends", () => {
  test("a token from the Actions issuer for an installed repo is accepted", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });

    const answer = await verify(await r.token(merge.sha));

    expect(answer.status).toBe(200);
    expect(answer.body.verification).toMatchObject({ result: "would_fall_back", reason: "no_attestation" });
  });

  test("a token signed by a key outside GitHub's JWKS is rejected", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const genuine = await r.token(merge.sha);
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT(decodeJwt(genuine)).setProtectedHeader(decodeProtectedHeader(genuine) as { alg: string }).sign(privateKey);
    const otherKid = await new SignJWT(decodeJwt(await r.token(merge.sha))).setProtectedHeader({ alg: "RS256", kid: "not-githubs" }).sign(privateKey);

    expect(await verify(forged)).toEqual({ status: 401, body: { error: "token_rejected" } });
    expect(await verify(otherKid)).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("a token for another audience is rejected", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });

    const answer = await verify(await r.token(merge.sha, { audience: `https://github.com/${r.repo.owner}` }));

    expect(answer).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("an expired token is rejected, and one inside the 60 s skew is not", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const at = Math.floor(Date.now() / 1000);
    const window = (iat: number) => ({ iat, nbf: iat - 300, exp: iat + 300 });

    const expired = await verify(await r.token(merge.sha, { claims: window(at - 361) }));
    const withinSkew = await verify(await r.token(merge.sha, { claims: window(at - 355) }));
    const fromTheFuture = await verify(await r.token(merge.sha, { claims: { iat: at + 120, nbf: at + 120, exp: at + 420 } }));

    expect(expired).toEqual({ status: 401, body: { error: "token_rejected" } });
    expect(withinSkew.status).toBe(200);
    expect(fromTheFuture).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("a token whose exp lies beyond its 300 s life is rejected once it is older than that", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const at = Math.floor(Date.now() / 1000);

    const answer = await verify(await r.token(merge.sha, { claims: { iat: at - 400, nbf: at - 400, exp: at + 3_600 } }));

    expect(answer).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("a token used a second time is rejected", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const token = await r.token(merge.sha);

    const first = await verify(token);
    const replay = await verify(token);

    expect(first.status).toBe(200);
    expect(replay).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("a token naming another issuer is rejected, even one GitHub's keys signed", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const claims = decodeJwt(await r.token(merge.sha));

    const otherIssuer = await world.github.oidc.sign({ ...claims, iss: "https://token.actions.example.com" });
    const prefixed = await world.github.oidc.sign({ ...claims, iss: `${world.github.oidc.issuer}.evil.example` });

    expect(await verify(otherIssuer)).toEqual({ status: 401, body: { error: "token_rejected" } });
    expect(await verify(prefixed)).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("a GitHub Enterprise Cloud slug issuer is accepted, and the verification stores it", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const iss = `${world.github.oidc.issuer}/octocat-inc_2-B`;

    const answer = await verify(await r.token(merge.sha, { claims: { iss, enterprise: "octocat-inc_2-B" } }));

    expect(answer.status).toBe(200);
    expect(answer.body.verification).toMatchObject({ iss, reason: "no_attestation" });
  });

  test("an issuer that only looks like a slug issuer is rejected and logged as claim_iss", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const root = world.github.oidc.issuer;
    const lookalikes = [
      `${root}/acme/extra`, // an extra segment
      `${root}/`, // an empty segment
      `${root}/acme/`, // a trailing slash
      `${root}/acme.inc`, // a character outside [A-Za-z0-9_-]
      `${root}/acme\n`, // a newline after the segment
      `${root}.evil.example/acme`, // another host that starts the same
      `https://evil.example/${root}`, // the issuer inside another URL
      `https://evil.example/?${root}/acme`,
      ` ${root}/acme`,
    ];

    for (const iss of lookalikes) {
      const from = world.service.logs.length;
      const answer = await verify(await r.token(merge.sha, { claims: { iss } }));

      expect(answer, iss).toEqual({ status: 401, body: { error: "token_rejected" } });
      expect(world.service.logs.slice(from), iss).toEqual([expect.objectContaining({ event: "token_rejected", reason: "claim_iss" })]);
    }
  });

  test("no token, or one that isn't a JWT, is rejected", async () => {
    const answer = await fetch(`${world.service.url}/api/v1/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suite: "test", environment: ENVIRONMENT }),
    });

    expect(answer.status).toBe(401);
    expect(await verify("not-a-jwt")).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("the service logs why it rejected a token, and the caller hears only token_rejected", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const replayed = await r.token(merge.sha);
    await verify(replayed);
    const { privateKey } = await generateKeyPair("RS256");
    const cases: [string, string][] = [
      ["replayed_jti", replayed],
      ["claim_aud", await r.token(merge.sha, { audience: "https://example.com" })],
      ["expired", await r.token(merge.sha, { claims: { iat: Math.floor(Date.now() / 1000) - 400, nbf: 0, exp: Math.floor(Date.now() / 1000) - 100 } })],
      ["unknown_key", await new SignJWT(decodeJwt(await r.token(merge.sha))).setProtectedHeader({ alg: "RS256", kid: "not-githubs" }).sign(privateKey)],
      ["malformed", "not-a-jwt"],
    ];

    for (const [reason, token] of cases) {
      const from = world.service.logs.length;
      const answer = await verify(token);

      expect(answer).toEqual({ status: 401, body: { error: "token_rejected" } });
      expect(world.service.logs.slice(from)).toEqual([expect.objectContaining({ level: "warn", event: "token_rejected", reason })]);
    }
  });

  test("a token for a repo without the App is repo_not_installed", async () => {
    const r = await installed({ install: false });
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });

    const answer = await verify(await r.token(merge.sha));

    expect(answer).toEqual({ status: 404, body: { error: "repo_not_installed" } });
  });
});

describe("the tree a verification matches", () => {
  test("is the tree of the token's commit from GitHub; a tree or SHA the runner sends is ignored", async () => {
    const r = await installed({ attest: true });
    const attestedTree = await r.fixture.tree("feature");
    const attestedCommit = await r.fixture.revParse("feature");
    // The pull request moves on, untested; the runner then claims the attested tree and commit.
    await r.fixture.commit("Untested change", { "src/a.js": "export const a = 2;\n" });
    await r.fixture.push();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });

    const answer = await verify(await r.token(merge.sha), { suite: "test", environment: ENVIRONMENT, tree: attestedTree, sha: attestedCommit, commit: attestedCommit });

    expect(answer.status).toBe(200);
    expect(answer.body.verification).toMatchObject({ commit: merge.sha, tree: merge.tree, reason: "no_attestation" });
    expect(merge.tree).not.toBe(attestedTree);
  });

  test("can't be read when GitHub refuses the App: github_denied with GitHub's message, and no decision", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const message = `Although you appear to have the correct authorization credentials, the '${r.repo.owner}' organization has an IP allow list enabled, and your IP address is not permitted to access this resource.`;
    const restore = world.github.override("GET", "/repos/:owner/:repo/git/commits/:sha", () => githubError(403, message));
    try {
      const answer = await verify(await r.token(merge.sha));

      expect(answer).toEqual({ status: 502, body: { error: "github_denied", message } });
    } finally {
      restore();
    }
  });

  test("comes from GitHub on push too: the attested commit pushed to the default branch matches", async () => {
    const r = await installed({ attest: true });
    const attested = await r.fixture.revParse("feature");
    await r.fixture.git("push", "--quiet", "origin", "feature:main");

    const answer = await verify(await r.token(attested, { event: "push" }));

    expect(answer.body.verification).toMatchObject({ commit: attested, tree: await r.fixture.tree("feature"), event: "push", result: "would_skip", reason: null });
  });
});

describe("the paths a verification checks against the guarded files", () => {
  test("come from GitHub's compare, first parent to the token's commit, with the installation token's Contents read only", async () => {
    const r = await installed({ attest: true, visibility: "private" });
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const mark = world.github.requests.length;

    const answer = await verify(await r.token(merge.sha));

    expect(answer.body.verification).toMatchObject({ result: "would_skip", reason: null, detail: null });
    const sent = world.github.requests.slice(mark);
    const compares = sent.filter((request) => request.path.includes("/compare/"));
    expect(compares.map((request) => request.path)).toEqual([`/repos/${r.repo.fullName}/compare/${merge.parents[0]}...${merge.sha}`]);
    expect(compares[0]!.headers.authorization).toMatch(/^Bearer ghs_/);
    // Contents and Metadata read are all the App has: no pull request or other endpoint is asked.
    expect(sent.filter((request) => /\/(pulls|issues|check-runs|actions)\b/.test(request.path))).toEqual([]);
  });

  test("a guarded file the pull request changes is the verification's detail", async () => {
    const r = await installed();
    await r.fixture.commit("Pin Node", { ".nvmrc": "24\n" });
    await r.fixture.push();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });

    const answer = await verify(await r.token(merge.sha));

    expect(answer.body.verification).toMatchObject({ result: "would_fall_back", reason: "guarded_file_changed", detail: ".nvmrc" });
  });

  test("can't be listed when GitHub refuses the compare: github_denied with GitHub's message, and no decision", async () => {
    const r = await installed();
    const merge = await r.fixture.testMerge({ base: "main", head: "feature" });
    const message = `Although you appear to have the correct authorization credentials, the '${r.repo.owner}' organization has an IP allow list enabled, and your IP address is not permitted to access this resource.`;
    const restore = world.github.override("GET", "/repos/:owner/:repo/compare/:basehead", () => githubError(403, message));
    try {
      const answer = await verify(await r.token(merge.sha));

      expect(answer).toEqual({ status: 502, body: { error: "github_denied", message } });
    } finally {
      restore();
    }
  });
});
