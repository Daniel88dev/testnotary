// Next.js calls `register` once per server process, before the first request.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { boot } = await import("./src/server/boot.ts");
    await boot();
  }
}
