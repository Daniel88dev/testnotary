// Which guarded globs the run's change matches: the paths `HEAD` changes against its merge base
// with the base branch (what a pull request of this branch would change), judged with the base's
// config, as CI's verification judges the pull request. A match doesn't refuse the run; it is
// recorded, because CI will run its tests on that pull request anyway. Only the globs are sent,
// never a file name.
import { tryGit } from "../git.ts";
import { guardedGlobs, guardedMatches } from "../shared.ts";
import type { RunContext } from "./context.ts";

/** The guarded globs the change matches, in the order they are listed (the defaults first). */
export async function guardedGlobsMatched(context: Pick<RunContext, "root" | "env" | "base" | "config">): Promise<string[]> {
  const diff = await tryGit(context.root, ["diff", "--name-only", "-z", "--no-renames", `${context.base.ref}...HEAD`], context.env);
  if (!diff) return [];
  const globs = guardedGlobs(context.config);
  const matched = new Set(guardedMatches(diff.split("\0").filter(Boolean), globs).map((match) => match.glob));
  return globs.filter((glob) => matched.has(glob));
}
