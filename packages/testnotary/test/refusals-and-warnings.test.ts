import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REFUSAL_CODES, WARNING_CODES, type RefusalCode, type WarningCode } from "@testnotary/core";
import type { FakeAccount, FakeRepo, FixtureRepo, Machine, ProcessResult } from "@testnotary/test-world";
import { useWorld } from "@testnotary/test-world/vitest";

// Every refusal code and every warning, each through `testnotary run` as a process: the exit code,
// the summary line, the `--json` object, the explanation on stderr, whether the command started,
// and what reached the service.

const world = useWorld();

let repos = 0;

/** Node code for a suite's command, which runs in the repo's top level. `MARK` names the suite's marker file. */
interface Script {
  /** Runs before the marker is written. */
  before?: string;
  /** Runs once the marker is written. Default: exit 0. */
  after?: string;
}

/**
 * A suite whose command leaves a file behind (outside the repo) when it starts, to tell whether a
 * run got as far as starting it.
 */
async function suite(script: Script = {}) {
  const machine = await world.machine();
  const marker = join(machine.home, `started-${++repos}`);
  const code = `const MARK = ${JSON.stringify(marker)}; ${script.before ?? ""} require("node:fs").writeFileSync(MARK, ""); ${script.after ?? "process.exit(0);"}`;
  return { machine, config: { suites: { test: { command: ["node", "-e", code] } } }, started: () => existsSync(marker), marker };
}

type Suite = Awaited<ReturnType<typeof suite>>;

interface Developer {
  fixture: FixtureRepo;
  repo: FakeRepo;
  machine: Machine;
  user: FakeAccount;
  /** The laptop token `login` left in the machine's keychain. */
  token(): Promise<string>;
}

/** A repo on the fake GitHub with the App installed, and a developer with write access signed in on their laptop. */
async function developer(
  options: { suite?: Suite; config?: Record<string, unknown> | null; files?: Record<string, string>; permission?: "write" | "read"; signedIn?: boolean } = {},
): Promise<Developer> {
  const n = ++repos;
  const fixture = await world.fixtureRepo({ config: options.config === undefined ? (options.suite?.config ?? PASSING) : options.config, files: options.files });
  const repo = await world.hostOnGitHub(fixture, { owner: `refusals-${n}`, name: "widgets" });
  await world.github.installApp({ account: { login: `refusals-${n}`, type: "Organization" }, repos: [repo] });
  const machine = options.suite?.machine ?? (await world.machine());
  const user = world.github.addUser({ login: `refusals-dev-${n}` });
  world.github.setPermission(repo, user, options.permission ?? "write");
  if (options.signedIn !== false) {
    world.github.deviceFlow.approveNext(user);
    expect((await world.runCli(["login"], { cwd: machine.home, machine })).exitCode).toBe(0);
  }
  return {
    fixture,
    repo,
    machine,
    user,
    async token() {
      const [entry] = await machine.keychain();
      return entry!.secret;
    },
  };
}

const PASSING = { suites: { test: { command: ["node", "-e", "process.exit(0)"] } } };

/** The fixed summary line: the last line on stderr. */
function summary(result: ProcessResult): Record<string, string> {
  const last = result.stderr.trimEnd().split("\n").at(-1)!;
  expect(last).toMatch(/^outcome=\S* suite=\S* attested=\S* tree=\S* commit=\S* url=\S*$/);
  return Object.fromEntries(last.split(" ").map((pair) => pair.split("=", 2) as [string, string]));
}

/** The bodies `run` sent to the service's run upload, from request number `from` on. */
function uploadsSince(from: number): Record<string, unknown>[] {
  return world.service.requests
    .slice(from)
    .filter((request) => request.method === "POST" && request.path === "/api/v1/runs")
    .map((request) => JSON.parse(request.text) as Record<string, unknown>);
}

