// The action's entry point. The runner starts the release bundle of this file (see action.yml);
// tests start the source as a process with a simulated runner environment.
import { execSuite, suiteToRun } from "./exec.ts";
import { presentJob, type JobPresentation, type TestsRan } from "./pr-line.ts";
import { createCheckRun, writeSummary } from "./publish.ts";
import { sendJobReport } from "./report.ts";
import { checkSkip } from "./signature.ts";
import { appendSummary, command, input, setOutputs, type RunnerEnv } from "./runner.ts";
import { beforeTheService, readVerification, verifyJob, type Verdict } from "./verify.ts";

const env = process.env;
const mode = input(env, "mode") || "run";
const suite = input(env, "suite") || null;

if (mode === "verify") process.exitCode = await gate(env);
else if (mode === "run") process.exitCode = await run(env);
else {
  command("error", `Testnotary: mode must be "run" or "verify", not ${JSON.stringify(mode)}.`);
  process.exitCode = 1;
}

/**
 * The gate job: verify only, on any runner, with no checkout or install. `skip` is true only for a
 * skip in enforce mode; the test job runs unless it is. The gate makes the check run only for a
 * skip: otherwise the test job runs and makes it, with the tests' outcome.
 */
async function gate(env: RunnerEnv): Promise<number> {
  const verdict = await checkSkip(env, beforeTheService(env) ?? (await verifyJob(env, suite)), suite);
  const presentation = presentJob(env, verdict, null);
  setOutputs(env, { ...presentation.outputs, skip: String(verdict.result === "skip"), verification: verdict.record?.id ?? "" });
  await publish(env, verdict, presentation, { checkRun: verdict.result === "skip" });
  return 0;
}

/**
 * The inline shape: verify (or reuse a gate job's verification), then skip or run the suite
 * through the library's `exec`, report, and write the PR line. The step exits with the tests'
 * exit code; a skip exits 0.
 */
async function run(env: RunnerEnv): Promise<number> {
  if (env.RUNNER_OS === "Windows" || process.platform === "win32") {
    return setupError(env, "run mode does not support Windows runners. Run the tests on Linux or macOS, or use a gate job (mode: verify), which works on any runner.");
  }
  const verdict = await checkSkip(env, await verdictForJob(env), suite);
  if (verdict.result === "skip") {
    const presentation = presentJob(env, verdict, null);
    setOutputs(env, presentation.outputs);
    await publish(env, verdict, presentation, { checkRun: true });
    return 0;
  }

  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const suiteName = suiteToRun(workspace, suite, verdict.record?.suite);
  if (!suiteName) {
    setOutputs(env, { ...presentJob(env, verdict, null).outputs });
    return setupError(env, "name the suite with the `suite` input: the checked-out testnotary.json does not declare exactly one.");
  }
  const result = await execSuite(env, workspace, suiteName);
  if (result.kind === "library_not_found") {
    setOutputs(env, { ...presentJob(env, verdict, null).outputs });
    return setupError(
      env,
      `the testnotary library was not found with \`${result.command}\`. Add testnotary to devDependencies and install dependencies before this step. The tests did not run: the action never runs the suite's command outside the library's stripped environment.`,
    );
  }
  const ran = { outcome: result.outcome, exitCode: result.exitCode, durationMs: result.durationMs };
  const report = verdict.record ? await sendJobReport(env, verdict.record.id, ran) : undefined;
  const tests: TestsRan = { ...ran, mismatch: report?.mismatch ?? false };
  const presentation = presentJob(env, verdict, tests);
  setOutputs(env, presentation.outputs);
  await publish(env, verdict, presentation, { checkRun: true });
  return tests.exitCode;
}

/**
 * A fallback decided before the service; else a gate job's verification when the step is given one
 * it can read back; otherwise its own.
 */
async function verdictForJob(env: RunnerEnv): Promise<Verdict> {
  const early = beforeTheService(env);
  if (early) return early;
  const id = input(env, "verification");
  if (id) {
    const reused = await readVerification(env, id);
    if (reused) return reused;
    process.stdout.write("Testnotary: the gate job's verification could not be read back for this commit; verifying on its own\n");
  }
  return verifyJob(env, suite);
}

async function publish(env: RunnerEnv, verdict: Verdict, presentation: JobPresentation, options: { checkRun: boolean }): Promise<void> {
  const name = verdict.record?.suite ?? suite;
  process.stdout.write(`Testnotary: ${presentation.line}\n`);
  writeSummary(env, name, presentation);
  if (options.checkRun) await createCheckRun(env, name, presentation);
}

function setupError(env: RunnerEnv, message: string): number {
  command("error", `Testnotary: ${message}`);
  appendSummary(env, `### Testnotary\n\n**Setup error:** ${message}\n`);
  return 1;
}
