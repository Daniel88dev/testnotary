import { LINKS, accountName, mismatchesPageUrl, runPageUrl, resolveServiceUrl, type FallbackReason, type JobOutcome, type VerificationResult } from "./shared.ts";
import type { RunnerEnv } from "./runner.ts";
import { isFallbackReason, type Verdict } from "./verify.ts";

// The one place that turns a job's verdict (and its tests, when they ran) into what the job shows:
// the PR line (the check run's `output.title` and the job summary's headline), the summary below
// it, the check run's conclusion and the step's outputs. Later tickets add their lines here:
// a reason's explanation in REASON_LINES, a new result in `headline`, a new conclusion in
// `conclusion`.

/** How the tests went when the step ran them through `exec`. */
export interface TestsRan {
  outcome: JobOutcome;
  /** The tests' own exit code; the step exits with it. */
  exitCode: number;
  /** The test command's wall-clock duration. */
  durationMs: number;
  /**
   * Whether the service recorded a mismatch from the job report (and so sent the repo back to
   * shadow mode); false when it recorded none, or the report never reached it.
   */
  mismatch: boolean;
}

export type Conclusion = "success" | "neutral" | "failure";

export interface JobPresentation {
  /** One line: the check run's `output.title`, and the job summary's headline. */
  line: string;
  /** Markdown under the line: the check run's `output.summary` and the rest of the job summary. */
  details: string;
  conclusion: Conclusion;
  /** `result`, `reason` and `ran`, as the step sets them. */
  outputs: { result: VerificationResult; reason: string; ran: string };
}

/**
 * What each fallback reason means, in the words the line uses after its code. `token_rejected`
 * never says which check failed (the service logs it). Adding a reason code makes this table
 * fail to typecheck until the reason has its words.
 */
export const REASON_LINES: Record<FallbackReason, string> = {
  disabled: "TESTNOTARY_DISABLED is true",
  host_not_supported: "v1 serves github.com only",
  no_oidc_token: "the job has no OIDC token",
  service_unreachable: "the service could not be reached",
  service_error: "the service answered with an error",
  timeout: "the service did not answer within 10 s",
  repo_not_installed: "the Testnotary GitHub App is not installed on this repo",
  token_rejected: "the service did not accept the job's OIDC token",
  github_denied: "GitHub refused the service's request",
  unknown_suite: "testnotary.json on the base branch declares no such suite",
  no_attestation: "no passing run attested this tree",
  attestation_expired: "the attested run ended 24 hours ago or more",
  attestation_revoked: "the attestation's token was revoked, blocked or expired",
  attester_no_write: "the attester no longer has write access",
  command_changed: "the attested command differs from testnotary.json on the base branch",
  guarded_file_changed: "the pull request changes a guarded file",
  signature_missing: "the repo requires signatures and the attestation has none",
  signature_invalid: "the attestation's signature did not pass the signature check",
  github_unavailable: "GitHub could not be asked",
  audit: "drawn for an audit",
};

/** Turns the verdict and the tests (null: they did not run) into the line, details, conclusion and outputs. */
export function presentJob(env: RunnerEnv, verdict: Verdict, tests: TestsRan | null): JobPresentation {
  const parts = [headline(verdict, tests), ...attestedBy(verdict), ...testsPart(verdict, tests)];
  return {
    line: oneLine(parts.join(" · ")),
    details: details(env, verdict, tests),
    conclusion: conclusion(verdict, tests),
    outputs: { result: verdict.result, reason: verdict.reason ?? "", ran: String(tests !== null) },
  };
}

/**
 * A mismatch: CI's tests failed on a tree an attestation said passed, on an audit or on a shadow
 * *would skip*. A refused `exec` ran no tests, so it is none; nor is a cancelled job, which never
 * gets here.
 */
export function isMismatch(verdict: Verdict, tests: TestsRan | null): boolean {
  return tests?.outcome === "failed" && (verdict.result === "audit" || verdict.result === "would_skip");
}

/**
 * `failure` for a mismatch, the only thing Testnotary fails; `success` for a skip, an audit whose
 * tests passed, or a run the attestation would have skipped; `neutral` for a fallback.
 */
function conclusion(verdict: Verdict, tests: TestsRan | null): Conclusion {
  if (isMismatch(verdict, tests)) return "failure";
  switch (verdict.result) {
    case "skip":
    case "would_skip":
      return "success";
    case "audit":
      return tests?.outcome === "passed" ? "success" : "neutral";
    case "fallback":
    case "would_fall_back":
      return "neutral";
  }
}

function headline(verdict: Verdict, tests: TestsRan | null): string {
  const attestation = verdict.record?.attestation;
  const age = attestation && verdict.record ? `${verdict.record.suite ?? "the suite"} passed ${ago(attestation.endedAt, verdict.record.createdAt)}` : "";
  const mismatch = isMismatch(verdict, tests);
  switch (verdict.result) {
    case "skip":
      return `Skipped · ${age}`;
    case "would_skip":
      return `${mismatch ? "Mismatch: would have skipped" : "Would have skipped"} · ${age}`;
    case "fallback":
      return `Fell back: ${reason(verdict)}`;
    case "would_fall_back":
      return `Would have fallen back: ${reason(verdict)}`;
    case "audit":
      return `${mismatch ? "Mismatch: the audit failed" : "Audit"} · ${age}`;
  }
}

