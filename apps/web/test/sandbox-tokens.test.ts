import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeInstallation, FakeRepo } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// What a sandbox token may do, through the API as a sandbox meets it: upload for its one repo while
// its creator has write access there, until it expires, and nothing else. Creating one is the
// dashboard's (apps/web/e2e/sandbox-tokens.spec.ts); the library's side is in
// packages/testnotary/test/sandbox.test.ts.

const world = useWorld();

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT = "c".repeat(40);
const DAY_MS = 86_400_000;
let n = 0;

interface Scene {
  repo: FakeRepo;
  /** Another repo of the same installation, where the creator has write access too. */
  other: FakeRepo;
  installation: FakeInstallation;
  creator: FakeAccount;
}

async function scene(): Promise<Scene> {
  const i = ++n;
  const repo = await world.hostOnGitHub(await world.fixtureRepo(), { owner: `fleet-${i}`, name: "api" });
  const other = await world.hostOnGitHub(await world.fixtureRepo(), { owner: `fleet-${i}`, name: "web" });
  const { installation } = await world.github.installApp({ account: { login: `fleet-${i}`, type: "Organization" }, repos: [repo, other] });
  const creator = world.github.addUser({ login: `creator-${i}` });
  world.github.setPermission(repo, creator, "write");
  world.github.setPermission(other, creator, "write");
  return { repo, other, installation, creator };
}

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${world.service.url}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const preflight = (token: string, repo: FakeRepo) => call("POST", "/preflight", token, { repository: repo.fullName });

/** A passed run of `repo` attested with the token the preflight saw. */
async function upload(token: string, repo: FakeRepo, attestFor: FakeRepo = repo) {
  const seen = await preflight(token, attestFor);
  expect(seen.status).toBe(200);
  const { account, token: info, repository } = seen.body as { account: { id: number }; token: { id: string; kind: string }; repository: { id: number } };
  const endedAt = new Date(world.clock.now().getTime() - 1_000).toISOString();
  const payload = {
    format: "testnotary.attestation/v1",
    repository: repository.id,
    suite: "test",
    command: ["npm", "test"],
    tree: TREE,
    commit: COMMIT,
    outcome: "passed",
    attester: { account: account.id, token: info.id, tokenKind: info.kind },
    endedAt,
  };
  return call("POST", "/runs", token, {
    repository: repo.fullName,
    outcome: "passed",
    suite: "test",
    tree: TREE,
    commit: COMMIT,
    command: ["npm", "test"],
    exitCode: 0,
    startedAt: new Date(Date.parse(endedAt) - 2_000).toISOString(),
    endedAt,
    durationMs: 2_000,
    environment: { os: "linux", osVersion: "6.8.0", arch: "x64", node: "v24.11.0", packageManager: null, tz: "UTC", locale: "C.UTF-8" },
    session: { vendor: "Codex", id: "thr_1", url: null },
    passedEnv: [],
    guardedMatched: [],
    warnings: [],
    notPinned: [],
    baselineOverrides: [],
    attestation: { payload: JSON.stringify(payload) },
  });
}

