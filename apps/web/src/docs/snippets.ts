import {
  ACTION_REF,
  CONFIG_SCHEMA_URL,
  PACKAGE_MANAGERS,
  agentsBlock,
  setupSteps,
  workflowHeader,
  workflowSnippet,
  type PackageManagerName,
} from "@testnotary/core";
import { DEFAULT_SERVICE_URL, LINKS, runPageUrl } from "@testnotary/protocol";

// Code panels that depend on the package manager. A panel is either a named snippet below, or a
// fenced block whose text uses {{tokens}}: {{pm}}, {{add}}, {{x}} (runs a dependency's binary), {{ci}},
// {{lock}}, {{cache}}, {{test}} (the suite command as JSON), {{pin}}. Everything here is built from
// the core and protocol packages, so the docs show what the product does.

export const PMS: readonly PackageManagerName[] = ["pnpm", "npm", "yarn"];

export function substitute(text: string, pm: PackageManagerName): string {
  const p = PACKAGE_MANAGERS[pm];
  const tokens: Record<string, string> = {
    pm: p.name,
    add: p.add,
    x: p.exec,
    ci: p.ciInstall,
    lock: p.lockfile,
    cache: p.cache,
    test: JSON.stringify(p.testCommand).replace(/,/g, ", "),
    pin: p.examplePin,
  };
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = tokens[name];
    if (value === undefined) throw new Error(`unknown docs token ${whole}`);
    return value;
  });
}

// Sample values the guide uses throughout (invented: acme/shop, @maria-k).
const SAMPLE = {
  repository: "acme/shop",
  tree: "a91f3c2e8b0d4f17c6a95e3b2d7f0c4a8e1b6d93",
  commit: "5d0e7b1f9a3c4e2d8b6f0a1c7e5d3b9f2a4c6e80",
  runId: "0f8c2d1e-4b7a-4c39-9a52-6e1d3b8f7c20",
  login: "maria-k",
  tokenName: "macOS machine, 15 Nov 2026",
};

function config(pm: PackageManagerName): string {
  return [
    "{",
    `  "$schema": "${CONFIG_SCHEMA_URL}",`,
    '  "suites": {',
    `    "unit": { "command": ${substitute("{{test}}", pm)} }`,
    "  }",
    "}",
  ].join("\n");
}

function gate(pm: PackageManagerName): string {
  return [
    "name: CI",
    "",
    ...workflowHeader({ suite: "e2e" }),
    "",
    "jobs:",
    "  testnotary:          # no checkout, no install: only the verification",
    "    runs-on: ubuntu-latest",
    "    outputs:",
    "      skip: ${{ steps.verify.outputs.skip }}",
    "      verification: ${{ steps.verify.outputs.verification }}",
    "    steps:",
    "      - id: verify",
    `        uses: ${ACTION_REF}`,
    "        with:",
    "          suite: e2e",
    "          mode: verify",
    "",
    "  e2e:                 # your test job, with its required check name",
    "    needs: testnotary",
    "    if: ${{ !cancelled() && needs.testnotary.outputs.skip != 'true' }}",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...setupSteps({ packageManager: pm }),
    "      - run: docker compose up -d --wait   # the expensive setup",
    "      - id: testnotary",
    `        uses: ${ACTION_REF}`,
    "        with:",
    "          suite: e2e",
    "          verification: ${{ needs.testnotary.outputs.verification }}",
  ].join("\n");
}

function matrix(pm: PackageManagerName): string {
  return [
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    strategy:",
    "      matrix:",
    "        suite: [unit, integration]",
    "    steps:",
    ...setupSteps({ packageManager: pm }),
    "      - id: testnotary   # one verification per leg",
    `        uses: ${ACTION_REF}`,
    "        with:",
    "          suite: ${{ matrix.suite }}",
  ].join("\n");
}

function coverage(pm: PackageManagerName): string {
  return [
    "    steps:",
    ...setupSteps({ packageManager: pm }),
    "      - id: testnotary",
    `        uses: ${ACTION_REF}`,
    "        with:",
    "          suite: unit",
    "      - if: ${{ !cancelled() && steps.testnotary.outputs.ran == 'true' }}",
    "        uses: actions/upload-artifact@v4",
    "        with:",
    "          name: coverage",
    "          path: coverage/",
  ].join("\n");
}

function queue(): string {
  return ["name: CI", "", ...workflowHeader({ suite: "unit", mergeQueue: "always" })].join("\n");
}

function login(pm: PackageManagerName): string {
  const x = PACKAGE_MANAGERS[pm].exec;
  return [
    `$ ${x} testnotary login`,
    `testnotary: by signing in you agree to the Terms (${LINKS.terms}) and accept the Privacy policy (${LINKS.privacy})`,
    "testnotary: open https://github.com/login/device and enter 8F3C-21DA",
    `testnotary: signed in as @${SAMPLE.login} (laptop token "${SAMPLE.tokenName}")`,
    "",
    `$ ${x} testnotary whoami`,
    `@${SAMPLE.login} · laptop token "${SAMPLE.tokenName}" · expires 13 Feb 2027`,
  ].join("\n");
}

function firstRun(pm: PackageManagerName): string {
  const x = PACKAGE_MANAGERS[pm].exec;
  const url = runPageUrl(DEFAULT_SERVICE_URL, SAMPLE.repository, SAMPLE.runId);
  return [
    "$ git pull --rebase origin main",
    `$ ${x} testnotary run unit`,
    `testnotary: run unit: ${PACKAGE_MANAGERS[pm].testCommand.join(" ")}`,
    "  …your test output…",
    "testnotary: suite unit passed",
    `testnotary: attested: ${url}`,
    `outcome=passed suite=unit attested=true tree=${SAMPLE.tree} commit=${SAMPLE.commit} url=${url}`,
    "",
    "$ git push -u origin fix-cart-total",
  ].join("\n");
}

export const SNIPPETS: Record<string, (pm: PackageManagerName) => string> = {
  workflow: (pm) => workflowSnippet({ packageManager: pm, suite: "unit" }),
  config,
  agents: (pm) => agentsBlock(pm, "unit"),
  gate,
  matrix,
  coverage,
  queue,
  // An example release commit; readers take the real one from the release they reviewed.
  pinned: () =>
    [
      "      - id: testnotary",
      `        uses: ${ACTION_REF.split("@")[0]}@3f9c1e7a2b4d6f8e0a1c3e5b7d9f2a4c6e8b0d1f # v1.4.2`,
      "        with:",
      "          suite: unit",
    ].join("\n"),
  "kill-switch": () => workflowHeader({ suite: "unit" }).slice(-2).join("\n"),
  login,
  "first-run": firstRun,
};

export function snippet(name: string, pm: PackageManagerName): string {
  const build = SNIPPETS[name];
  if (!build) throw new Error(`unknown docs snippet ${JSON.stringify(name)}`);
  return build(pm);
}

/** How GitHub lists the check run in a pull request's checks: `<workflow> / Testnotary / <suite> (<event>)`. */
export function checkLabel(suite: string, event: string, workflow = "CI"): string {
  return `${workflow} / Testnotary / ${suite} (${event})`;
}
