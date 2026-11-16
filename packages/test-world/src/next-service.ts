import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import type { HttpServer } from "./http.ts";
import { paths } from "./paths.ts";

/**
 * The whole web app (pages and API) under `next dev`, for Playwright. It gets the same world as the
 * in-process service: the world's database as the app role and the fake GitHub.
 */
export async function startNextService(env: Record<string, string>, port?: number): Promise<HttpServer> {
  port ??= await freePort();
  const child = spawn(
    process.execPath,
    [`${paths.webApp}/node_modules/next/dist/bin/next`, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: paths.webApp,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NEXT_TELEMETRY_DISABLED: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let log = "";
  // TESTNOTARY_WORLD_NEXT_LOG=<file>: also append the service's output there, for debugging a page.
  const logFile = process.env.TESTNOTARY_WORLD_NEXT_LOG;
  const record = (chunk: string) => {
    log += chunk;
    if (logFile) appendFileSync(logFile, chunk);
  };
  child.stdout.setEncoding("utf8").on("data", record);
  child.stderr.setEncoding("utf8").on("data", record);
  const url = `http://127.0.0.1:${port}`;

  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return;
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
  };

  const deadline = Date.now() + 120_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`next dev exited early:\n${log}`);
    if (/Ready in|✓ Ready/.test(log)) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`next dev did not become ready:\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Compile a page before any route handler. When `next dev` (16.4, Turbopack) compiles a route
  // handler first, every page it compiles afterwards keeps reloading itself in the browser
  // ("[Fast Refresh] rebuilding" in a loop), so a test that seeds through a webhook before its
  // first page view would never get a stable page.
  await fetch(`${url}/`).then((response) => response.arrayBuffer()).catch(() => undefined);
  return { url, close: stop };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}
