import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine, ProcessResult } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// `run` and `login` in a cloud agent sandbox: the sandbox markers, sandbox tokens, the request a
// vendor proxy can add a token to, and the agent session labels.

const world = useWorld();

interface Developer {
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  user: FakeAccount;
  /** Whether the suite's command started. */
  started(): boolean;
  /** `testnotary run --json <args>` in the fixture repo, on the developer's machine. */
  run(env?: Record<string, string | undefined>, options?: { rootFiles?: string[] }): Promise<ProcessResult>;
  /** The laptop token `login` left in the machine's keychain. */
  laptopToken(): Promise<string>;
}

let repos = 0;

/** An installed repo, and a developer with write access signed in on their laptop. */
async function developer(options: { exitCode?: number } = {}): Promise<Developer> {
  const n = ++repos;
  const machine = await world.machine();
  const mark = join(machine.home, `started-${n}`);
  const config = {
    suites: { test: { command: ["node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(mark)}, ""); process.exit(${options.exitCode ?? 0})`] } },
  };
  const fixture = await world.fixtureRepo({ config });
  const repo = await world.hostOnGitHub(fixture, { owner: `sandbox-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `sandbox-${n}`, type: "Organization" }, repos: [repo] });
  const user = world.github.addUser({ login: `agent-owner-${n}` });
  world.github.setPermission(repo, user, "write");
  world.github.deviceFlow.approveNext(user);
  expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  return {
    fixture,
    repo,
    machine,
    user,
    started: () => existsSync(mark),
    run: (env, runOptions) => world.runCli(["run", "--json"], { cwd: fixture.dir, machine, env, rootFiles: runOptions?.rootFiles }),
    async laptopToken() {
      const [entry] = await machine.keychain();
      return entry!.secret;
    },
  };
}

/** Every request a run sent to the service, from request number `from` on. */
function requestsSince(from: number) {
  return world.service.requests.slice(from).filter((request) => request.path.startsWith("/api/v1/"));
}

/** Each sandbox marker, as the environment (and files) a sandbox shows. */
const MARKERS: { marker: string; env?: Record<string, string>; rootFiles?: string[] }[] = [
  { marker: "CLAUDE_CODE_REMOTE", env: { CLAUDE_CODE_REMOTE: "true" } },
  { marker: "CURSOR_AGENT_SOCKET", env: { CURSOR_AGENT_SOCKET: "/tmp/cursor-agent.sock" } },
  { marker: "GITHUB_ACTIONS", env: { GITHUB_ACTIONS: "true" } },
  { marker: "/opt/.devin", rootFiles: ["/opt/.devin"] },
  { marker: "HOME=/home/jules", env: { HOME: "/home/jules", USER: "swebot" } },
  { marker: "TESTNOTARY_SANDBOX", env: { TESTNOTARY_SANDBOX: "1" } },
];

describe("a sandbox token", () => {
  test("in a sandbox, TESTNOTARY_TOKEN holding a sandbox token attests as its creator, sent as Bearer exactly as it is", async () => {
    const dev = await developer();
    const token = await world.sandboxToken({ creator: dev.user, repo: dev.repo, name: "codex-cloud" });
    expect(token).toMatch(/^tns_/);
    const mark = world.service.requests.length;

    const result = await dev.run({ TESTNOTARY_SANDBOX: "1", TESTNOTARY_TOKEN: token });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true });
    expect(result.stderr).toMatch(new RegExp(`^testnotary: attesting as @${dev.user.login} with sandbox token "codex-cloud"$`, "m"));
    const sent = requestsSince(mark);
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /api/v1/preflight", "POST /api/v1/runs"]);
    for (const request of sent) expect(request.headers.authorization).toBe(`Bearer ${token}`);
  });
});

/** The `session` the run's upload carried. */
function uploadedSession(from: number): unknown {
  const uploads = requestsSince(from).filter((request) => request.method === "POST" && request.path === "/api/v1/runs");
  expect(uploads).toHaveLength(1);
  return (JSON.parse(uploads[0]!.text) as { session: unknown }).session;
}

const AGENTS: { agent: string; env: Record<string, string>; session: { vendor: string; id: string | null; url: string | null } | null }[] = [
  { agent: "none", env: {}, session: null },
  {
    agent: "Claude Code on the web",
    env: { CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: "session_01AbCdEf", CLAUDE_CODE_SESSION_ID: "local-1" },
    session: { vendor: "Claude Code", id: "session_01AbCdEf", url: "https://claude.ai/code/session_01AbCdEf" },
  },
  { agent: "Claude Code on a laptop", env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "6f1c2b9e" }, session: { vendor: "Claude Code", id: "6f1c2b9e", url: null } },
  { agent: "Codex cloud", env: { CODEX_CI: "1", CODEX_THREAD_ID: "thr_6f2e91ac" }, session: { vendor: "Codex", id: "thr_6f2e91ac", url: null } },
  { agent: "Codex with a session id", env: { CODEX_CI: "1", CODEX_SESSION_ID: "sess-42" }, session: { vendor: "Codex", id: "sess-42", url: null } },
  // Any of Codex's three variables names it (spec: `CODEX_CI`, `CODEX_THREAD_ID`/`CODEX_SESSION_ID`).
  { agent: "a Codex session id alone", env: { CODEX_SESSION_ID: "sess-42" }, session: { vendor: "Codex", id: "sess-42", url: null } },
  { agent: "a Codex thread id alone", env: { CODEX_THREAD_ID: "thr_9" }, session: { vendor: "Codex", id: "thr_9", url: null } },
  {
    agent: "Copilot cloud agent",
    env: { GITHUB_ACTIONS: "true", COPILOT_AGENT_SESSION_ID: "cps-7" },
    session: { vendor: "Copilot", id: "cps-7", url: null },
  },
  { agent: "a plain Actions job", env: { GITHUB_ACTIONS: "true" }, session: null },
  { agent: "Cursor background agent", env: { CURSOR_AGENT_SOCKET: "/tmp/cursor.sock" }, session: { vendor: "Cursor", id: null, url: null } },
  { agent: "Cursor's CLI", env: { CURSOR_AGENT: "1" }, session: { vendor: "Cursor", id: null, url: null } },
  { agent: "Gemini CLI", env: { GEMINI_CLI: "1" }, session: { vendor: "Gemini CLI", id: null, url: null } },
  { agent: "AI_AGENT", env: { AI_AGENT: "devin" }, session: { vendor: "devin", id: null, url: null } },
  {
    agent: "the overrides, over a detected vendor",
    env: {
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_CODE_REMOTE_SESSION_ID: "session_01AbCdEf",
      TESTNOTARY_SESSION_VENDOR: "Acme agent",
      TESTNOTARY_SESSION_ID: "run-9",
      TESTNOTARY_SESSION_URL: "https://agents.example/run-9",
    },
    session: { vendor: "Acme agent", id: "run-9", url: "https://agents.example/run-9" },
  },
  {
    agent: "one override, the rest detected",
    env: { CODEX_CI: "1", CODEX_THREAD_ID: "thr_1", TESTNOTARY_SESSION_URL: "https://chatgpt.example/codex/tasks/1" },
    session: { vendor: "Codex", id: "thr_1", url: "https://chatgpt.example/codex/tasks/1" },
  },
  {
    agent: "the overrides alone",
    env: { TESTNOTARY_SESSION_VENDOR: "in-house runner", TESTNOTARY_SESSION_ID: "job-3" },
    session: { vendor: "in-house runner", id: "job-3", url: null },
  },
];

describe("agent session labels", () => {
  test.each(AGENTS)("$agent: the run uploads the session the environment names", async ({ env, session }) => {
    const dev = await developer();
    const token = await world.sandboxToken({ creator: dev.user, repo: dev.repo });
    const mark = world.service.requests.length;

    const result = await dev.run({ ...env, TESTNOTARY_TOKEN: token });

    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true });
    expect(uploadedSession(mark)).toEqual(session);
  });

  test("a failed run on a laptop carries the labels too", async () => {
    const dev = await developer({ exitCode: 1 });
    const mark = world.service.requests.length;

    const result = await dev.run({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" });

    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", attested: false });
    expect(uploadedSession(mark)).toEqual({ vendor: "Claude Code", id: "abc", url: null });
  });
});

describe("a laptop token inside a sandbox", () => {
  test.each(MARKERS)("$marker: TESTNOTARY_TOKEN holding a tnl_ token refuses laptop_token_in_sandbox before the start", async ({ env, rootFiles }) => {
    const dev = await developer();
    const laptop = await dev.laptopToken();
    const mark = world.service.requests.length;

    const result = await dev.run({ ...env, TESTNOTARY_TOKEN: laptop }, { rootFiles });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused", refusal: "laptop_token_in_sandbox", attested: false });
    expect(result.stderr).toMatch(/^testnotary: .*laptop token.*sandbox token/m);
    expect(dev.started()).toBe(false);
    // The person's laptop token never leaves the sandbox: no preflight, no refused-run upload.
    expect(requestsSince(mark)).toEqual([]);
  });

  test.each(MARKERS)("$marker: login is refused", async ({ marker, env, rootFiles }) => {
    const machine = await world.machine();

    const result = await world.runCli(["login", "--json"], { cwd: machine.home, machine, env, rootFiles });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "login_in_sandbox", marker });
  });

  test.each(MARKERS)("$marker: the laptop token in the keychain is not used, and no Authorization header is sent", async ({ env, rootFiles }) => {
    const dev = await developer();
    const mark = world.service.requests.length;

    const result = await dev.run(env, { rootFiles });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: false, warnings: ["not_signed_in"] });
    expect(dev.started()).toBe(true);
    const sent = requestsSince(mark);
    expect(sent.map((request) => request.path)).toEqual(["/api/v1/preflight"]);
    expect(sent[0]!.headers).not.toHaveProperty("authorization");
  });

  test("outside a sandbox the same TESTNOTARY_TOKEN attests", async () => {
    const dev = await developer();

    const result = await dev.run({ TESTNOTARY_TOKEN: await dev.laptopToken() });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true });
  });
});
