import { serviceConfig, type LogEntry } from "./config.ts";

// The service's own log (see `ServiceConfig.log`): for what the service handled on purpose but an
// operator may need to see, such as why a token was rejected. Errors go to Sentry through
// `reportError` instead. Never log a secret, a token's value, an IP address or anything joined to
// an account.

export type { LogEntry } from "./config.ts";

/** Writes one entry to the service's log. */
export function logEvent(entry: LogEntry): void {
  serviceConfig().log(entry);
}
