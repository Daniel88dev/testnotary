// Service errors go to Sentry when the server process has started it (see `boot.ts`); otherwise,
// as in the in-process test service, reporting does nothing. The reporter lives on `globalThis`
// because Next.js bundles `instrumentation.ts` and the route handlers separately, so they do not
// share module state.

export type ErrorReporter = (error: unknown, context?: Record<string, unknown>) => void;

const REPORTER = Symbol.for("testnotary.errorReporter");

type WithReporter = typeof globalThis & { [REPORTER]?: ErrorReporter };

export function setErrorReporter(reporter: ErrorReporter | undefined): void {
  (globalThis as WithReporter)[REPORTER] = reporter;
}

/** Reports an error the service handled but someone must hear about (the request still gets an answer). */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  (globalThis as WithReporter)[REPORTER]?.(error, context);
}
