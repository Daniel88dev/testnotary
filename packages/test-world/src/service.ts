import { glob } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { withServiceConfig, type ServiceConfig } from "@testnotary/web/config";
import { closeDatabase } from "@testnotary/web/db";
import { serve, type HttpServer } from "./http.ts";
import { paths } from "./paths.ts";

type Handler = (request: Request, context: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
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
export async function startInProcessService(config: ServiceConfig): Promise<HttpServer> {
  const routes = await mountRoutes();
  const server = await serve(async (request) => {
    const { pathname } = new URL(request.url);
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
