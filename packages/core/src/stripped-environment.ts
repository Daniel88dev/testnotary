// The stripped environment: what a suite's command sees in both `run` and `exec`. Nothing else of
// the shell reaches the tests, the token included.
import type { EnvRules } from "./config.ts";

/** Passed through from the shell when set there. */
export const PASSED_THROUGH = ["PATH", "TMPDIR", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR"];

/** Set by Testnotary. `env.set` may override the ones in BASELINE_OVERRIDABLE. */
export const BASELINE_FIXED: Readonly<Record<string, string>> = { TZ: "UTC", LANG: "C.UTF-8", CI: "true" };

export const BASELINE_OVERRIDABLE = ["CI", "TZ", "LANG"];

/** Every name the stripped environment itself controls; a config can't pass these. */
export const BASELINE_NAMES = [...PASSED_THROUGH, "HOME", ...Object.keys(BASELINE_FIXED)];

export interface StrippedEnvironmentOptions {
  /** A fresh, empty scratch directory; the caller deletes it after the command. */
  home: string;
  /** The suite's env rules (`suiteFromConfig(...).env`). */
  env: EnvRules;
}

/**
 * Builds the child's whole environment from the shell's: the pass-through names, a scratch `HOME`,
 * `TZ=UTC`, `LANG=C.UTF-8`, `CI=true`, then the config's `env.pass` (names unset in the shell stay
 * unset) and `env.set`.
 */
export function strippedEnvironment(shell: Readonly<Record<string, string | undefined>>, options: StrippedEnvironmentOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = shell[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = options.home;
  Object.assign(env, BASELINE_FIXED);
  for (const name of options.env.pass) {
    const value = shell[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, options.env.set);
  return env;
}

/** The baseline names (`CI`, `TZ`, `LANG`) whose value `env.set` changes; a run records these. */
export function baselineOverrides(rules: EnvRules): string[] {
  return BASELINE_OVERRIDABLE.filter((name) => Object.hasOwn(rules.set, name) && rules.set[name] !== BASELINE_FIXED[name]);
}