/** Where and how a case runs `testnotary run --json <args>`. */
interface Scene {
  dev?: Developer;
  cwd: string;
  machine: Machine;
  args?: string[];
  env?: Record<string, string | undefined>;
  rootFiles?: string[];
  /** Sends this signal once the command has started (the suite's marker exists). */
  signal?: NodeJS.Signals;
  /** Run after the case, pass or fail. */
  cleanup?: () => void;
}

interface RefusalCase {
  name: string;
  /** What the suite's command does (default: start and exit 0). */
  script?: Script;
  arrange(suite: Suite): Promise<Scene>;
  /** A line of the explanation on stderr. */
  says: RegExp;
  /** Whether the command ran before the refusal (default: it never started). */
  started?: boolean;
  /** Whether the refused run reached the service's run upload. */
  uploaded: boolean;
  /** The CLI's exit code (default 2). */
  exitCode?: number;
  /** More to check once the run ended. */
  also?(result: ProcessResult, suite: Suite): void;
}

/** Codes whose checks a later ticket builds: their cases are listed as todo until it lands. */
type Gap = { gap: string };

const ENVIRONMENT_FLOOR: Gap = { gap: "T-815: the platform and the environment floor" };

const signedInRepo = async (s: Suite, options: Parameters<typeof developer>[0] = {}): Promise<Scene> => {
  const dev = await developer({ suite: s, ...options });
  return { dev, cwd: dev.fixture.dir, machine: dev.machine };
};

/** A repo with a submodule at `vendor/lib`, committed on top of the base. */
async function withSubmodule(s: Suite, options: { ignore?: "all" } = {}): Promise<Scene> {
  const scene = await signedInRepo(s);
  const fixture = scene.dev!.fixture;
  const library = await world.fixtureRepo({ config: null, files: { "lib.js": "export const one = 1;\n" } });
  await fixture.git("-c", "protocol.file.allow=always", "submodule", "--quiet", "add", library.dir, "vendor/lib");
  if (options.ignore) await fixture.git("config", "--file", ".gitmodules", "submodule.vendor/lib.ignore", options.ignore);
  await fixture.commit("Add the vendored library");
  return scene;
}

/**
 * A PATH with git but no Node package tools, for commands that must never start: if a check let
 * one through, it ends `command_not_found` rather than reaching a registry.
 */
const NO_TOOLS = { PATH: "/usr/bin:/bin" };

