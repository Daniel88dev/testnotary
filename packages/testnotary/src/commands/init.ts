// `testnotary init`: sets a repo up from what it already runs. It reads the package manager and
// `scripts.test` the way the environment floor does (never running a package manager), writes
// `testnotary.json` with one suite `test`, adds the agent block to `CLAUDE.md` or `AGENTS.md`, and
// prints the workflow snippet and the next steps. It never touches the workflows. Interactive by
// default: it asks before writing each file; `--yes` takes every default without asking. With
// `--json`, stdout carries one object instead of the snippet and the steps.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { UsageError, parseCommandArgs, type Command } from "../command.ts";
import { tryGit } from "../git.ts";
import { Output } from "../output.ts";
import { EXIT, say } from "../report.ts";
import { isSupported, packageManagerOf, type PackageManagerUse } from "../run/floor/package-manager.ts";
import { readProject, type Project } from "../run/floor/project.ts";
import {
  CONFIG_FILE,
  CONFIG_SCHEMA_URL,
  LINKS,
  PACKAGE_MANAGERS,
  agentsBlock,
  parseConfig,
  suiteFromConfig,
  suiteNames,
  workflowSnippet,
  type PackageManagerName,
} from "../shared.ts";

/** The one suite `init` writes. */
const SUITE = "test";

/** Where the agent block goes: `CLAUDE.md` when the repo has one, otherwise `AGENTS.md`. */
const AGENT_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/** The Node version files the workflow snippet can point `actions/setup-node` at, in its order. */
const NODE_VERSION_FILES = [".nvmrc", ".node-version"] as const;

export const init: Command = {
  name: "init",
  usage: "init [--yes] [--json]",
  summary: "Set this repo up: write testnotary.json, add the agent block, print the workflow snippet.",
  async run(args, context) {
    const { flags, positionals } = parseCommandArgs(args, ["yes"]);
    if (positionals.length > 0) throw new UsageError("init takes no arguments");
    const out = new Output(flags.json);
    const root = (await tryGit(context.cwd, ["rev-parse", "--show-toplevel"], context.env)) ?? context.cwd;
    const ask = new Questions(flags.yes);
    try {
      const done = await setUp(root, ask, context.env);
      if ("error" in done) return out.fail(done.error, done.lines, done.details);
      if (!out.json) process.stdout.write(humanText(done.result));
      out.result(done.result);
      return EXIT.passed;
    } finally {
      ask.close();
    }
  },
};

/** The `--json` object of a set-up that went ahead. Paths are relative to `root`. */
interface InitResult {
  /** The repo's top level. */
  root: string;
  packageManager: PackageManagerName;
  config: { path: string; status: "written" | "existed" | "declined" };
  /** The suite the agent block and the workflow snippet name, and the argv it runs. */
  suite: { name: string; command: string[] };
  agentFile: { path: string; status: "added" | "present" | "declined"; block: string };
  workflowSnippet: string;
  nextSteps: string[];
}

/** Why nothing could be written: `{ error, …details }` with `--json`, and exit 1. */
type InitError = "package_manager_unsupported" | "config_invalid" | "no_package_json" | "no_test_script";

type SetUp = { result: InitResult } | { error: InitError; lines: string[]; details: Record<string, unknown> };

