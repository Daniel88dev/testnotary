import { serviceConfig } from "./config.ts";

// Helpers for routes a browser posts plain HTML forms to (sign-in, sign-out): no JavaScript needed.

/** A path inside this site to go to next; anything else (another origin, `//host`) becomes `fallback`. */
export function localPath(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

/** A form post from another site is refused: only our own pages may sign someone in or out. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === serviceConfig().publicUrl;
}

/** A 303 to `location` carrying every `Set-Cookie` of `from`. */
export function redirectWithCookies(location: string, from: Response | Headers | undefined): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  const source = from instanceof Response ? from.headers : from;
  for (const cookie of source?.getSetCookie() ?? []) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function formField(request: Request, name: string): Promise<string | undefined> {
  try {
    const value = (await request.formData()).get(name);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
