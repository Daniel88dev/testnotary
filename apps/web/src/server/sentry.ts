import * as Sentry from "@sentry/nextjs";
import { setErrorReporter } from "./errors.ts";

/**
 * Starts Sentry for the server when `SENTRY_DSN` is set. Errors only: no tracing, no sessions, no
 * browser SDK, and nothing that identifies a person. Request headers, cookies, bodies and query
 * strings are dropped from every event, because they carry tokens and session cookies.
 */
export function startSentry(env: Readonly<Record<string, string | undefined>>): boolean {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    release: env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
    },
    // A second guard: whatever an integration attaches, nothing from the request leaves.
    beforeSend(event) {
      if (event.request) {
        delete event.request.headers;
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.query_string;
      }
      delete event.user;
      return event;
    },
    beforeBreadcrumb: (breadcrumb) => (breadcrumb.category === "http" ? null : breadcrumb),
  });
  setErrorReporter((error, context) => {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  });
  return true;
}

/** Waits for queued events to be sent, before a process that failed to start exits. */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  await Sentry.flush(timeoutMs);
}

export const captureRequestError = Sentry.captureRequestError;
