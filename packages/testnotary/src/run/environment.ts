import { release } from "node:os";
import { strippedEnvironment, type RunEnvironment, type Suite } from "../shared.ts";
import type { RunNotes } from "./context.ts";

/**
 * The environment the run's record carries: OS, OS version, architecture, Node, the package
 * manager (when the environment floor found one), and the `TZ` and locale the command ran with.
 * Never a value from the shell's own environment beyond these.
 */
export function runEnvironment(suite: Suite, notes: RunNotes): RunEnvironment {
  // The child's TZ and LANG: the stripped environment's, with the config's `env.set` applied.
  const child = strippedEnvironment({}, { home: "", env: suite.env });
  return {
    os: process.platform,
    osVersion: release(),
    arch: process.arch,
    node: process.version,
    packageManager: notes.packageManager,
    tz: child.TZ ?? "",
    locale: child.LANG ?? "",
  };
}
