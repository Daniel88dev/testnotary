import { reportError } from "./errors.ts";
import { hasSecretReferences, resolveSecretReferences, secretsManagerStore } from "./secrets.ts";
import { flushSentry, startSentry } from "./sentry.ts";

/**
 * Runs once when the server process starts, before it handles a request (Next.js calls it from
 * `instrumentation.ts`). Starts Sentry, then replaces every secret reference in the environment
 * with its value, so `configFromEnv` sees plain settings. A secret that cannot be read is reported
 * and stops the server from starting.
 */
export async function boot(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const sentry = startSentry(env);
  try {
    if (hasSecretReferences(env)) {
      Object.assign(env, await resolveSecretReferences(env, await secretsManagerStore()));
    }
  } catch (error) {
    reportError(error);
    if (sentry) await flushSentry();
    throw error;
  }
}
