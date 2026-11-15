import { glob } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { withServiceConfig, type ServiceConfig } from "@testnotary/web/config";
import { closeDatabase } from "@testnotary/web/db";
import { matchPath } from "./github/router.ts";
import { DROP_CONNECTION, serve, type HttpServer } from "./http.ts";
import { paths } from "./paths.ts";

/** One request that reached the service, exactly as sent: for asserting on what left a machine. */
export interface ServiceRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The raw body text ("" for GET). */
  text: string;
  /** ms since the epoch, real time. */
  at: number;
  /** ms since the epoch on the world clock (the service's time) when the request arrived. */
  clockAt: number;
}

/**
 * Answers a request instead of the service (`world.service.override`): a Response, `"drop"` to
 * close the connection without one, which the client sees as a connection error, or undefined to
 * let the service answer after all (say, from the second call on).
 */
export type ServiceOverride = (request: Request) => ServiceOverrideAnswer | Promise<ServiceOverrideAnswer>;
type ServiceOverrideAnswer = Response | "drop" | undefined;

interface MountedOverride {
  method: string;
  path: string;
  handle: ServiceOverride;
}

/** The in-process service's overrides, newest first; each `add` returns its removal. */
export class ServiceOverrides {
  private readonly entries: MountedOverride[] = [];

  add(method: string, path: string, handle: ServiceOverride): () => void {
    const entry = { method, path, handle };
    this.entries.unshift(entry);
    return () => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    };
  }

  find(method: string, pathname: string): ServiceOverride | undefined {
    return this.entries.find((entry) => entry.method === method && matchPath(entry.path, pathname))?.handle;
  }
}

type Handler =(request: Request, context: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
type RouteModule = Partial<Record<string, Handler>>;

interface MountedRoute {
  pattern: RegExp;
  names: string[];
  module: RouteModule;
}

/**
 * The service's real route handlers (every `app/api/**\/route.ts` of the web app), served in this
 * process without Next.js. New routes are picked up automatically. Each request runs under this
 * world's config, so the handlers talk to this world's database and fake GitHub.
 */
export async function startInProcessService(
  config: ServiceConfig,
  requests: ServiceRequest[] = [],
  overrides: ServiceOverrides = new ServiceOverrides(),
): Promise<HttpServer> {
  const routes = await mountRoutes();
  const server = await serve(async (request) => {
    const { pathname } = new URL(request.url);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    const at = Date.now();
    requests.push({ method: request.method, path: pathname, headers: Object.fromEntries(request.headers), text, at, clockAt: config.now?.().getTime() ?? at });
    const override = overrides.find(request.method, pathname);
    const answer = await override?.(request);
    if (answer === "drop") return DROP_CONNECTION;
    if (answer) return answer;
    for (const route of routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const handler = route.module[request.method];
      if (!handler) return new Response(null, { status: 405 });
      const params: Record<string, string | string[]> = {};
      route.names.forEach((name, index) => {
        const raw = match[index + 1] ?? "";
        if (name.startsWith("...")) params[name.slice(3)] = raw.split("/").map(decodeURIComponent);
        else params[name] = decodeURIComponent(raw);
      });
      return withServiceConfig(config, () => handler(request, { params: Promise.resolve(params) }));
    }
    return new Response(null, { status: 404 });
  });
  return {
    url: server.url,
    async close() {
      await server.close();
      if (config.databaseUrl) await closeDatabase(config.databaseUrl);
    },
  };
}

let mounted: Promise<MountedRoute[]> | undefined;

function mountRoutes(): Promise<MountedRoute[]> {
  mounted ??= (async () => {
    const routes: MountedRoute[] = [];
    for await (const file of glob("app/api/**/route.ts", { cwd: paths.webApp })) {
      const segments = file.split("/").slice(1, -1).filter((segment) => !/^\(.*\)$/.test(segment));
      const names: string[] = [];
      const source = segments
        .map((segment) => {
          const dynamic = /^\[(\.\.\.)?(\w+)\]$/.exec(segment);
          if (!dynamic) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          names.push(dynamic[1] ? `...${dynamic[2]}` : dynamic[2]!);
          return dynamic[1] ? "(.+)" : "([^/]+)";
        })
        .join("/");
      const module = (await import(pathToFileURL(`${paths.webApp}/${file}`).href)) as RouteModule;
      routes.push({ pattern: new RegExp(`^/${source}/?$`), names, module });
    }
    // Static segments win over dynamic ones, as in Next.js.
    return routes.sort((a, b) => a.names.length - b.names.length);
  })();
  return mounted;
}