const REFUSALS: Record<RefusalCode, RefusalCase[] | Gap> = {
  not_a_git_repo: [
    {
      name: "a directory outside any git repo",
      async arrange(s) {
        return { cwd: s.machine.home, machine: s.machine };
      },
      says: /not inside a git repository/,
      uploaded: false,
    },
  ],
  no_remote: [
    {
      name: "a repo with no origin",
      async arrange(s) {
        const scene = await signedInRepo(s);
        await scene.dev!.fixture.git("remote", "remove", "origin");
        return scene;
      },
      says: /no remote named origin/,
      uploaded: false,
    },
  ],
  no_config_on_base: [
    {
      name: "a base branch without testnotary.json, even with one committed locally",
      async arrange(s) {
        const scene = await signedInRepo(s, { config: null });
        await scene.dev!.fixture.commit("Add the config, not pushed", { "testnotary.json": JSON.stringify(s.config) });
        return scene;
      },
      says: /origin\/main has no testnotary\.json/,
      uploaded: true,
    },
  ],
  config_invalid: [
    {
      name: "a suite the base config doesn't declare",
      async arrange(s) {
        return { ...(await signedInRepo(s)), args: ["lint"] };
      },
      says: /declares no suite "lint"; it declares: test/,
      uploaded: true,
    },
  ],
  extra_arguments: [
    {
      name: "arguments after --",
      async arrange(s) {
        return { ...(await signedInRepo(s)), args: ["--", "--grep", "checkout"] };
      },
      says: /after -- is refused \(--grep checkout\)/,
      uploaded: true,
    },
    {
      name: "a suite named before --, with a test file after it",
      async arrange(s) {
        return { ...(await signedInRepo(s)), args: ["test", "--", "src/only-this.test.js"] };
      },
      says: /after -- is refused \(src\/only-this\.test\.js\)[\s\S]*testnotary\.json on origin\/main declares/,
      uploaded: true,
    },
  ],
  history_dependent_command: [
    ...(
      [
        ["--changed in the command", ["npx", "vitest", "run", "--changed"], /--changed/],
        ["--changedSince=<ref> in the command", ["npx", "jest", "--changedSince=origin/main"], /--changedSince/],
        ["--onlyChanged in the command", ["npx", "jest", "--onlyChanged"], /--onlyChanged/],
        ["--since <ref> in the command", ["npx", "lerna", "run", "test", "--since", "main"], /--since/],
        ["nx affected in the command", ["pnpm", "nx", "affected", "-t", "test"], /nx affected/],
        ["a turbo git-ref filter in the command", ["pnpm", "turbo", "run", "test", "--filter=...[origin/main]"], /--filter=\.\.\.\[origin\/main\]/],
        ["turbo's -F with a git-ref filter in the command", ["npx", "turbo", "test", "-F", "[HEAD^1]"], /\[HEAD\^1\]/],
        ["turbo --affected in the command", ["npx", "turbo", "run", "test", "--affected"], /--affected/],
      ] as const
    ).map(
      ([name, command, says]): RefusalCase => ({
        name,
        async arrange(s) {
          return { ...(await signedInRepo(s, { config: { suites: { test: { command } } } })), env: NO_TOOLS };
        },
        says,
        uploaded: true,
      }),
    ),
    ...(
      [
        ["--changed in the package.json script npm test names", ["npm", "test"], "test", "vitest run --changed"],
        ["nx affected in the script pnpm run names", ["pnpm", "run", "test:ci"], "test:ci", "nx affected --target=test"],
        ["a quoted turbo filter in the script yarn names", ["yarn", "test:ci"], "test:ci", "turbo run test --filter='[origin/main]' && echo done"],
        ["--since in the script npm run-script names", ["npm", "run-script", "--silent", "check"], "check", "lerna run test --since=main"],
      ] as const
    ).map(
      ([name, command, script, text]): RefusalCase => ({
        name,
        async arrange(s) {
          const scene = await signedInRepo(s, {
            config: { suites: { test: { command } } },
            files: { "package.json": JSON.stringify({ name: "widgets", scripts: { [script]: text } }) },
          });
          return { ...scene, env: NO_TOOLS };
        },
        says: new RegExp(`package\\.json script "${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
        uploaded: true,
      }),
    ),
  ],
  command_not_found: [
    {
      name: "a program that isn't on PATH",
      async arrange(s) {
        return signedInRepo(s, { config: { suites: { test: { command: ["no-such-test-runner-5c1e", "run"] } } } });
      },
      says: /no-such-test-runner-5c1e was not found on PATH/,
      uploaded: true,
    },
  ],
  dirty_tree: [
    {
      name: "a modified tracked file",
      async arrange(s) {
        const scene = await signedInRepo(s, { files: { "src/a.js": "1\n" } });
        await scene.dev!.fixture.write({ "src/a.js": "2\n" });
        return scene;
      },
      says: /src\/a\.js[\s\S]*commit them/,
      uploaded: true,
    },
    {
      name: "an untracked file that isn't ignored",
      async arrange(s) {
        const scene = await signedInRepo(s, { files: { ".gitignore": "build/\n" } });
        await scene.dev!.fixture.write({ "scratch.txt": "x\n" });
        return scene;
      },
      says: /\?\? scratch\.txt/,
      uploaded: true,
    },
    {
      name: "a submodule with changes in it",
      async arrange(s) {
        const scene = await withSubmodule(s);
        await scene.dev!.fixture.write({ "vendor/lib/lib.js": "export const one = 2;\n" });
        return scene;
      },
      says: /vendor\/lib/,
      uploaded: true,
    },
    {
      name: "a submodule at another commit",
      async arrange(s) {
        const scene = await withSubmodule(s);
        await scene.dev!.fixture.git("-C", "vendor/lib", "commit", "--quiet", "--allow-empty", "-m", "Local change");
        return scene;
      },
      says: /vendor\/lib/,
      uploaded: true,
    },
    {
      name: "a submodule with changes, although .gitmodules says to ignore it",
      async arrange(s) {
        const scene = await withSubmodule(s, { ignore: "all" });
        await scene.dev!.fixture.write({ "vendor/lib/new.js": "export {};\n" });
        return scene;
      },
      says: /submodule vendor\/lib has changes that aren't committed/,
      uploaded: true,
    },
    {
      name: "a submodule at another commit, although .gitmodules says to ignore it",
      async arrange(s) {
        const scene = await withSubmodule(s, { ignore: "all" });
        await scene.dev!.fixture.git("-C", "vendor/lib", "commit", "--quiet", "--allow-empty", "-m", "Local change");
        return scene;
      },
      says: /submodule vendor\/lib is at another commit than the one this commit records/,
      uploaded: true,
    },
  ],
  tree_changed_during_run: [
    {
      name: "the command writes a file git sees",
      script: { after: `require("node:fs").writeFileSync("coverage.txt", "100%\\n");` },
      arrange: (s) => signedInRepo(s),
      says: /changed while the command ran[\s\S]*coverage\.txt[\s\S]*\.gitignore/,
      started: true,
      uploaded: true,
    },
    {
      name: "the command deletes a tracked file",
      script: { after: `require("node:fs").rmSync("src/fixture.json");` },
      arrange: (s) => signedInRepo(s, { files: { "src/fixture.json": "{}\n" } }),
      says: /changed while the command ran[\s\S]*src\/fixture\.json/,
      started: true,
      uploaded: true,
    },
    {
      name: "the command commits, so HEAD moves",
      script: {
        after: `require("node:child_process").execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "During the run"]);`,
      },
      arrange: (s) => signedInRepo(s),
      says: /HEAD moved from [0-9a-f]{7,} to [0-9a-f]{7,} while the command ran/,
      started: true,
      uploaded: true,
    },
  ],
  platform_not_allowed: ENVIRONMENT_FLOOR,
  platform_unsupported: ENVIRONMENT_FLOOR,
  repo_not_installed: [
    {
      name: "a repo the App is not installed on",
      async arrange(s) {
        const dev = await developer({ suite: s });
        const other = await world.fixtureRepo({ config: s.config });
        await world.hostOnGitHub(other, { owner: dev.repo.owner, name: "not-installed" });
        return { cwd: other.dir, machine: dev.machine };
      },
      says: /App is not installed on .+\/not-installed/,
      uploaded: false,
    },
    {
      name: "a repo the App was removed from",
      async arrange(s) {
        const scene = await signedInRepo(s);
        const installation = [...world.github.state.installations.values()].find((candidate) => candidate.repoIds.has(scene.dev!.repo.id))!;
        await world.github.uninstallApp(installation);
        return scene;
      },
      says: /App is not installed/,
      uploaded: false,
    },
    {
      name: "an origin that isn't on github.com",
      async arrange(s) {
        const scene = await signedInRepo(s);
        await scene.dev!.fixture.git("remote", "set-url", "origin", scene.dev!.fixture.remoteDir);
        return scene;
      },
      says: /is not a repository on github\.com/,
      uploaded: false,
    },
  ],
  no_write_access: [
    {
      name: "an account that can only read the repo",
      async arrange(s) {
        return signedInRepo(s, { permission: "read" });
      },
      says: /can't write to/,
      uploaded: false,
    },
  ],
  token_rejected: [
    {
      name: "a revoked token",
      async arrange(s) {
        const scene = await signedInRepo(s);
        const token = await scene.dev!.token();
        expect((await world.runCli(["logout"], { cwd: scene.machine.home, machine: scene.machine })).exitCode).toBe(0);
        return { ...scene, env: { TESTNOTARY_TOKEN: token } };
      },
      says: /rejected TESTNOTARY_TOKEN/,
      uploaded: false,
    },
  ],
  interrupted: [
    {
      name: "Ctrl-C while the command runs",
      // The command notes the SIGINT it gets, then exits the way a test runner does on Ctrl-C.
      script: {
        before: `process.on("SIGINT", () => { require("node:fs").writeFileSync(MARK + ".sigint", ""); process.exit(130); });`,
        after: "setInterval(() => {}, 1000);",
      },
      async arrange(s) {
        return { ...(await signedInRepo(s)), signal: "SIGINT" };
      },
      says: /interrupted/,
      started: true,
      uploaded: true,
      exitCode: 130,
      also(_result, s) {
        expect(existsSync(`${s.marker}.sigint`), "the test process got the SIGINT").toBe(true);
      },
    },
  ],
  runtime_mismatch: ENVIRONMENT_FLOOR,
  package_manager_mismatch: ENVIRONMENT_FLOOR,
  install_stale: ENVIRONMENT_FLOOR,
  package_manager_unsupported: ENVIRONMENT_FLOOR,
  laptop_token_in_sandbox: [
    {
      name: "a laptop token in TESTNOTARY_TOKEN inside a sandbox",
      async arrange(s) {
        const scene = await signedInRepo(s);
        return { ...scene, env: { TESTNOTARY_SANDBOX: "1", TESTNOTARY_TOKEN: await scene.dev!.token() } };
      },
      says: /laptop token/,
      uploaded: false,
    },
  ],
};

const refusalCases = REFUSAL_CODES.flatMap((refusal) => {
  const cases = REFUSALS[refusal];
  return "gap" in cases ? [] : cases.map((scenario) => ({ refusal, ...scenario }));
});
const refusalGaps = REFUSAL_CODES.flatMap((refusal) => {
  const cases = REFUSALS[refusal];
  return "gap" in cases ? [{ refusal, gap: cases.gap }] : [];
});

describe("each refusal code through testnotary run", () => {
  test.each(refusalCases)("$refusal: $name", async (scenario) => {
    const s = await suite(scenario.script);
    const scene = await scenario.arrange(s);
    const mark = world.service.requests.length;
    const tree = scene.dev && (await scene.dev.fixture.tree());
    const commit = scene.dev && (await scene.dev.fixture.revParse("HEAD"));

    let result: ProcessResult;
    try {
      result = await world.runCli(["run", "--json", ...(scene.args ?? [])], {
        cwd: scene.cwd,
        machine: scene.machine,
        env: scene.env,
        rootFiles: scene.rootFiles,
        ...(scene.signal ? { cancelOnceExists: s.marker, cancelSignal: scene.signal } : {}),
      });
    } finally {
      scene.cleanup?.();
    }

    expect(result.exitCode).toBe(scenario.exitCode ?? 2);
    const out = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ outcome: "refused", refusal: scenario.refusal, attested: false, attestationUrl: null });
    expect(out.exitCode === null).toBe(!scenario.started);
    expect(summary(result)).toMatchObject({ outcome: "refused", attested: "false", url: "" });
    expect(result.stderr).toMatch(scenario.says);
    expect(s.started()).toBe(scenario.started ?? false);
    const uploads = uploadsSince(mark);
    if (scenario.uploaded) {
      // Only the code, the tree and the commit: nothing else about a refused run leaves the machine.
      expect(uploads).toEqual([{ repository: scene.dev!.repo.fullName, outcome: "refused", refusal: scenario.refusal, tree, commit }]);
    } else {
      expect(uploads).toEqual([]);
    }
    scenario.also?.(result, s);
  });

  // The codes whose checks aren't built yet: listed, so the table stays one entry per code.
  for (const { refusal, gap } of refusalGaps) test.todo(`${refusal}: ${gap}`);
});

interface WarningCase {
  name: string;
  arrange(suite: Suite): Promise<Scene>;
  /** The warning's own line on stderr, after the `testnotary: ` prefix. */
  says: RegExp;
  /** Whether the pass is still attested. */
  attested: boolean;
}

const WARNINGS: Record<WarningCode, WarningCase[] | Gap> = {
  not_signed_in: [
    {
      name: "no token on the laptop",
      arrange: (s) => signedInRepo(s, { signedIn: false }),
      says: /^not signed in: .*testnotary login/,
      attested: false,
    },
  ],
  service_unreachable: [
    {
      name: "the service doesn't answer",
      async arrange(s) {
        return { ...(await signedInRepo(s)), env: { TESTNOTARY_URL: "http://127.0.0.1:9" } };
      },
      says: /^the Testnotary service could not be reached/,
      attested: false,
    },
  ],
  upload_failed: [
    {
      name: "the service fails the upload",
      async arrange(s) {
        const scene = await signedInRepo(s);
        const restore = world.service.override("POST", "/api/v1/runs", () => Response.json({ error: "internal" }, { status: 500 }));
        return { ...scene, cleanup: restore };
      },
      says: /^the run could not be uploaded .*nothing was attested/,
      attested: false,
    },
  ],
  base_fetch_skipped: [
    {
      name: "origin can't be fetched (offline)",
      async arrange(s) {
        const scene = await signedInRepo(s);
        const { fixture, repo } = scene.dev!;
        await fixture.git("config", `url.${fixture.remoteDir}-gone.insteadOf`, `https://github.com/${repo.fullName}.git`);
        await fixture.git("config", "--unset", `url.${fixture.remoteDir}.insteadOf`);
        return scene;
      },
      says: /^couldn't fetch origin\/main .*the last fetched origin\/main/,
      attested: true,
    },
  ],
  branch_behind_base: [
    {
      name: "the base has a commit the branch doesn't",
      async arrange(s) {
        const scene = await signedInRepo(s);
        const { fixture } = scene.dev!;
        const fork = await fixture.revParse("HEAD");
        await fixture.commit("Move main on", { "src/main-only.js": "export {};\n" });
        await fixture.push("main");
        await fixture.branch("feature", fork);
        return scene;
      },
      says: /^this branch is behind origin\/main .*won't skip until you update it/,
      attested: true,
    },
  ],
  local_config_differs: [
    {
      name: "the branch changes testnotary.json",
      async arrange(s) {
        const scene = await signedInRepo(s);
        const { fixture } = scene.dev!;
        await fixture.branch("feature");
        await fixture.commit("Add a suite", { "testnotary.json": JSON.stringify({ suites: { ...s.config.suites, lint: s.config.suites.test } }) });
        return scene;
      },
      says: /^testnotary\.json here differs from origin\/main's, which is the one used/,
      attested: true,
    },
  ],
  ignored_env_file: [
    {
      name: "an ignored .env.local",
      async arrange(s) {
        const scene = await signedInRepo(s, { files: { ".gitignore": ".env*\n!.env.example\n" } });
        await scene.dev!.fixture.write({ ".env.local": "DATABASE_URL=postgres://localhost/dev\n" });
        return scene;
      },
      says: /^an ignored \.env file exists \(\.env\.local\)/,
      attested: true,
    },
    {
      name: "an ignored .env in a package of a workspace",
      async arrange(s) {
        const scene = await signedInRepo(s, { files: { ".gitignore": ".env\n" } });
        await scene.dev!.fixture.write({ "packages/api/.env": "SECRET=1\n" });
        return scene;
      },
      says: /^an ignored \.env file exists \(packages\/api\/\.env\)/,
      attested: true,
    },
  ],
  runtime_sources_disagree: ENVIRONMENT_FLOOR,
  no_signing_key: [
    {
      name: "signature mode with no signing key set up",
      arrange: (s) => signedInRepo(s, { config: { ...s.config, signatures: "required" } }),
      says: /^the repo requires signatures, but /,
      attested: true,
    },
  ],
};

