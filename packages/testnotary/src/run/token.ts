import { readStoredToken } from "../credentials.ts";
import { sandboxMarker } from "../sandbox.ts";
import type { Env, RunToken } from "./context.ts";

/**
 * The token a run sends: `TESTNOTARY_TOKEN` exactly as it is when set; otherwise, outside a
 * sandbox, the laptop token kept by `login`; otherwise none. (Refusing a laptop token inside a
 * sandbox is a check of its own, T-823's `laptop_token_in_sandbox`.)
 */
export async function chooseToken(serviceUrl: string, env: Env): Promise<RunToken | undefined> {
  if (env.TESTNOTARY_TOKEN) return { value: env.TESTNOTARY_TOKEN, source: "env" };
  if (sandboxMarker(env)) return undefined;
  const stored = await readStoredToken(serviceUrl, env);
  return stored ? { value: stored, source: "stored" } : undefined;
}
