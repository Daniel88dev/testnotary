// The action's entry point. The runner starts the release bundle of this file (see action.yml);
// tests start the source as a process with a simulated runner environment.
import { command, input, setOutputs } from "./runner.ts";
import { verifyJob } from "./verify.ts";

const env = process.env;
const mode = input(env, "mode") || "run";
const suite = input(env, "suite") || null;

if (mode === "verify") {
  // The gate job: verify only, on any runner, with no checkout or install. `skip` is true only for
  // a skip in enforce mode; the test job runs unless it is.
  const outcome = await verifyJob(env, suite);
  setOutputs(env, {
    result: outcome.result,
    reason: outcome.reason ?? "",
    ran: "false",
    skip: String(outcome.result === "skip"),
    verification: outcome.verification ?? "",
  });
  process.stdout.write(`Testnotary: ${outcome.result}${outcome.reason ? ` (${outcome.reason})` : ""}\n`);
  process.exitCode = 0;
} else if (mode === "run") {
  // Run mode (verify, then skip or run the suite) and the report arrive with T-819.
  process.exitCode = 0;
} else {
  command("error", `Testnotary: mode must be "run" or "verify", not ${JSON.stringify(mode)}.`);
  process.exitCode = 1;
}
