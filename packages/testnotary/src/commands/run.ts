// `testnotary run [suite]`: runs a suite from the base branch's testnotary.json in the stripped
// environment and uploads one record for every outcome; a pass yields an attestation for the tree
// it tested.
import { UsageError, parseCommandArgs, type Command } from "../command.ts";
import { finish, say, type RunReport } from "../report.ts";
import { AFTER_RUN } from "../run/checks/index.ts";
import type { RunContext } from "../run/context.ts";
import { runEnvironment } from "../run/environment.ts";
import { prepareRun, type Ready, type RefusedBeforeStart } from "../run/prepare.ts";
import { upload } from "../run/service.ts";
import {
  ATTESTATION_FORMAT_V1,
  baselineOverrides,
  encodeAttestationPayload,
  resolveServiceUrl,
  runPageUrl,
  type AttestationPayload,
  type CompletedRunUpload,
  type RefusalCode,
} from "../shared.ts";
import { signAttestation } from "../run/sign.ts";
import { displayArgv, runSuiteCommand } from "../suite-command.ts";

export const run: Command = {
  name: "run",
  usage: "run [suite] [--base <branch>] [--json]",
  summary: "Run a suite from the base branch's testnotary.json and attest the tree when it passes.",
  async run(args, context) {
    const { flags, options, positionals, afterTerminator } = parseCommandArgs(args, [], ["base"]);
    if (positionals.length > 1) throw new UsageError(`unexpected argument ${JSON.stringify(positionals[1])}`);
    const serviceUrl = resolveServiceUrl(context.env);
    const json = flags.json;

    const prepared = await prepareRun({
      cwd: context.cwd,
      env: context.env,
      serviceUrl,
      suite: positionals[0],
      base: options.base,
      extraArguments: afterTerminator,
    });
    if (prepared.kind === "refused") return refuseBeforeStart(prepared, serviceUrl, json);
    return runSuite(prepared, json);
  },
};

function report(fields: Partial<RunReport> & Pick<RunReport, "outcome" | "suite">): RunReport {
  return { refusal: null, exitCode: null, attested: false, attestationUrl: null, tree: null, commit: null, durationMs: 0, warnings: [], ...fields };
}

async function refuseBeforeStart(refused: RefusedBeforeStart, serviceUrl: string, json: boolean): Promise<number> {
  for (const line of refused.lines) say(line);
  if (refused.upload && refused.repository) {
    // Only the code, the tree and the commit: nothing else about a refused run leaves the machine.
    await upload(serviceUrl, refused.token, {
      repository: refused.repository,
      outcome: "refused",
      refusal: refused.refusal,
      tree: refused.checkout?.tree ?? null,
      commit: refused.checkout?.commit ?? null,
    });
  }
  return finish(
    report({
      outcome: "refused",
      suite: refused.suite ?? "",
      refusal: refused.refusal,
      tree: refused.checkout?.tree ?? null,
      commit: refused.checkout?.commit ?? null,
      warnings: refused.notes.warnings,
    }),
    { json },
  );
}

