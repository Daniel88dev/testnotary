import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface HttpServer {
  url: string;
  close(): Promise<void>;
}

/** A handler's answer that closes the connection without a response: the client sees a connection error. */
export const DROP_CONNECTION = Symbol("drop the connection");

type Handler = (request: Request) => Promise<Response | typeof DROP_CONNECTION>;

/**
 * Serves fetch-style handlers on 127.0.0.1 and an ephemeral port. A request's `signal` aborts when
 * the client hangs up before the answer.
 */
export async function serve(handler: Handler): Promise<HttpServer> {
  const server = createServer((req, res) => {
    void handle(req, res, handler);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => close(server) };
}

async function handle(req: IncomingMessage, res: ServerResponse, handler: Handler): Promise<void> {
  const hangUp = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) hangUp.abort();
  });
  try {
    const response = await handler(await toRequest(req, hangUp.signal));
    if (response === DROP_CONNECTION) {
      req.socket.destroy();
      return;
    }
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") res.setHeader(key, value);
    });
    // Each cookie is its own header: setHeader per entry would keep only the last one.
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

async function toRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method: req.method, headers, body, signal });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
