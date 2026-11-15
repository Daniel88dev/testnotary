// What a repo adds to adopt Testnotary: the package-manager commands, the workflow snippet and the
// AGENTS.md block. One definition, so `init`'s output, the docs and the landing page show the same
// text (open decision 1: the snippet grants `contents: read` as well, or checkout fails on a
// private repo).

export type PackageManagerName = "pnpm" | "npm" | "yarn";

export interface PackageManager {
  name: PackageManagerName;
  /** Adds the library as a dev dependency. */
  add: string;
  /** Runs a binary from the repo's dependencies: `<exec> testnotary run unit`. */
  exec: string;
  /** The install CI runs, from the lockfile only. */
  ciInstall: string;
  /** The suite command for the repo's `scripts.test`. */
  testCommand: readonly string[];
  /** `actions/setup-node`'s `cache` value. */
  cache: string;
  lockfile: string;
  /** An example `packageManager` value. */
  examplePin: string;
}

export const PACKAGE_MANAGERS: Readonly<Record<PackageManagerName, PackageManager>> = {
  pnpm: {
    name: "pnpm",
    add: "pnpm add -D testnotary",
    exec: "pnpm exec",
    ciInstall: "pnpm install --frozen-lockfile",
    testCommand: ["pnpm", "run", "test"],
    cache: "pnpm",
    lockfile: "pnpm-lock.yaml",
    examplePin: "pnpm@9.15.0",
  },
  npm: {
    name: "npm",
    add: "npm install -D testnotary",
    exec: "npx",
    ciInstall: "npm ci",
    testCommand: ["npm", "test"],
    cache: "npm",
    lockfile: "package-lock.json",
    examplePin: "npm@10.9.2",
  },
  yarn: {
    name: "yarn",
    add: "yarn add -D testnotary",
    exec: "yarn",
    ciInstall: "yarn install --immutable",
    testCommand: ["yarn", "test"],
    cache: "yarn",
    lockfile: "yarn.lock",
    examplePin: "yarn@4.5.3",
  },
};

/** The action, as a workflow names it. */
export const ACTION_REF = "Daniel88dev/testnotary@v1";

/** The repository variable the action reads before anything else: `true` turns skipping off. */
export const KILL_SWITCH_VARIABLE = "TESTNOTARY_DISABLED";

/**
 * The workflow permissions every snippet grants: `contents: read` for checkout, `id-token: write`
 * so the action can identify the workflow with an OIDC token, `checks: write` for the check run.
 */
export const WORKFLOW_PERMISSIONS: ReadonlyArray<readonly [scope: string, access: string]> = [
  ["contents", "read"],
  ["id-token", "write"],
  ["checks", "write"],
];

export interface WorkflowSnippetOptions {
  packageManager: PackageManagerName;
  /** The suite the test step runs. */
  suite: string;
  /** The file `actions/setup-node` reads the Node version from. */
  nodeVersionFile?: string;
  /** The default branch, pushed to after a merge. */
  defaultBranch?: string;
}

const PERMISSION_COMMENTS: Record<string, (suite: string) => string> = {
  "id-token": () => "lets the action identify the workflow",
  checks: (suite) => `writes the Testnotary / ${suite} check`,
};

/** The workflow-level lines every snippet starts with: triggers, permissions and the kill switch. */
export function workflowHeader(options: { defaultBranch?: string; suite: string; mergeQueue?: "comment" | "always" }): string[] {
  const branch = options.defaultBranch ?? "main";
  const mergeGroup = options.mergeQueue === "always" ? "  merge_group:" : "  merge_group:          # only if you use a merge queue";
  return [
    "on:",
    "  pull_request:",
    "  push:",
    `    branches: [${branch}]`,
    mergeGroup,
    "",
    "permissions:",
    ...WORKFLOW_PERMISSIONS.map(([scope, access]) => {
      const line = `  ${scope}: ${access}`;
      const comment = PERMISSION_COMMENTS[scope]?.(options.suite);
      return comment ? `${line.padEnd(23)}# ${comment}` : line;
    }),
    "",
    "env:",
    `  ${KILL_SWITCH_VARIABLE}: \${{ vars.${KILL_SWITCH_VARIABLE} }}   # kill switch`,
  ];
}

/** The steps before the test step: checkout, the package manager, Node and the install. */
export function setupSteps(options: { packageManager: PackageManagerName; nodeVersionFile?: string; indent?: string }): string[] {
  const pm = PACKAGE_MANAGERS[options.packageManager];
  const i = options.indent ?? "      ";
  return [
    `${i}- uses: actions/checkout@v5`,
    ...(pm.name === "pnpm" ? [`${i}- uses: pnpm/action-setup@v4`] : []),
    `${i}- uses: actions/setup-node@v5`,
    `${i}  with:`,
    `${i}    node-version-file: ${options.nodeVersionFile ?? ".nvmrc"}`,
    `${i}    cache: ${pm.cache}`,
    `${i}- run: ${pm.ciInstall}`,
  ];
}

/** The inline shape: the action replaces the test step of an existing job. */
export function workflowSnippet(options: WorkflowSnippetOptions): string {
  return [
    "name: CI",
    "",
    ...workflowHeader({ defaultBranch: options.defaultBranch, suite: options.suite }),
    "",
    "jobs:",
    "  test:                # keep your job and its required check name",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...setupSteps(options),
    "      - id: testnotary   # replaces your test step",
    `        uses: ${ACTION_REF}`,
    "        with:",
    `          suite: ${options.suite}`,
  ].join("\n");
}

/** The block `init` offers for `AGENTS.md` (or `CLAUDE.md`). */
export function agentsBlock(packageManager: PackageManagerName, suite: string): string {
  const x = PACKAGE_MANAGERS[packageManager].exec;
  return [
    "## Tests",
    "",
    "Before you open or update a pull request, commit your work and run:",
    "",
    `    ${x} testnotary run ${suite}`,
    "",
    "Run it exactly like that, with no extra arguments. If the last line",
    `says outcome=refused, run \`${x} testnotary check ${suite}\` and fix`,
    "what it names. If it says outcome=failed, fix the tests.",
  ].join("\n");
}