const warningCases = WARNING_CODES.flatMap((warning) => {
  const cases = WARNINGS[warning];
  return "gap" in cases ? [] : cases.map((scenario) => ({ warning, ...scenario }));
});
const warningGaps = WARNING_CODES.flatMap((warning) => {
  const cases = WARNINGS[warning];
  return "gap" in cases ? [{ warning, gap: cases.gap }] : [];
});

describe("each warning through testnotary run: a line on stderr, a code in warnings[], never a refusal", () => {
  test.each(warningCases)("$warning: $name", async (scenario) => {
    const s = await suite();
    const scene = await scenario.arrange(s);
    const mark = world.service.requests.length;

    let result: ProcessResult;
    try {
      result = await world.runCli(["run", "--json"], { cwd: scene.cwd, machine: scene.machine, env: scene.env });
    } finally {
      scene.cleanup?.();
    }

    expect(s.started()).toBe(true);
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as { warnings: string[] };
    expect(out).toMatchObject({ outcome: "passed", refusal: null, attested: scenario.attested });
    expect(out.warnings).toContain(scenario.warning);
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("testnotary: ")).map((line) => line.slice("testnotary: ".length));
    expect(lines.some((line) => scenario.says.test(line)), result.stderr).toBe(true);
    // The warning goes with the run's record whenever the run is uploaded (`upload_failed` comes
    // from the upload itself, so the record can't carry it).
    if (scenario.warning !== "upload_failed") for (const upload of uploadsSince(mark)) expect(upload.warnings).toContain(scenario.warning);
  });

  for (const { warning, gap } of warningGaps) test.todo(`${warning}: ${gap}`);

  test("a clean run on the base's tip warns about nothing; an ignored .env.example is not a .env file", async () => {
    const s = await suite();
    const scene = await signedInRepo(s, { files: { ".gitignore": ".env.example\n" } });
    await scene.dev!.fixture.write({ ".env.example": "DATABASE_URL=\n" });

    const result = await world.runCli(["run", "--json"], { cwd: scene.cwd, machine: scene.machine });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true, warnings: [] });
  });
});

