import { parseConfig, suiteFromConfig, suiteNames } from "../../config.ts";
import type { VerificationStep } from "../context.ts";

/**
 * The suite must exist in `testnotary.json` at the built commit's first parent: the base's config,
 * never the one the pull request brings. A job that names no suite gets the config's only one. A
 * base with no config, or one that doesn't parse, has no suite to match: `unknown_suite`.
 */
export const suiteStep: VerificationStep = {
  name: "suite",
  async decide(state) {
    const text = await state.sources.configAtBase();
    const parsed = text === undefined ? undefined : parseConfig(text);
    if (!parsed?.ok) return "unknown_suite";
    state.config = parsed.config;
    const names = suiteNames(parsed.config);
    const name = state.requestedSuite ?? (names.length === 1 ? names[0]! : undefined);
    const suite = name === undefined ? undefined : suiteFromConfig(parsed.config, name);
    if (!suite) return "unknown_suite";
    state.suite = suite;
    return undefined;
  },
};