/** The code, what it names in brackets, then its words; a code this action has no words for (a newer one) stands alone. */
function reason(verdict: Verdict): string {
  const code = verdict.reason ?? "service_error";
  const words = isFallbackReason(code) ? `, ${REASON_LINES[code]}` : "";
  return `${code}${verdict.detail ? ` (${verdict.detail})` : ""}${words}`;
}

/** For a skip, an audit or *would skip*: who attested, with which token, on what platform and Node. */
function attestedBy(verdict: Verdict): string[] {
  const attestation = verdict.record?.attestation;
  if (!attestation || (verdict.result !== "skip" && verdict.result !== "would_skip" && verdict.result !== "audit")) return [];
  const { account, token } = attestation.attester;
  const who = accountName(account);
  const parts =
    token.kind === "sandbox" ? [`sandbox token "${token.name}", created by ${who}`] : [`attested by ${who}`, `laptop token "${token.name}"`];
  const environment = attestation.run.environment;
  if (environment) parts.push(`${environment.os}/${environment.arch}`, `Node ${environment.node.replace(/^v/, "")}`);
  const session = attestation.run.session;
  if (session) parts.push(`agent ${session.vendor} (unverified)`);
  return parts;
}

function testsPart(verdict: Verdict, tests: TestsRan | null): string[] {
  if (!tests) return [];
  const shadow = verdict.result === "would_skip" || verdict.result === "would_fall_back" ? "shadow mode: " : "";
  const parts = [`${shadow}${testsPhrase(tests)}`];
  if (verdict.result === "audit" && tests.mismatch) parts.push("the repo is back in shadow mode");
  return parts;
}

function testsPhrase(tests: TestsRan): string {
  const took = duration(tests.durationMs);
  if (tests.outcome === "passed") return `the tests passed in ${took}`;
  if (tests.outcome === "refused") return `exec refused to start the tests (exit code ${tests.exitCode})`;
  return `the tests failed in ${took} (exit code ${tests.exitCode})`;
}

function details(env: RunnerEnv, verdict: Verdict, tests: TestsRan | null): string {
  const lines = [`- Result: \`${verdict.result}\``];
  if (verdict.reason) lines.push(`- Reason: \`${verdict.reason}\``);
  if (verdict.githubMessage) {
    lines.push(`- GitHub said: ${escape(oneLine(verdict.githubMessage))}`);
    lines.push(`- Testnotary has no fixed IP addresses, so GitHub IP allow lists are not supported in v1. See [Limits in v1](${LINKS.githubEnterpriseLimits}).`);
  }
  lines.push(`- Tests: ${tests ? escape(testsPhrase(tests)) : "not run in this step"}`);
  const record = verdict.record;
  if (record?.attestation) {
    const url = runPageUrl(resolveServiceUrl(env), record.repository.fullName, record.attestation.run.id);
    lines.push(`- Attested run: [${escape(record.attestation.run.id)}](${url})`);
    const session = record.attestation.run.session;
    if (session) lines.push(`- Agent session (unverified): ${sessionLabels(session)}`);
  }
  if (record) lines.push(`- Verification: \`${record.id}\``);
  if (record && isMismatch(verdict, tests)) lines.push(`- Mismatch: ${mismatchDetail(env, verdict, tests!)}`);
  return lines.join("\n");
}

/** What happened about a mismatch, and where an admin explains it. Nothing is revoked and no other repo changes. */
function mismatchDetail(env: RunnerEnv, verdict: Verdict, tests: TestsRan): string {
  const record = verdict.record!;
  if (!tests.mismatch) return "the job report did not reach the service, so no mismatch was recorded.";
  const attester = record.attestation?.attester;
  const against = attester ? ` against ${escape(accountName(attester.account))} and ${attester.token.kind} token "${escape(oneLine(attester.token.name))}"` : "";
  const mode = verdict.result === "audit" ? " The repo is back in shadow mode until an admin switches enforce on again." : "";
  const url = mismatchesPageUrl(resolveServiceUrl(env), record.repository.fullName);
  return `recorded${against}.${mode} Nothing was revoked. Explain it on the [Mismatches](${url}) page.`;
}

/**
 * The labels the run uploaded about its agent session. Anything can set them, so none is trusted
 * with Markdown: the URL sits in a code span, which GitHub never turns into a link.
 */
function sessionLabels(session: { vendor: string; id: string | null; url: string | null }): string {
  const parts = [escape(oneLine(session.vendor))];
  if (session.id) parts.push(`session ${escape(oneLine(session.id))}`);
  if (session.url) parts.push(`\`${oneLine(session.url).replace(/`/g, "")}\``);
  return parts.join(", ");
}

/** `just now`, `9 min ago`, `3 h ago`, `25 h ago`. */
function ago(from: string, to: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 60_000));
  if (minutes < 1) return "under a minute ago";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** The line is one line whatever a token name or login holds. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1000);
}

/**
 * Markdown-inert text for the job summary: no links, HTML, code or emphasis from a token name or
 * login. Underscores inside words (reason codes) are not emphasis in GitHub's Markdown, so they
 * stay as they are.
 */
export function escape(text: string): string {
  return text.replace(/[\\`*[\]<>|]|(?<!\w)_|_(?!\w)/g, (c) => `\\${c}`);
}
