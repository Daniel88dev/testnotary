// A stand-in action entry for the harness's own tests: asks the runner for an OIDC token the way
// the real action will, and reports what it got through the step's output and summary files.
import { appendFileSync } from "node:fs";

const env = process.env;
const output = env.GITHUB_OUTPUT!;
const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;

if (!requestUrl) {
  appendFileSync(output, "token=none\n");
} else {
  const response = await fetch(`${requestUrl}&audience=${encodeURIComponent("https://testnotary.dev")}`, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  const { value } = (await response.json()) as { value: string };
  appendFileSync(output, `token<<EOF\n${value}\nEOF\n`);
}
appendFileSync(output, `service=${env.TESTNOTARY_URL}\n`);
appendFileSync(env.GITHUB_STEP_SUMMARY!, `Ran on ${env.GITHUB_EVENT_NAME} at ${env.GITHUB_SHA}\n`);
