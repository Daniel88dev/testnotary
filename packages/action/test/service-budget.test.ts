import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installLibrary, type ActionResult, type FakeRepo, type FixtureRepo, type RunActionOptions, type ServiceRequest } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// Every verification call has 10 s in all, the token fetch included. A connection error, a 5xx or
// a 429 gets one retry after 1 s; anything else falls back at once. The time here is the world
// clock's: it stands still, a slow service is an override that moves it, and the action's own
// pause moves it too (see WorldClock), so no test waits seconds in real time.

const world = useWorld();

const MARKED = { suites: { test: { command: ["node", "-e", "require('fs').writeFileSync('ran.txt', 'x')"] } } };
const VERIFY = "/api/v1/verifications";

let scenes = 0;

interface Scene {
  fixture: FixtureRepo;
  repo: FakeRepo;
  /** The action in run mode on the pull request's test merge commit. */
  ci(options?: Partial<RunActionOptions>): Promise<ActionResult>;
}

/** An installed repo with a pull request nobody attested (so the service answers `no_attestation`). */
async function scene(): Promise<Scene> {
  const n = ++scenes;
  const fixture = await world.fixtureRepo({
    config: MARKED,
    files: { "package.json": '{ "name": "budget", "private": true, "packageManager": "pnpm@10.34.9" }\n', ".gitignore": "node_modules\nran.txt\n" },
  });
  const repo = await world.hostOnGitHub(fixture, { owner: `budget-${n}`, name: "budget" });
  await world.github.installApp({ account: { login: `budget-${n}`, type: "Organization" }, repos: [repo] });
  await fixture.branch("feature");
  await fixture.commit("Add a", { "src/a.js": "export const a = 1;\n" });
  await fixture.push();
  return {
    fixture,
    repo,
    async ci(options = {}) {
      const merge = await fixture.testMerge({ base: "main", head: "feature" });
      const workspace = await fixture.ciCheckout(merge.sha);
      await installLibrary(workspace);
      return world.runAction({ repo, sha: merge.sha, workspace, inputs: { suite: "test" }, ...options });
    },
  };
}

/** Answers the first `count` verification calls with `answer`; the service answers the rest. */
function failFirst(count: number, answer: (request: Request) => Response | "drop" | Promise<Response | "drop">): () => void {
  let calls = 0;
  return world.service.override("POST", VERIFY, (request) => (++calls <= count ? answer(request) : undefined));
}

function verifyCalls(from: number): ServiceRequest[] {
  return world.service.requests.slice(from).filter((request) => request.method === "POST" && request.path === VERIFY);
}

function tokenFetches(from: number): number {
  return world.github.requestsTo("GET", "/oidc/_request").length - from;
}

const jti = (request: ServiceRequest) => JSON.parse(Buffer.from(request.headers.authorization!.split(".")[1]!, "base64url").toString()).jti as string;

let undo: (() => void) | undefined;

beforeEach(() => {
  world.clock.set(new Date());
});

afterEach(() => {
  undo?.();
  undo = undefined;
  world.clock.reset();
});

describe("one retry after 1 s", () => {
  test.each([500, 502, 503, 429])("a %i is retried once, 1 s later, and the second answer counts", async (status) => {
    const s = await scene();
    undo = failFirst(1, () => Response.json({ error: "busy" }, { status }));
    const from = world.service.requests.length;
    const started = Date.now();

    const result = await s.ci();

    const calls = verifyCalls(from);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.clockAt - calls[0]!.clockAt).toBe(1_000);
    expect(result.outputs).toMatchObject({ result: "would_fall_back", reason: "no_attestation", ran: "true" });
    // The pause moved the world clock; it took no second of real time.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a second 5xx falls back with service_error, after two calls and no third", async () => {
    const s = await scene();
    undo = failFirst(5, () => Response.json({ error: "internal" }, { status: 503 }));
    const from = world.service.requests.length;

    const result = await s.ci();

    expect(verifyCalls(from)).toHaveLength(2);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "service_error", ran: "true" });
  });

  test.each([400, 403, 409, 422])("a %i falls back at once with service_error: no retry", async (status) => {
    const s = await scene();
    undo = failFirst(5, () => Response.json({ error: "nope" }, { status }));
    const from = world.service.requests.length;

    const result = await s.ci();

    expect(verifyCalls(from)).toHaveLength(1);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "service_error", ran: "true" });
  });

  test("a dropped connection is retried, and two are service_unreachable", async () => {
    const s = await scene();
    undo = failFirst(5, () => "drop");
    const from = world.service.requests.length;

    const result = await s.ci();

    expect(verifyCalls(from)).toHaveLength(2);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "service_unreachable", ran: "true" });
  });

  test("a service that refuses connections is service_unreachable after one retry", async () => {
    const s = await scene();

    const result = await s.ci({ env: { TESTNOTARY_URL: "http://127.0.0.1:9" } });

    expect(result.outputs).toMatchObject({ result: "fallback", reason: "service_unreachable", ran: "true" });
    expect(result.stdout).not.toMatch(/::error::/);
  });
});

