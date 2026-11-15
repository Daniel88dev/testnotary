import { guardedGlobs, guardedMatches } from "../../guarded.ts";
import type { Fallback, VerificationState, VerificationStep } from "../context.ts";

/** GitHub's compare lists at most this many changed files for a whole comparison. */
export const COMPARE_FILE_LIMIT = 300;

/**
 * No path the built commit changes against its first parent may match a guarded glob: the product
 * defaults plus the repo's own from the config at the first parent. The first match is named. A
 * list GitHub cut short can't show that no guarded file changed, so it falls back too.
 */
export const guardedFilesStep: VerificationStep = {
  name: "guarded files",
  async decide(state) {
    return guardedChange(state, guardedGlobs(state.config));
  },
};

/**
 * The fallback for a guarded change among the commit's changed paths, or undefined when there is
 * none. A commit with no first parent has nothing to compare against: `undefined` too (its config
 * step has already answered).
 */
export async function guardedChange(state: VerificationState, globs: readonly string[]): Promise<Fallback | undefined> {
  const changed = await state.sources.changedPaths();
  if (!changed) return undefined;
  const [first] = guardedMatches(changed.paths, globs);
  if (first) return { reason: "guarded_file_changed", detail: first.path };
  if (!changed.complete) {
    return { reason: "guarded_file_changed", detail: `${COMPARE_FILE_LIMIT} or more changed files; GitHub lists only the first ${COMPARE_FILE_LIMIT}` };
  }
  return undefined;
}
