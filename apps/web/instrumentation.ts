import type { Instrumentation } from "next";

// Next.js calls `register` once per server process, before the first request. The service runs
// on Node.js only; nothing is registered for the edge runtime.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { boot } = await import("./src/server/boot.ts");
    await boot();
  }
}

// Errors a route handler, server component or server action throws go to Sentry (when started).
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureRequestError } = await import("./src/server/sentry.ts");
  captureRequestError(...args);
};