describe("the OIDC token on a retry", () => {
  test("after a dropped connection the token is sent again: it has over 60 s left", async () => {
    const s = await scene();
    undo = failFirst(1, () => "drop");
    const from = world.service.requests.length;
    const tokens = world.github.requestsTo("GET", "/oidc/_request").length;

    // A gate job: no job report, whose call would fetch a token of its own.
    const result = await s.ci({ inputs: { suite: "test", mode: "verify" } });

    const calls = verifyCalls(from);
    expect(calls).toHaveLength(2);
    expect(tokenFetches(tokens)).toBe(1);
    expect(jti(calls[1]!)).toBe(jti(calls[0]!));
    expect(result.outputs).toMatchObject({ reason: "no_attestation" });
  });

  test("a token with under 60 s left is refreshed for the retry", async () => {
    const s = await scene();
    undo = failFirst(1, () => "drop");
    const from = world.service.requests.length;
    const tokens = world.github.requestsTo("GET", "/oidc/_request").length;

    const result = await s.ci({ oidcLifetimeSeconds: 50, inputs: { suite: "test", mode: "verify" } });

    const calls = verifyCalls(from);
    expect(tokenFetches(tokens)).toBe(2);
    expect(jti(calls[1]!)).not.toBe(jti(calls[0]!));
    expect(result.outputs).toMatchObject({ reason: "no_attestation" });
  });

  test("after an answer, the retry carries a fresh token: the service may have spent the first one's jti", async () => {
    const s = await scene();
    undo = failFirst(1, () => Response.json({ error: "busy" }, { status: 503 }));
    const from = world.service.requests.length;

    const result = await s.ci();

    const calls = verifyCalls(from);
    expect(jti(calls[1]!)).not.toBe(jti(calls[0]!));
    expect(result.outputs).toMatchObject({ reason: "no_attestation" });
  });
});

describe("the 10 s budget", () => {
  test("a service that never answers is a timeout, given up at 10 s", async () => {
    const s = await scene();
    let hungUp: Date | undefined;
    undo = world.service.override("POST", VERIFY, async (request) => {
      hungUp = await world.service.stall(request, { stepMs: 250 });
      return "drop" as const;
    });
    const from = world.service.requests.length;
    const started = Date.now();

    const result = await s.ci();

    const [call, ...more] = verifyCalls(from);
    expect(more).toEqual([]);
    expect(hungUp!.getTime() - call!.clockAt).toBeGreaterThanOrEqual(9_000);
    expect(hungUp!.getTime() - call!.clockAt).toBeLessThanOrEqual(10_250);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "timeout", ran: "true" });
    expect(result.summary).toContain("Fell back: timeout, the service did not answer within 10 s");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a 503 after 9.5 s leaves no time for the retry: service_error, with one call", async () => {
    const s = await scene();
    undo = failFirst(5, () => {
      world.clock.advance(9_500);
      return Response.json({ error: "busy" }, { status: 503 });
    });
    const from = world.service.requests.length;

    const result = await s.ci();

    expect(verifyCalls(from)).toHaveLength(1);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "service_error" });
  });

  test("the retry gets what is left of the 10 s, not 10 s of its own", async () => {
    const s = await scene();
    let hungUp: Date | undefined;
    let calls = 0;
    undo = world.service.override("POST", VERIFY, async (request) => {
      if (++calls === 1) {
        world.clock.advance(3_000);
        return Response.json({ error: "busy" }, { status: 503 });
      }
      hungUp = await world.service.stall(request, { stepMs: 250 });
      return "drop" as const;
    });
    const from = world.service.requests.length;

    const result = await s.ci();

    const [first, second] = verifyCalls(from);
    expect(second!.clockAt - first!.clockAt).toBe(3_000 + 1_000);
    // Started at first.clockAt, so the budget ends 10 s after it, not 10 s after the retry.
    expect(hungUp!.getTime() - first!.clockAt).toBeLessThanOrEqual(10_250);
    expect(result.outputs).toMatchObject({ result: "fallback", reason: "timeout" });
  });
});