async function setUp(root: string, ask: Questions, env: Readonly<Record<string, string | undefined>>): Promise<SetUp> {
  const project = await readProject(root);
  const use = packageManagerOf(project);
  const name = use.name ?? "npm";
  if (!isSupported(name)) {
    return {
      error: "package_manager_unsupported",
      lines: [`this repo uses ${name}, and Testnotary runs only npm, pnpm and Yarn; nothing was written`],
      details: { packageManager: name },
    };
  }
  const pm = PACKAGE_MANAGERS[name];
  say(`package manager: ${name} (${packageManagerSource(use, name)})`);

  // testnotary.json: an existing one is kept, and its first suite is the one the rest names.
  const configPath = join(root, CONFIG_FILE);
  const existing = await readText(configPath);
  let suite: InitResult["suite"];
  let configStatus: InitResult["config"]["status"];
  if (existing !== undefined) {
    const parsed = parseConfig(existing);
    if (!parsed.ok) {
      return {
        error: "config_invalid",
        lines: [`${CONFIG_FILE} already exists and the library refuses it; fix it and run init again:`, ...parsed.problems.map((problem) => `  ${problem}`)],
        details: { packageManager: name, problems: parsed.problems },
      };
    }
    const first = suiteNames(parsed.config)[0]!;
    suite = { name: first, command: [...suiteFromConfig(parsed.config, first)!.command] };
    configStatus = "existed";
    say(`${CONFIG_FILE} already exists; left as it is (suite ${first})`);
  } else {
    const missing = missingTestScript(project);
    if (missing) {
      return {
        error: missing.error,
        lines: [`${missing.line}; nothing was written`, `add a test script to package.json, or write ${CONFIG_FILE} by hand (${LINKS.setupGuide})`],
        details: missing.error === "no_test_script" ? { packageManager: name } : {},
      };
    }
    suite = { name: SUITE, command: [...pm.testCommand] };
    const text = configText(name);
    say(`suite ${SUITE} runs scripts.test: ${pm.testCommand.join(" ")}`);
    if (await ask.yes(`Write ${CONFIG_FILE} with suite "${SUITE}" (${pm.testCommand.join(" ")})?`)) {
      await writeFile(configPath, text, { flag: "wx" });
      say(`wrote ${CONFIG_FILE}`);
      configStatus = "written";
    } else {
      say(`${CONFIG_FILE} not written`);
      configStatus = "declined";
    }
  }

  // The agent block.
  const block = agentsBlock(name, suite.name);
  const agentFile = existsSync(join(root, "CLAUDE.md")) ? AGENT_FILES[0] : AGENT_FILES[1];
  const agentPath = join(root, agentFile);
  const before = await readText(agentPath);
  let agentStatus: InitResult["agentFile"]["status"];
  if (before?.includes(`testnotary run ${suite.name}`)) {
    say(`${agentFile} already tells agents to run testnotary run ${suite.name}; left as it is`);
    agentStatus = "present";
  } else if (await ask.yes(`Add the Testnotary block to ${agentFile}?`)) {
    await writeFile(agentPath, appended(before, block));
    say(`${before === undefined ? "wrote" : "added the Testnotary block to"} ${agentFile}`);
    agentStatus = "added";
  } else {
    say(`${agentFile} not changed`);
    agentStatus = "declined";
  }

  const nodeVersionFile = NODE_VERSION_FILES.find((file) => existsSync(join(root, file)));
  const remoteHead = await tryGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], env);
  const defaultBranch = remoteHead?.replace(/^origin\//, "");
  return {
    result: {
      root,
      packageManager: name,
      config: { path: CONFIG_FILE, status: configStatus },
      suite,
      agentFile: { path: agentFile, status: agentStatus, block },
      workflowSnippet: workflowSnippet({ packageManager: name, suite: suite.name, nodeVersionFile, defaultBranch }),
      nextSteps: nextSteps({
        packageManager: name,
        suite: suite.name,
        written: [...(configStatus === "written" ? [CONFIG_FILE] : []), ...(agentStatus === "added" ? [agentFile] : [])],
        pinned: use.pin?.source === "packageManager" && use.pin.name !== undefined,
        nodeVersionFile,
      }),
    },
  };
}

/** `testnotary.json` as `init` writes it, checked with the library's own reading first. */
function configText(name: PackageManagerName): string {
  const config = { $schema: CONFIG_SCHEMA_URL, suites: { [SUITE]: { command: [...PACKAGE_MANAGERS[name].testCommand] } } };
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error(`init built a ${CONFIG_FILE} the library refuses: ${parsed.problems.join("; ")}`);
  return text;
}

function missingTestScript(project: Project): { error: "no_package_json" | "no_test_script"; line: string } | undefined {
  if (!project.manifest) return { error: "no_package_json", line: "there is no package.json at the top level of the repo, so there is no scripts.test to run" };
  const scripts = project.manifest.scripts as Record<string, unknown> | undefined;
  const test = typeof scripts === "object" && scripts !== null ? scripts.test : undefined;
  if (typeof test !== "string" || test.trim() === "") return { error: "no_test_script", line: "package.json has no scripts.test to run" };
  return undefined;
}

