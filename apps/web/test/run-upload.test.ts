import { describe, expect, test } from "vitest";
import type { FakeRepo } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// The run upload's own rules, through the API as any client meets them. The library's side of the
// same story is in packages/testnotary/test/run.test.ts.

const world = useWorld();

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT = "a".repeat(40);
let n = 0;

interface Uploader {
  repo: FakeRepo;
  token: string;
  /** What the preflight said about the token: its id and its account's id. */
  seen: { account: { id: number }; token: { id: string; kind: string }; repository: { id: number; fullName: string } };
  post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** An installed repo and a signed-in account with write access, past its preflight. */
async function uploader(): Promise<Uploader> {
  const i = ++n;
  const fixture = await world.fixtureRepo();
  const repo = await world.hostOnGitHub(fixture, { owner: `org-${i}`, name: "app" });
  await world.github.installApp({ account: { login: `org-${i}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `writer-${i}` });
  world.github.setPermission(repo, user, "write");
  const machine = await world.machine();
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  const token = (await machine.keychain())[0]!.secret;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${world.service.url}/api/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const preflight = await post("/preflight", { repository: repo.fullName });
  expect(preflight.status).toBe(200);
  return { repo, token, seen: preflight.body as unknown as Uploader["seen"], post };
}

/** A passed run's upload with its canonical payload (written out here in the v1 key order). */
function passedRun(u: Uploader, overrides: { payload?: Record<string, unknown>; record?: Record<string, unknown>; payloadText?: string } = {}) {
  const endedAt = new Date(world.clock.now().getTime() - 1_000).toISOString();
  const payload = {
    format: "testnotary.attestation/v1",
    repository: u.seen.repository.id,
    suite: "test",
    command: ["npm", "test"],
    tree: TREE,
    commit: COMMIT,
    outcome: "passed",
    attester: { account: u.seen.account.id, token: u.seen.token.id, tokenKind: "laptop" },
    endedAt,
    ...overrides.payload,
  };
  return {
    repository: u.repo.fullName,
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
    session: null,
    passedEnv: [],
    guardedMatched: [],
    warnings: [],
    notPinned: [],
    baselineOverrides: [],
    attestation: { payload: overrides.payloadText ?? JSON.stringify(payload) },
    ...overrides.record,
  };
}

describe("the run upload", () => {
  test("stores a pass and its attestation", async () => {
    const u = await uploader();

    const stored = await u.post("/runs", passedRun(u));

    expect(stored.status).toBe(201);
    expect(stored.body).toEqual({ run: { id: expect.any(String) as string }, attestation: { id: expect.any(String) as string } });
  });

  test("refuses a filled report field", async () => {
    const u = await uploader();

    const withReport = await u.post("/runs", passedRun(u, { record: { report: { tests: [{ name: "adds", passed: true }] } } }));
    const refusedWithReport = await u.post("/runs", { repository: u.repo.fullName, outcome: "refused", refusal: "dirty_tree", tree: TREE, commit: COMMIT, report: [] });

    expect(withReport).toMatchObject({ status: 400, body: { error: "report_not_supported" } });
    expect(refusedWithReport).toMatchObject({ status: 400, body: { error: "report_not_supported" } });
  });

  test("refuses a field the record doesn't have, such as a log", async () => {
    const u = await uploader();

    const withLog = await u.post("/runs", passedRun(u, { record: { log: "ok 1 - adds\n" } }));
    const refusedWithMore = await u.post("/runs", { repository: u.repo.fullName, outcome: "refused", refusal: "dirty_tree", tree: TREE, commit: COMMIT, suite: "test" });

    expect(withLog.status).toBe(400);
    expect(refusedWithMore.status).toBe(400);
  });

  test("checks the account's write access again at upload", async () => {
    const u = await uploader();
    const user = world.github.state.accountById(u.seen.account.id)!;
    world.github.setPermission(u.repo, user, "read");

    const stored = await u.post("/runs", passedRun(u));

    expect(stored).toEqual({ status: 403, body: { error: "no_write_access" } });
  });

  test("rejects a payload that isn't canonical", async () => {
    const u = await uploader();
    const canonical = (passedRun(u).attestation as { payload: string }).payload;
    const pretty = JSON.stringify(JSON.parse(canonical), null, 2);
    const { format, ...rest } = JSON.parse(canonical) as Record<string, unknown>;
    const reordered = JSON.stringify({ ...rest, format });

    for (const payloadText of [pretty, reordered, `${canonical}\n`]) {
      const stored = await u.post("/runs", passedRun(u, { payloadText }));
      expect(stored).toMatchObject({ status: 400, body: { error: "attestation_invalid" } });
    }
  });

  test.each([
    ["another tree", { tree: "b".repeat(40) }],
    ["another repo", { repository: 1 }],
    ["another account", { attester: { account: 1, token: "x", tokenKind: "laptop" } }],
    ["another command", { command: ["npm", "run", "test:changed"] }],
    ["another end time", { endedAt: "2020-01-01T00:00:00.000Z" }],
  ])("rejects a payload that names %s than the run", async (_, payload) => {
    const u = await uploader();

    const stored = await u.post("/runs", passedRun(u, { payload }));

    expect(stored).toMatchObject({ status: 400, body: { error: "attestation_invalid" } });
  });

  test("a pass needs its payload, and a failure has none", async () => {
    const u = await uploader();

    const passWithout = await u.post("/runs", passedRun(u, { record: { attestation: undefined } }));
    const failWith = await u.post("/runs", passedRun(u, { record: { outcome: "failed", exitCode: 1 } }));

    expect(passWithout.status).toBe(400);
    expect(failWith.status).toBe(400);
  });

  test("a run that ends more than 5 minutes ahead of the service clock is rejected", async () => {
    const u = await uploader();
    try {
      world.clock.set(new Date("2026-11-15T12:00:00.000Z"));
      const ahead = (minutes: number) => {
        const endedAt = new Date(Date.parse("2026-11-15T12:00:00.000Z") + minutes * 60_000).toISOString();
        return passedRun(u, { record: { endedAt, startedAt: endedAt }, payload: { endedAt } });
      };

      const slightly = await u.post("/runs", ahead(4));
      const far = await u.post("/runs", ahead(6));

      expect(slightly.status).toBe(201);
      expect(far).toMatchObject({ status: 400, body: { error: "bad_request" } });
    } finally {
      world.clock.reset();
    }
  });

  test("another account can't read a run", async () => {
    const owner = await uploader();
    const stranger = await uploader();
    const stored = await owner.post("/runs", passedRun(owner));
    const id = (stored.body.run as { id: string }).id;

    const read = (token: string) => fetch(`${world.service.url}/api/v1/runs/${id}`, { headers: { authorization: `Bearer ${token}` } });

    expect((await read(owner.token)).status).toBe(200);
    expect((await read(stranger.token)).status).toBe(404);
  });
});
