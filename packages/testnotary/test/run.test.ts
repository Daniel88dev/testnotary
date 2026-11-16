import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine, ProcessResult } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };
const FAILING = { suites: { test: { command: ["node", "-e", "process.exit(3)"] } } };

interface Developer {
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  user: FakeAccount;
  /** `testnotary run <args>` in the fixture repo, on the developer's machine. */
  run(args?: string[], env?: Record<string, string | undefined>): Promise<ProcessResult>;
  /** The laptop token `login` left in the machine's keychain. */
  token(): Promise<string>;
}

let repos = 0;

/**
 * A repo on the fake GitHub with the App installed, and a developer with write access signed in on
 * their laptop: the starting point of every attested run.
 */
async function developer(
  options: { config?: Record<string, unknown> | null; files?: Record<string, string>; permission?: "admin" | "write" | "read"; signedIn?: boolean } = {},
): Promise<Developer> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: options.config === undefined ? PASSING : options.config, files: options.files });
  const repo = await world.hostOnGitHub(fixture, { owner: `acme-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `acme-${n}`, type: "Organization" }, repos: [repo] });
  const machine = await world.machine();
  const user = world.github.addUser({ login: `dev-${n}` });
  world.github.setPermission(repo, user, options.permission ?? "write");
  if (options.signedIn !== false) {
    world.github.deviceFlow.approveNext(user);
    const login = await world.runCli(["login"], { cwd: machine.home, machine });
    expect(login.exitCode).toBe(0);
  }
  return {
    fixture,
    repo,
    machine,
    user,
    run: (args = [], env) => world.runCli(["run", ...args], { cwd: fixture.dir, machine, env }),
    async token() {
      const [entry] = await machine.keychain();
      return entry!.secret;
    },
  };
}

/** The fixed summary line: the last line on stderr. */
function summary(result: ProcessResult): Record<string, string> {
  const last = result.stderr.trimEnd().split("\n").at(-1)!;
  expect(last).toMatch(/^outcome=\S* suite=\S* attested=\S* tree=\S* commit=\S* url=\S*$/);
  return Object.fromEntries(last.split(" ").map((pair) => pair.split("=", 2) as [string, string]));
}

async function storedRun(token: string, url: string) {
  const id = url.split("/").at(-1)!;
  const response = await fetch(`${world.service.url}/api/v1/runs/${id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    run: Record<string, unknown>;
    attestation: { id: string; format: string; payload: string } | null;
  };
}

/**
 * A suite whose command leaves a file behind (outside the repo) when it starts, to tell whether a
 * run got as far as starting it. `exitCode` is what the command then exits with.
 */
async function markedSuite(exitCode = 0) {
  const machine = await world.machine();
  const path = join(machine.home, `started-${++repos}`);
  const config = { suites: { test: { command: ["node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(path)}, ""); process.exit(${exitCode})`] } } };
  return { config, started: () => existsSync(path) };
}

/** The bodies `run` sent to the service's run upload, from request number `from` on. */
function uploadsSince(from: number): Record<string, unknown>[] {
  return world.service.requests
    .slice(from)
    .filter((request) => request.method === "POST" && request.path === "/api/v1/runs")
    .map((request) => JSON.parse(request.text) as Record<string, unknown>);
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("testnotary run attests a pass", () => {
  test("a signed-in developer's passing run in a clean repo attests the head tree", async () => {
    const dev = await developer();

    const result = await dev.run();

    expect(result.exitCode).toBe(0);
    const tree = await dev.fixture.tree();
    const commit = await dev.fixture.revParse("HEAD");
    const line = summary(result);
    expect(line).toMatchObject({ outcome: "passed", suite: "test", attested: "true", tree, commit });
    expect(line.url).toMatch(new RegExp(`^${escaped(world.service.url)}/${dev.repo.owner}/widgets/runs/[0-9a-f-]{36}$`));
    const stored = await storedRun(await dev.token(), line.url!);
    expect(stored.run).toMatchObject({ outcome: "passed", suite: "test", tree, commit, command: PASSING.suites.test.command, exitCode: 0 });
    expect(stored.attestation).not.toBeNull();
  });

  test("--json reports the attestation and its run page", async () => {
    const dev = await developer();

    const result = await dev.run(["--json"]);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(out).toEqual({
      outcome: "passed",
      refusal: null,
      exitCode: 0,
      attested: true,
      attestationUrl: summary(result).url,
      tree: await dev.fixture.tree(),
      commit: await dev.fixture.revParse("HEAD"),
      durationMs: expect.any(Number) as number,
      warnings: [],
    });
  });

  test("the preflight names the account and the token the service saw", async () => {
    const dev = await developer();

    const result = await dev.run();

    expect(result.stderr).toMatch(new RegExp(`^testnotary: attesting as @${dev.user.login} with laptop token "[^"]+"$`, "m"));
  });

  test("an unpushed commit is fine: the attestation names the local head's tree", async () => {
    const dev = await developer();
    await dev.fixture.commit("Local work", { "src/feature.js": "export const answer = 42;\n" });

    const result = await dev.run();

    expect(result.exitCode).toBe(0);
    expect(summary(result)).toMatchObject({ attested: "true", tree: await dev.fixture.tree(), commit: await dev.fixture.revParse("HEAD") });
  });

  test("the suite may be left out only when the config declares exactly one", async () => {
    const two = await developer({ config: { suites: { unit: PASSING.suites.test, e2e: PASSING.suites.test } } });

    const unnamed = await two.run();
    const named = await two.run(["e2e"]);
    const undeclared = await two.run(["lint", "--json"]);

    expect(unnamed.exitCode).toBe(64);
    expect(unnamed.stderr).toContain("unit, e2e");
    expect(named.exitCode).toBe(0);
    expect(summary(named)).toMatchObject({ suite: "e2e", attested: "true" });
    expect(undeclared.exitCode).toBe(2);
    expect(JSON.parse(undeclared.stdout)).toMatchObject({ outcome: "refused", refusal: "config_invalid" });
  });
});

describe("what a run uploads", () => {
  test("a failing run is uploaded with outcome failed and no attestation", async () => {
    const dev = await developer({ config: FAILING });
    const mark = world.service.requests.length;

    const result = await dev.run(["--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", exitCode: 3, attested: false, attestationUrl: null });
    expect(summary(result)).toMatchObject({ outcome: "failed", attested: "false", url: "" });
    const [upload] = uploadsSince(mark);
    expect(upload).toMatchObject({ outcome: "failed", exitCode: 3, suite: "test", tree: await dev.fixture.tree() });
    expect(upload).not.toHaveProperty("attestation");
  });

  test("nothing on the never-sent list leaves the machine: log, file lists, env values, hostname, username, local paths", async () => {
    const LOG = "log-line-7f3a9c";
    const VALUE = "secret-value-41d2e8";
    const USERNAME = "maria-local-5b1c";
    const FILE = "src/only-on-this-machine-93ac.js";
    const config = { env: { pass: ["DATABASE_PASSWORD"] }, suites: { test: { command: ["node", "print.js"] } } };
    // The test prints the log line without spelling it out in the command or a file name.
    const print = `const line = ["log", "line", "7f3a9c"].join("-"); console.log(line); console.error(line);\n`;
    const dev = await developer({ config, files: { "print.js": print, [FILE]: "export {};\n", ".gitignore": ".env.local\n" } });
    await dev.fixture.write({ ".env.local": `DATABASE_PASSWORD=${VALUE}\n` });
    const mark = world.service.requests.length;

    const result = await dev.run([], { DATABASE_PASSWORD: VALUE, USER: USERNAME, LOGNAME: USERNAME });

    expect(result.exitCode).toBe(0);
    expect(summary(result).attested).toBe("true");
    expect(result.stdout + result.stderr).toContain(LOG);
    const sent = world.service.requests.slice(mark);
    expect(sent.map((request) => request.path)).toEqual(["/api/v1/preflight", "/api/v1/runs"]);
    const everything = JSON.stringify(sent.map((request) => ({ headers: request.headers, body: request.text })));
    const never = [LOG, VALUE, USERNAME, "only-on-this-machine", ".env.local", dev.fixture.dir, dev.fixture.remoteDir, dev.machine.home, tmpdir()];
    if (hostname().length >= 4) never.push(hostname());
    for (const text of never) expect(everything).not.toContain(text);
    const [upload] = uploadsSince(mark);
    // Names of passed variables are recorded; their values never are.
    expect(upload!.passedEnv).toEqual(["DATABASE_PASSWORD"]);
    expect(Object.keys(upload!).sort()).toEqual(
      [
        "attestation",
        "baselineOverrides",
        "command",
        "commit",
        "durationMs",
        "endedAt",
        "environment",
        "exitCode",
        "guardedMatched",
        "notPinned",
        "outcome",
        "passedEnv",
        "repository",
        "session",
        "startedAt",
        "suite",
        "tree",
        "warnings",
      ].sort(),
    );
    expect(Object.keys(upload!.environment as object).sort()).toEqual(["arch", "locale", "node", "os", "osVersion", "packageManager", "tz"]);
  });

  test("the stored attestation keeps the canonical payload's bytes exactly as uploaded", async () => {
    const command = ["node", "-e", "process.exit(0)", "žluťoučký kůň 🐎"];
    const dev = await developer({ config: { suites: { unit: { command } } } });
    const mark = world.service.requests.length;

    const result = await dev.run();

    expect(summary(result).attested).toBe("true");
    const [upload] = uploadsSince(mark);
    const sent = (upload!.attestation as { payload: string }).payload;
    const stored = await storedRun(await dev.token(), summary(result).url!);
    expect(stored.attestation!.format).toBe("testnotary.attestation/v1");
    expect(Buffer.from(stored.attestation!.payload, "utf8").equals(Buffer.from(sent, "utf8"))).toBe(true);
    // Canonical v1: fixed key order, no whitespace, ASCII only (the label's letters as \u escapes).
    expect(sent).toBe(
      JSON.stringify({
        format: "testnotary.attestation/v1",
        repository: dev.repo.id,
        suite: "unit",
        command,
        tree: await dev.fixture.tree(),
        commit: await dev.fixture.revParse("HEAD"),
        outcome: "passed",
        attester: { account: dev.user.id, token: (stored.run.token as { id: string }).id, tokenKind: "laptop" },
        endedAt: upload!.endedAt,
      }).replace("žluťoučký kůň 🐎", "\\u017elu\\u0165ou\\u010dk\\u00fd k\\u016f\\u0148 \\ud83d\\udc0e"),
    );
    expect(/^[\x20-\x7e]*$/.test(sent)).toBe(true);
  });

  test("a refused run uploads only its refusal code, tree and commit", async () => {
    const dev = await developer();
    await dev.fixture.write({ "notes.txt": "not committed\n" });
    const mark = world.service.requests.length;

    const result = await dev.run();

    expect(result.exitCode).toBe(2);
    expect(uploadsSince(mark)).toEqual([
      {
        repository: dev.repo.fullName,
        outcome: "refused",
        refusal: "dirty_tree",
        tree: await dev.fixture.tree(),
        commit: await dev.fixture.revParse("HEAD"),
      },
    ]);
  });

  test("the guarded globs the branch's change matched, against the base, the way CI's verification judges it", async () => {
    const dev = await developer({ config: { ...PASSING, guarded: ["docker/**", "*.sql"] }, files: { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" } });
    await dev.fixture.branch("feature");
    await dev.fixture.commit("Change things", { "src/a.js": "1\n", "docker/db/Dockerfile": "FROM postgres\n", "packages/api/package.json": "{}\n" });
    await dev.fixture.commit("Drop the lockfile", { "pnpm-lock.yaml": null });
    const mark = world.service.requests.length;

    const result = await dev.run();

    expect(summary(result).attested).toBe("true");
    const [upload] = uploadsSince(mark);
    // Globs only, in the order they are listed (defaults first): a run never sends file names.
    expect(upload!.guardedMatched).toEqual(["pnpm-lock.yaml", "package.json", "docker/**"]);
  });

  test("no guarded glob matched when the branch changes none", async () => {
    const dev = await developer({ config: { ...PASSING, guarded: ["docker/**"] } });
    await dev.fixture.branch("feature");
    await dev.fixture.commit("Change a", { "src/a.js": "1\n" });
    const mark = world.service.requests.length;

    await dev.run();

    expect(uploadsSince(mark)[0]!.guardedMatched).toEqual([]);
  });
});

// Each refusal code has its table-driven case in refusals.test.ts.
describe("refusals before the command starts", () => {
  test("an ignored untracked file is not a dirty tree", async () => {
    const dev = await developer({ files: { ".gitignore": "build/\n" } });
    await dev.fixture.write({ "build/out.js": "x\n" });

    const result = await dev.run();

    expect(result.exitCode).toBe(0);
    expect(summary(result)).toMatchObject({ outcome: "passed", attested: "true" });
  });
});

describe("when the service can't say", () => {
  test("with the service unreachable the tests run, exit with their result and nothing is attested", async () => {
    const suite = await markedSuite(3);
    const dev = await developer({ config: suite.config });
    const mark = world.service.requests.length;

    const result = await dev.run(["--json"], { TESTNOTARY_URL: "http://127.0.0.1:9", TESTNOTARY_TOKEN: await dev.token() });

    expect(suite.started()).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "failed", exitCode: 3, attested: false, warnings: ["service_unreachable"] });
    expect(result.stderr).toMatch(/^testnotary: the Testnotary service could not be reached .*nothing will be attested$/m);
    expect(uploadsSince(mark)).toEqual([]);
  });

  test("an unreachable service doesn't hold a passing run up or attest it", async () => {
    const dev = await developer();

    const result = await dev.run(["--json"], { TESTNOTARY_URL: "http://127.0.0.1:9" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: false, attestationUrl: null });
  });

  test("without a token the tests run with a warning on how to sign in, and nothing is attested", async () => {
    const suite = await markedSuite(0);
    const dev = await developer({ config: suite.config, signedIn: false });
    const mark = world.service.requests.length;

    const result = await dev.run(["--json"]);

    expect(suite.started()).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: false, warnings: ["not_signed_in"] });
    expect(result.stderr).toMatch(/^testnotary: not signed in: .*testnotary login.*sandbox token/m);
    const preflight = world.service.requests.slice(mark).find((request) => request.path === "/api/v1/preflight");
    expect(preflight?.headers).not.toHaveProperty("authorization");
    expect(uploadsSince(mark)).toEqual([]);
  });

  test("GitHub refusing the service's permission check is not a no: the tests run unattested", async () => {
    const dev = await developer();
    const restore = world.github.override("GET", "/repos/:owner/:repo/collaborators/:username/permission", () =>
      Response.json(
        { message: `The \`${dev.repo.owner}\` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.`, status: "403" },
        { status: 403 },
      ),
    );
    try {
      const result = await dev.run(["--json"]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: false, warnings: ["service_unreachable"] });
      expect(result.stderr).toMatch(/github_denied: .*IP allow list/);
    } finally {
      restore();
    }
  });
});

describe("--require-attestation", () => {
  test("a pass that nothing attested exits 3 instead of 0, still with the warning that says why", async () => {
    const dev = await developer({ signedIn: false });

    const plain = await dev.run(["--json"]);
    const required = await dev.run(["--require-attestation", "--json"]);

    expect(plain.exitCode).toBe(0);
    expect(required.exitCode).toBe(3);
    expect(JSON.parse(required.stdout)).toMatchObject({ outcome: "passed", attested: false, warnings: ["not_signed_in"] });
    expect(summary(required)).toMatchObject({ outcome: "passed", attested: "false" });
    expect(required.stderr).toMatch(/^testnotary: the tests passed, but nothing was attested, and --require-attestation asks for an attestation$/m);
  });

  test("an attested pass still exits 0, and a failure 1", async () => {
    const passing = await developer();
    const failing = await developer({ config: FAILING });

    const attested = await passing.run(["--require-attestation"]);
    const failed = await failing.run(["--require-attestation"]);

    expect(attested.exitCode).toBe(0);
    expect(summary(attested).attested).toBe("true");
    expect(failed.exitCode).toBe(1);
  });
});

describe("the base and its config", () => {
  test("run fetches the base and reads testnotary.json from origin's tip, not a stale local ref", async () => {
    const dev = await developer();
    const oldBase = await dev.fixture.revParse("HEAD");
    await dev.fixture.commit("Add the unit suite on main", { "testnotary.json": JSON.stringify({ suites: { ...PASSING.suites, unit: PASSING.suites.test } }) });
    await dev.fixture.push("main");
    await dev.fixture.git("update-ref", "refs/remotes/origin/main", oldBase);
    await dev.fixture.branch("feature", oldBase);

    const result = await dev.run(["unit"]);

    expect(result.exitCode).toBe(0);
    expect(summary(result)).toMatchObject({ suite: "unit", attested: "true" });
  });

  test("the config's base names the branch whose config counts", async () => {
    const dev = await developer({ config: { base: "release", suites: { main: PASSING.suites.test } } });
    await dev.fixture.branch("release");
    await dev.fixture.commit("Release config", { "testnotary.json": JSON.stringify({ base: "release", suites: { release: PASSING.suites.test } }) });
    await dev.fixture.push("release");
    await dev.fixture.checkout("main");

    const fromRelease = await dev.run(["release"]);
    const fromMain = await dev.run(["main", "--json"]);

    expect(fromRelease.exitCode).toBe(0);
    expect(fromMain.exitCode).toBe(2);
    expect(JSON.parse(fromMain.stdout)).toMatchObject({ refusal: "config_invalid" });
    expect(fromMain.stderr).toContain("on origin/release declares no suite \"main\"");
  });

  test("--base wins over the default branch", async () => {
    const dev = await developer({ config: { suites: { main: PASSING.suites.test } } });
    await dev.fixture.branch("next");
    await dev.fixture.commit("Next config", { "testnotary.json": JSON.stringify({ suites: { next: PASSING.suites.test } }) });
    await dev.fixture.push("next");

    const withBase = await dev.run(["next", "--base", "next"]);
    const without = await dev.run(["next", "--json"]);

    expect(withBase.exitCode).toBe(0);
    expect(summary(withBase)).toMatchObject({ suite: "next", attested: "true" });
    expect(JSON.parse(without.stdout)).toMatchObject({ refusal: "config_invalid" });
  });

  test("without origin/HEAD the default branch comes from asking origin", async () => {
    const dev = await developer();
    await dev.fixture.git("remote", "set-head", "origin", "--delete");

    const result = await dev.run();

    expect(result.exitCode).toBe(0);
    expect(summary(result).attested).toBe("true");
  });

  test("when origin can't be fetched the last fetched base is used", async () => {
    const dev = await developer();
    await dev.fixture.git("config", `url.${dev.fixture.remoteDir}-gone.insteadOf`, `https://github.com/${dev.repo.fullName}.git`);
    await dev.fixture.git("config", "--unset", `url.${dev.fixture.remoteDir}.insteadOf`);

    const result = await dev.run();

    expect(result.exitCode).toBe(0);
    expect(summary(result)).toMatchObject({ outcome: "passed", attested: "true" });
  });
});
