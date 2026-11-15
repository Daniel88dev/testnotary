import { hasSecretReferences, resolveSecretReferences, secretsManagerStore } from "./secrets.ts";

/**
 * Runs once when the server process starts, before it handles a request (Next.js calls it from
 * `instrumentation.ts`). Replaces every secret reference in the environment with its value, so
 * `configFromEnv` sees plain settings. A secret that cannot be read stops the server from starting.
 */
export async function boot(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (hasSecretReferences(env)) {
    Object.assign(env, await resolveSecretReferences(env, await secretsManagerStore()));
  }
}