function packageManagerSource(use: PackageManagerUse, name: string): string {
  if (use.pin?.name !== undefined) return `${use.pin.source} in package.json`;
  if (use.lockfile) return use.lockfile;
  return `no pin or lockfile, so ${name}`;
}

function appended(before: string | undefined, block: string): string {
  if (before === undefined || before.trim() === "") return `${block}\n`;
  return `${before.endsWith("\n") ? before : `${before}\n`}\n${block}\n`;
}

interface NextSteps {
  packageManager: PackageManagerName;
  suite: string;
  /** The files this `init` wrote, for the setup pull request. */
  written: string[];
  pinned: boolean;
  nodeVersionFile: string | undefined;
}

/** The steps left to the person once `init` is done, in order. */
function nextSteps(options: NextSteps): string[] {
  const x = PACKAGE_MANAGERS[options.packageManager].exec;
  const steps: string[] = [];
  if (!options.pinned || !options.nodeVersionFile) {
    const pins = [
      ...(options.nodeVersionFile ? [] : ["Node in .nvmrc"]),
      ...(options.pinned ? [] : [`the package manager in package.json's packageManager (e.g. "${PACKAGE_MANAGERS[options.packageManager].examplePin}")`]),
    ];
    steps.push(`Pin ${pins.join(" and ")}, so laptops and CI use the same versions.`);
  }
  steps.push(
    "Install the Testnotary GitHub App on this repo.",
    `Open one pull request with ${listed([...options.written, "the workflow change"])}, and merge it.`,
    `On each laptop, sign in once: ${x} testnotary login`,
    `Give each agent a sandbox token: ${LINKS.sandboxTokens}`,
    `Before you push: ${x} testnotary run ${options.suite}`,
  );
  return steps;
}

/** What `init` prints on stdout without `--json`: a declined block to paste, the snippet, the next steps. */
function humanText({ agentFile, workflowSnippet: snippet, nextSteps: steps }: InitResult): string {
  const lines: string[] = [];
  if (agentFile.status === "declined") lines.push(`To tell agents yourself, add this to ${agentFile.path}:`, "", agentFile.block, "");
  lines.push(
    "init does not edit workflows. In your workflow, replace the test step with the Testnotary action",
    "and keep the job's name, checkout, Node setup and the install before it:",
    "",
    "# .github/workflows/ci.yml",
    snippet,
    "",
    "Next steps:",
    ...steps.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    `The setup guide: ${LINKS.setupGuide}`,
    "",
  );
  return lines.join("\n");
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The questions `init` asks on stderr, answered one line at a time on stdin. With `--yes` every
 * answer is the default and stdin is never read. An empty line takes the default; stdin closing
 * before an answer is a no, so `init` never writes a file nobody agreed to.
 */
class Questions {
  private readonly assumeYes: boolean;
  private reader: Interface | undefined;
  private lines: AsyncIterator<string> | undefined;

  constructor(assumeYes: boolean) {
    this.assumeYes = assumeYes;
  }

  async yes(question: string): Promise<boolean> {
    if (this.assumeYes) return true;
    for (;;) {
      process.stderr.write(`${question} [Y/n] `);
      const answer = await this.nextLine();
      // A terminal echoes the answer and its newline; piped answers are echoed here instead.
      if (!process.stdin.isTTY) process.stderr.write(`${answer ?? ""}\n`);
      if (answer === undefined) return false;
      const word = answer.trim().toLowerCase();
      if (word === "" || word === "y" || word === "yes") return true;
      if (word === "n" || word === "no") return false;
      say("answer y or n");
    }
  }

  private async nextLine(): Promise<string | undefined> {
    if (!this.lines) {
      this.reader = createInterface({ input: process.stdin, terminal: false });
      this.lines = this.reader[Symbol.asyncIterator]();
    }
    const next = await this.lines.next();
    return next.done ? undefined : next.value;
  }

  close(): void {
    this.reader?.close();
  }
}
