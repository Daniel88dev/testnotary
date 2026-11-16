import { parseConfig, suiteFromConfig, suiteNames } from "../../config.ts";
import { GUARDED_DEFAULTS } from "../../guarded.ts";
import type { VerificationStep } from "../context.ts";
import { guardedChange } from "./guarded-files.ts";

/**
 * The suite must exist in `testnotary.json` at the built commit's first parent: the base's config,
 * never the one the pull request brings. A job that names no suite gets the config's only one. A
 * base with no config, or one that doesn't parse, has no suite to match: `unknown_suite`.
 *
 * A base with no config at all is the setup pull request's (it adds the config, the workflow and
 * the lockfile). The product defaults guard without a config, so a guarded change is named first:
 * its tests run because it changes guarded files.
 */
export const suiteStep: VerificationStep = {
  name: "suite",
  async decide(state) {
    const text = await state.sources.configAtBase();
    if (text === undefined) return (await guardedChange(state, GUARDED_DEFAULTS)) ?? "unknown_suite";
    const parsed = parseConfig(text);
    if (!parsed.ok) return "unknown_suite";
    state.config = parsed.config;
    const names = suiteNames(parsed.config);
    const name = state.requestedSuite ?? (names.length === 1 ? names[0]! : undefined);
    const suite = name === undefined ? undefined : suiteFromConfig(parsed.config, name);
    if (!suite) return "unknown_suite";
    state.suite = suite;
    return undefined;
  },
};
