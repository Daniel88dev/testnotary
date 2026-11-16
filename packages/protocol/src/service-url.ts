/** The path every API route lives under. */
export const API_V1 = "/api/v1";

/** The hosted service, built into the library and the action. */
export const DEFAULT_SERVICE_URL = "https://testnotary.dev";

/**
 * The service base URL a client talks to. `TESTNOTARY_URL` is an undocumented override for
 * development and the test world; everything else uses the hosted service.
 */
export function resolveServiceUrl(env: Readonly<Record<string, string | undefined>>): string {
  const override = env.TESTNOTARY_URL?.trim();
  return (override ? override : DEFAULT_SERVICE_URL).replace(/\/+$/, "");
}