describe("a sandbox token", () => {
  test("uploads for its own repo, as its creator", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.creator, repo: s.repo, name: "claude-cloud" });

    const seen = await preflight(token, s.repo);
    const stored = await upload(token, s.repo);

    expect(seen).toMatchObject({ status: 200, body: { account: { id: s.creator.id, login: s.creator.login }, token: { kind: "sandbox", name: "claude-cloud" } } });
    expect(stored.status).toBe(201);
  });

  test("can't upload for another repo, even one its creator can write to", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.creator, repo: s.repo });

    expect(await preflight(token, s.other)).toEqual({ status: 403, body: { error: "no_write_access" } });
    expect(await upload(token, s.other, s.repo)).toEqual({ status: 403, body: { error: "no_write_access" } });
  });

  test("stops working for its repo the moment its creator loses write access, and works again when it comes back", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.creator, repo: s.repo });
    expect((await preflight(token, s.repo)).status).toBe(200);

    world.github.setPermission(s.repo, s.creator, "read");
    const seen = await preflight(token, s.repo);
    world.github.setPermission(s.repo, s.creator, "write");
    const restored = await preflight(token, s.repo);

    expect(seen).toEqual({ status: 403, body: { error: "no_write_access" } });
    expect(restored.status).toBe(200);
  });

  test("checks its creator's write access again at upload", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.creator, repo: s.repo });
    expect((await preflight(token, s.repo)).status).toBe(200);
    world.github.setPermission(s.repo, s.creator, "none");

    const stored = await call("POST", "/runs", token, { repository: s.repo.fullName, outcome: "refused", refusal: "dirty_tree", tree: TREE, commit: COMMIT });

    expect(stored).toEqual({ status: 403, body: { error: "no_write_access" } });
  });

  test("is upload only: it can't read runs back or revoke itself", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.creator, repo: s.repo });
    const stored = await upload(token, s.repo);
    const runId = (stored.body.run as { id: string }).id;

    expect((await call("GET", `/runs/${runId}`, token)).status).toBe(401);
    expect((await call("DELETE", "/tokens/current", token)).status).toBe(401);
    expect((await preflight(token, s.repo)).status).toBe(200);
  });

  test("lasts 90 days from creation by default, and using it never renews it", async () => {
    const s = await scene();
    try {
      world.clock.set(new Date("2026-11-15T12:00:00.000Z"));
      const token = await world.sandboxToken({ creator: s.creator, repo: s.repo });

      world.clock.advance(80 * DAY_MS);
      const day80 = await preflight(token, s.repo);
      world.clock.advance(10 * DAY_MS - 60_000);
      const lastMinute = await preflight(token, s.repo);
      const whoami = await call("GET", "/whoami", token);
      world.clock.advance(60_000);
      const day90 = await preflight(token, s.repo);

      expect(day80.status).toBe(200);
      expect(lastMinute.status).toBe(200);
      expect(whoami).toMatchObject({ status: 200, body: { token: { kind: "sandbox", expiresAt: "2027-02-13T12:00:00.000Z" } } });
      expect(day90).toEqual({ status: 401, body: { error: "token_rejected" } });
    } finally {
      world.clock.reset();
    }
  });

  test("lasts as many days as its creator chose, up to a year", async () => {
    const s = await scene();
    try {
      world.clock.set(new Date("2026-11-15T12:00:00.000Z"));
      const token = await world.sandboxToken({ creator: s.creator, repo: s.repo, days: 365 });

      const whoami = await call("GET", "/whoami", token);
      world.clock.advance(364 * DAY_MS);
      const before = await preflight(token, s.repo);
      world.clock.advance(DAY_MS);
      const after = await preflight(token, s.repo);

      expect(whoami).toMatchObject({ status: 200, body: { token: { expiresAt: "2027-11-15T12:00:00.000Z" } } });
      expect(before.status).toBe(200);
      expect(after.status).toBe(401);
      await expect(world.sandboxToken({ creator: s.creator, repo: s.repo, days: 366 })).rejects.toThrow();
    } finally {
      world.clock.reset();
    }
  });

  test("is revoked when its repo leaves the installation, and stays revoked if the repo comes back", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.creator, repo: s.repo });
    const otherToken = await world.sandboxToken({ creator: s.creator, repo: s.other });

    await world.github.removeInstallationRepos(s.installation, [s.repo]);
    await world.github.addInstallationRepos(s.installation, [s.repo]);

    expect(await preflight(token, s.repo)).toEqual({ status: 401, body: { error: "token_rejected" } });
    expect((await preflight(otherToken, s.other)).status).toBe(200);
  });

  test("is revoked when the App is uninstalled", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.creator, repo: s.repo });

    await world.github.uninstallApp(s.installation);
    const { installation } = await world.github.installApp({ account: s.installation.account, repos: [s.repo] });

    expect(installation.repoIds.has(s.repo.id)).toBe(true);
    expect(await preflight(token, s.repo)).toEqual({ status: 401, body: { error: "token_rejected" } });
  });

  test("is stored only as a hash: its value is in no table", async () => {
    const s = await scene();
    const token = await world.sandboxToken({ creator: s.creator, repo: s.repo });
    await upload(token, s.repo);

    const dump = await world.db.dump();

    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(4));
  });
});
