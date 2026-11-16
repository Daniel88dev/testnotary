// Everything before a run starts its command: find the repo, base config and suite, choose the
// token, run the refusal checks, then ask the service. `run` calls this and then starts the
// command; `check` (T-816) calls it and stops.
import { LINKS, type RefusalCode } from "../shared.ts";
import { say } from "../report.ts";
import { BEFORE_START, WARNINGS } from "./checks/index.ts";
import { laptopTokenMarker } from "./checks/laptop-token-in-sandbox.ts";
import { emptyNotes, warn, type Env, type RunContext, type RunNotes, type RunToken } from "./context.ts";
import { guardedGlobsMatched } from "./guarded.ts";
import { locate } from "./locate.ts";
import { preflight, type Preflight } from "./service.ts";
import { detectSession } from "./session.ts";
import { chooseToken } from "./token.ts";

export interface PrepareInput {
  cwd: string;
  env: Env;
  serviceUrl: string;
  suite: string | undefined;
  base: string | undefined;
  extraArguments: string[];
}

/** The run may start. `preflight` says whether its upload can attest. */
export interface Ready {
  kind: "ready";
  context: RunContext;
  preflight: Exclude<Preflight, { kind: "refused" }>;
}

/** The run is refused before the start. */
export interface RefusedBeforeStart {
  kind: "refused";
  refusal: RefusalCode;
  lines: string[];
  suite: string | undefined;
  checkout: { commit: string; tree: string } | undefined;
  /** `owner/name`, when known: a refused run is uploaded only then. */
  repository: string | undefined;
  token: RunToken | undefined;
  notes: RunNotes;
  /** False when the service itself said no: there is nothing to upload to. */
  upload: boolean;
}

export async function prepareRun(input: PrepareInput): Promise<Ready | RefusedBeforeStart> {
  const notes = emptyNotes();
  notes.session = detectSession(input.env);
  const found = await locate(input);
  const token = await chooseToken(input.serviceUrl, input.env);
  if ("refused" in found) {
    const { refusal, lines, partial } = found.refused;
    // A laptop token inside a sandbox is never sent, not even with a refused run.
    const upload = !laptopTokenMarker(token, input.env);
    return { kind: "refused", refusal, lines, suite: input.suite, checkout: partial.checkout, repository: partial.repository, token, notes, upload };
  }
  const { located } = found;
  const context: RunContext = {
    cwd: input.cwd,
    env: input.env,
    serviceUrl: input.serviceUrl,
    ...located,
    extraArguments: input.extraArguments,
    token,
    notes,
  };
  const refused = (refusal: RefusalCode, lines: string[], upload = true): RefusedBeforeStart => ({
    kind: "refused",
    refusal,
    lines,
    suite: context.suite.name,
    checkout: context.checkout,
    repository: context.origin.repository,
    token,
    notes,
    upload,
  });

  for (const check of BEFORE_START) {
    const found = await check.check(context);
    if (found) return refused(found.refusal, found.lines, found.upload ?? true);
  }
  for (const check of WARNINGS) await check.check(context);
  notes.guardedMatched = await guardedGlobsMatched(context);

  const repository = context.origin.repository;
  if (!repository) {
    return refused(
      "repo_not_installed",
      [`origin (${context.origin.url}) is not a repository on github.com, so no installation of the Testnotary App can cover it`],
      false,
    );
  }
  const answer = await preflight(input.serviceUrl, token, repository);
  switch (answer.kind) {
    case "ok": {
      const { account, token: seen } = answer.answer;
      say(`attesting as @${account.login} with ${seen.kind} token "${seen.name}"`);
      return { kind: "ready", context, preflight: answer };
    }
    case "refused":
      return refused(answer.refusal, preflightRefusalLines(answer.refusal, repository, token), false);
    case "not_signed_in":
      warn(
        context,
        "not_signed_in",
        `not signed in: the tests run, but nothing will be attested. Run \`testnotary login\`, or in an agent sandbox set TESTNOTARY_TOKEN to a sandbox token (${LINKS.sandboxTokens})`,
      );
      return { kind: "ready", context, preflight: answer };
    case "unreachable":
      warn(context, "service_unreachable", `the Testnotary service could not be reached (${answer.reason}): the tests run, but nothing will be attested`);
      return { kind: "ready", context, preflight: answer };
  }
}

function preflightRefusalLines(refusal: RefusalCode, repository: string, token: RunToken | undefined): string[] {
  switch (refusal) {
    case "token_rejected":
      return [
        token?.source === "env"
          ? "the service rejected TESTNOTARY_TOKEN (revoked or expired): create a new sandbox token, or unset it to use your laptop token"
          : `the service rejected this machine's laptop token for ${repository}: it was revoked or expired (run \`testnotary login\` again), or an admin of ${repository} blocked it there`,
      ];
    case "repo_not_installed":
      return [`the Testnotary GitHub App is not installed on ${repository}: install it on the repo, then run again`];
    case "no_write_access":
      return [`your GitHub account can't write to ${repository}, and only people with write access can attest for it`];
    default:
      return [];
  }
}
