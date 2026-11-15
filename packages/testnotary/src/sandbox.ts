import { existsSync } from "node:fs";
import { SANDBOX_MARKERS } from "./shared.ts";

// Agent sandbox markers (the list is core's SANDBOX_MARKERS). With any of them a laptop token and
// `login` are refused, with no override: a sandbox uses a sandbox token instead.

type Env = Readonly<Record<string, string | undefined>>;

/** The first sandbox marker present, by name, or undefined on an ordinary machine. */
export function sandboxMarker(env: Env, fileExists: (path: string) => boolean = existsSync): string | undefined {
  return SANDBOX_MARKERS.find((marker) => marker.present(env, fileExists))?.name;
}
