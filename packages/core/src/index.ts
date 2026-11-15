// Core rules: tree match, guarded-file globbing, audit draw, token checks, config parsing and the
// verification decision live here as later tickets add them. The library, the action and the web
// app import this package; nothing in it does I/O.

export type TokenKind = "laptop" | "sandbox";

/** Which kind of token a value is, judged by its prefix alone (`tnl_` or `tns_`). */
export function tokenKind(value: string): TokenKind | undefined {
  if (value.startsWith("tnl_")) return "laptop";
  if (value.startsWith("tns_")) return "sandbox";
  return undefined;
}