describe("what isn't a dirty tree", () => {
  test("a submodule at the commit HEAD records, with nothing changed in it, attests", async () => {
    const s = await suite();
    const scene = await withSubmodule(s, { ignore: "all" });

    const result = await world.runCli(["run", "--json"], { cwd: scene.cwd, machine: scene.machine });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true });
  });
});

describe("what doesn't change the tree during a run", () => {
  test("a command writing its output into an ignored directory attests", async () => {
    const s = await suite({ after: `require("node:fs").mkdirSync("coverage", { recursive: true }); require("node:fs").writeFileSync("coverage/lcov.info", "TN:\\n");` });
    const dev = await developer({ suite: s, files: { ".gitignore": "coverage/\n" } });

    const result = await world.runCli(["run", "--json"], { cwd: dev.fixture.dir, machine: dev.machine });

    expect(s.started()).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true });
  });
});

describe("what isn't a history-dependent command", () => {
  test("a turbo package filter without a git range, and words that only look alike, run as usual", async () => {
    const command = ["node", "-e", "process.exit(0)", "--", "--filter=@acme/web", "--changed-files-report", "affected"];
    const dev = await developer({ config: { suites: { test: { command } } } });

    const result = await world.runCli(["run", "--json"], { cwd: dev.fixture.dir, machine: dev.machine });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", attested: true });
  });
});