async function runSuite(ready: Ready, json: boolean): Promise<number> {
  const { context } = ready;
  const { suite, checkout } = context;
  say(`run ${suite.name}: ${displayArgv(suite.command)}`);
  const startedAt = new Date();
  const result = await runSuiteCommand({ suite, cwd: context.root, shell: context.env, stdoutToStderr: json });
  const endedAt = new Date();

  const refuseAfterStart = async (refusal: RefusalCode, lines: string[], exitCode: number | null, durationMs: number): Promise<number> => {
    for (const line of lines) say(line);
    if (ready.preflight.kind === "ok") {
      await upload(context.serviceUrl, context.token, {
        repository: ready.preflight.answer.repository.fullName,
        outcome: "refused",
        refusal,
        tree: checkout.tree,
        commit: checkout.commit,
      });
    }
    return finish(
      report({ outcome: "refused", suite: suite.name, refusal, exitCode, tree: checkout.tree, commit: checkout.commit, durationMs, warnings: context.notes.warnings }),
      { json },
    );
  };

  if (result.kind === "command_not_found") {
    return refuseAfterStart(
      "command_not_found",
      [`${result.program} was not found${result.program.includes("/") ? "" : " on PATH"}; install it, or point the command at a package.json script`],
      null,
      0,
    );
  }
  if (result.interrupted) {
    return refuseAfterStart(
      "interrupted",
      [`interrupted (Ctrl-C was passed to the command, which exited with ${result.exitCode}), so nothing is attested`],
      result.exitCode,
      result.durationMs,
    );
  }
  for (const check of AFTER_RUN) {
    const found = await check.check(context);
    if (found) return refuseAfterStart(found.refusal, found.lines, result.exitCode, result.durationMs);
  }

  const passed = result.exitCode === 0;
  say(passed ? `suite ${suite.name} passed` : `suite ${suite.name} failed with exit code ${result.exitCode}`);
  let attested = false;
  let attestationUrl: string | null = null;
  if (ready.preflight.kind === "ok") {
    const { record, payload } = completedRecord(context, ready.preflight.answer, {
      outcome: passed ? "passed" : "failed",
      exitCode: result.exitCode,
      startedAt,
      endedAt,
      durationMs: result.durationMs,
    });
    if (record.attestation && payload && context.config.signatures === "required") {
      const signature = await signAttestation(context, payload, record.attestation.payload);
      // Unsigned, `no_signing_key` is already in `record.warnings` (the run's own list).
      if (signature) record.attestation.signature = signature;
    }
    const stored = await upload(context.serviceUrl, context.token, record);
    if (stored.kind === "stored" && stored.attestationId) {
      attested = true;
      attestationUrl = runPageUrl(context.serviceUrl, record.repository, stored.runId);
      say(`attested: ${attestationUrl}`);
    } else if (stored.kind === "failed") {
      context.notes.warnings.push("upload_failed");
      say(`the run could not be uploaded (${stored.reason}), so nothing was attested`);
    }
  }
  return finish(
    report({
      outcome: passed ? "passed" : "failed",
      suite: suite.name,
      exitCode: result.exitCode,
      attested,
      attestationUrl,
      tree: checkout.tree,
      commit: checkout.commit,
      durationMs: result.durationMs,
      warnings: context.notes.warnings,
    }),
    { json },
  );
}

/** The record "What a run uploads" lists, and for a pass the canonical attestation payload. */
function completedRecord(
  context: RunContext,
  seen: Extract<Ready["preflight"], { kind: "ok" }>["answer"],
  run: { outcome: "passed" | "failed"; exitCode: number; startedAt: Date; endedAt: Date; durationMs: number },
): { record: CompletedRunUpload; payload: AttestationPayload | undefined } {
  const { suite, checkout, notes } = context;
  const endedAt = run.endedAt.toISOString();
  const record: CompletedRunUpload = {
    repository: seen.repository.fullName,
    outcome: run.outcome,
    suite: suite.name,
    tree: checkout.tree,
    commit: checkout.commit,
    command: suite.command,
    exitCode: run.exitCode,
    startedAt: run.startedAt.toISOString(),
    endedAt,
    durationMs: run.durationMs,
    environment: runEnvironment(suite, notes),
    session: notes.session,
    passedEnv: suite.env.pass,
    guardedMatched: notes.guardedMatched,
    warnings: notes.warnings,
    notPinned: notes.notPinned,
    baselineOverrides: baselineOverrides(suite.env) as CompletedRunUpload["baselineOverrides"],
  };
  if (run.outcome !== "passed") return { record, payload: undefined };
  const payload: AttestationPayload = {
    format: ATTESTATION_FORMAT_V1,
    repository: seen.repository.id,
    suite: suite.name,
    command: suite.command,
    tree: checkout.tree,
    commit: checkout.commit,
    outcome: "passed",
    attester: { account: seen.account.id, token: seen.token.id, tokenKind: seen.token.kind },
    endedAt,
  };
  record.attestation = { payload: encodeAttestationPayload(payload) };
  return { record, payload };
}
