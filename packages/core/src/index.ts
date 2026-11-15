// Core rules: tree match, guarded-file globbing, audit draw, token checks, config parsing and the
// verification decision live here as later tickets add them. The library, the action and the web
// app import this package; nothing in it does I/O.

export {
  CONFIG_FILE,
  CONFIG_SCHEMA_URL,
  configJsonSchema,
  parseConfig,
  suiteFromConfig,
  suiteNames,
  type ConfigResult,
  type EnvRules,
  type Suite,
  type TestnotaryConfig,
} from "./config.ts";
export { REFUSAL_CODES, type Outcome, type RefusalCode } from "./outcome.ts";
export {
  BASELINE_FIXED,
  BASELINE_NAMES,
  BASELINE_OVERRIDABLE,
  PASSED_THROUGH,
  baselineOverrides,
  strippedEnvironment,
  type StrippedEnvironmentOptions,
} from "./stripped-environment.ts";

export type TokenKind = "laptop" | "sandbox";

/** Which kind of token a value is, judged by its prefix alone (`tnl_` or `tns_`). */
export function tokenKind(value: string): TokenKind | undefined {
  if (value.startsWith("tnl_")) return "laptop";
  if (value.startsWith("tns_")) return "sandbox";
  return undefined;
}
