import { gunzipSync } from "node:zlib";
import { serve, type HttpServer } from "./http.ts";

export interface SentryEnvelope {
  path: string;
  header: Record<string, unknown>;
  items: { header: { type?: string } & Record<string, unknown>; payload: unknown }[];
}

/** The parts of a Sentry error event the tests read. */
export interface SentryEvent {
  event_id?: string;
  level?: string;
  environment?: string;
  release?: string;
  exception?: { values?: { type?: string; value?: string }[] };
  request?: { url?: string; method?: string; headers?: Record<string, string>; cookies?: unknown; data?: unknown };
  tags?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Sentry's ingest endpoint, local. A Sentry SDK given `dsn` sends its envelopes here (the real
 * transport, over HTTP), so a test sees exactly what would have reached sentry.io.
 */
export class FakeSentry {
  /** Every envelope received, in order, whatever its items. */
  readonly envelopes: SentryEnvelope[] = [];
  #server: HttpServer | undefined;
  #waiters = new Set<() => void>();

  static async start(): Promise<FakeSentry> {
    const fake = new FakeSentry();
    fake.#server = await serve((request) => fake.#handle(request));
    return fake;
  }

  /** A DSN for this endpoint: public key `world`, project `1`. */
  get dsn(): string {
    const { host } = new URL(this.#server!.url);
    return `http://world@${host}/1`;
  }

  /** The error events received so far. */
  get events(): SentryEvent[] {
    return this.envelopes.flatMap((envelope) =>
      envelope.items.filter((item) => item.header.type === "event").map((item) => item.payload as SentryEvent),
    );
  }

  /** Resolves with the first error event matching `predicate`, waiting for it up to `timeoutMs`. */
  async waitForEvent(predicate: (event: SentryEvent) => boolean = () => true, timeoutMs = 15_000): Promise<SentryEvent> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const found = this.events.find(predicate);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`no matching Sentry event within ${timeoutMs} ms; received: ${JSON.stringify(this.events)}`);
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.#waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.#waiters.add(wake);
      });
    }
  }

  close(): Promise<void> {
    return this.#server?.close() ?? Promise.resolve();
  }

  async #handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    let body = Buffer.from(await request.arrayBuffer());
    if (request.headers.get("content-encoding") === "gzip") body = gunzipSync(body);
    this.envelopes.push({ path: pathname, ...parseEnvelope(body) });
    for (const wake of [...this.#waiters]) wake();
    return Response.json({ id: "0".repeat(32) });
  }
}

/** Sentry's envelope format: a header line, then per item a header line and its payload. */
function parseEnvelope(body: Buffer): Omit<SentryEnvelope, "path"> {
  let offset = 0;
  const line = (): Buffer => {
    const end = body.indexOf(0x0a, offset);
    const slice = body.subarray(offset, end === -1 ? body.length : end);
    offset = end === -1 ? body.length : end + 1;
    return slice;
  };
  const header = JSON.parse(line().toString("utf8")) as Record<string, unknown>;
  const items: SentryEnvelope["items"] = [];
  while (offset < body.length) {
    const raw = line();
    if (raw.length === 0) continue;
    const itemHeader = JSON.parse(raw.toString("utf8")) as SentryEnvelope["items"][number]["header"];
    let payload: Buffer;
    if (typeof itemHeader.length === "number") {
      payload = body.subarray(offset, offset + itemHeader.length);
      offset += itemHeader.length + 1;
    } else {
      payload = line();
    }
    const text = payload.toString("utf8");
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Attachments and other binary items stay as text.
    }
    items.push({ header: itemHeader, payload: parsed });
  }
  return { header, items };
}
