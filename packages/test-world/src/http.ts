import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface HttpServer {
  url: string;
  close(): Promise<void>;
}

/** Serves fetch-style handlers on 127.0.0.1 and an ephemeral port. */
export async function serve(handler: (request: Request) => Promise<Response>): Promise<HttpServer> {
  const server = createServer((req, res) => {
    void handle(req, res, handler);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => close(server) };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const response = await handler(await toRequest(req));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method: req.method, headers, body });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
