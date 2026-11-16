// `testnotary.json`: the repo's declared suites and the rules every run of them follows. The schema
// below is the single definition: the parser uses it, and `configJsonSchema()` turns it into the
// JSON schema published at CONFIG_SCHEMA_URL (apps/web/public/schema/v1.json, written by
// `pnpm schema:write`). Anything the parser refuses is the refusal `config_invalid`.
import { z } from "zod";
import { BASELINE_OVERRIDABLE, BASELINE_NAMES } from "./stripped-environment.ts";

export const CONFIG_FILE = "testnotary.json";
export const CONFIG_SCHEMA_URL = "https://testnotary.dev/schema/v1.json";

// Node's spelling (`process.platform` / `process.arch`). A bare OS allows any architecture.
const OPERATING_SYSTEMS = ["aix", "android", "cygwin", "darwin", "freebsd", "haiku", "linux", "netbsd", "openbsd", "sunos", "win32"];
const ARCHITECTURES = ["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64"];
const PLATFORM = new RegExp(`^(${OPERATING_SYSTEMS.join("|")})(/(${ARCHITECTURES.join("|")}))?$`);

const ENV_NAME = /^(?!TESTNOTARY_)[A-Za-z_][A-Za-z0-9_]*$/;
const SUITE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const envName = z.string().regex(ENV_NAME, {
  error: (issue) =>
    typeof issue.input === "string" && issue.input.startsWith("TESTNOTARY_")
      ? `${JSON.stringify(issue.input)} is reserved: TESTNOTARY_* variables never reach the tests`
      : `${JSON.stringify(issue.input)} is not an environment variable name`,
});

const envRules = z
  .strictObject({
    pass: z.array(envName).optional().meta({ description: "Names whose values come from the shell." }),
    set: z.record(envName, z.string()).optional().meta({ description: "Fixed public values. May override CI, TZ and LANG." }),
  })
  .meta({ description: "Variables the tests see on top of the stripped environment." });

const suite = z
  .strictObject({
    command: z
      .tuple([z.string({ error: "the command needs at least the program to run" }).min(1, "the program can't be empty")], z.string())
      .meta({ description: "The argv, spawned with no shell. For pipes or &&, point it at a package.json script." }),
    env: envRules.optional().meta({ description: "Adds to the top-level env for this suite." }),
  })
  .meta({ description: "A named test command." });

const configSchema = z
  .strictObject({
    $schema: z.string().optional().meta({ description: "This schema's URL, so editors can check the file. Ignored by the library." }),
    base: z.string().min(1).optional().meta({ description: "The base branch. Default: the remote's default branch." }),
    platforms: z
      .array(z.string().regex(PLATFORM, { error: (issue) => `${JSON.stringify(issue.input)} is not a platform in Node's spelling, such as linux/x64 or darwin` }))
      .optional()
      .meta({ description: "Platforms a run may attest on, such as linux/x64. A bare OS allows any architecture." }),
    env: envRules.optional(),
    guarded: z.array(z.string().min(1)).optional().meta({ description: "Globs added to the guarded-file defaults." }),
    nodeVersionFile: z.string().min(1).optional().meta({ description: "The file the Node version is read from." }),
    signatures: z.literal("required").optional().meta({ description: '"required" turns signature mode on.' }),
    suites: z
      .record(z.string().regex(SUITE_NAME, { error: (issue) => `${JSON.stringify(issue.input)} is not a suite name (letters, digits, ".", "_", "-")` }), suite)
      .refine((suites) => Object.keys(suites).length > 0, "declare at least one suite")
      .meta({ description: "Suite name to its command.", minProperties: 1 }),
  })
  .meta({ $id: CONFIG_SCHEMA_URL, title: "testnotary.json" });

export type TestnotaryConfig = z.infer<typeof configSchema>;

/** The variables one suite's tests get on top of the stripped environment. */
export interface EnvRules {
  /** Names whose values come from the shell. */
  pass: string[];
  /** Fixed values, applied last. */
  set: Record<string, string>;
}

export interface Suite {
  name: string;
  command: string[];
  env: EnvRules;
}

export type ConfigResult = { ok: true; config: TestnotaryConfig } | { ok: false; problems: string[] };

/**
 * Parses the text of `testnotary.json`. On failure, `problems` holds one line per problem, each
 * naming where it is (`suites.unit.command`) and what is wrong; the caller refuses with
 * `config_invalid`.
 */
export function parseConfig(text: string): ConfigResult {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { ok: false, problems: [`not valid JSON: ${(error as Error).message}`] };
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.flatMap(describeIssue) };
  const problems = envProblems(parsed.data);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: parsed.data };
}

/** The suite's command and its effective env rules: the top-level `env` plus the suite's own. */
export function suiteFromConfig(config: TestnotaryConfig, name: string): Suite | undefined {
  if (!Object.hasOwn(config.suites, name)) return undefined;
  const declared = config.suites[name]!;
  return { name, command: [...declared.command], env: effectiveEnv(config, declared.env) };
}

/** The suite names a config declares, in its order. */
export function suiteNames(config: TestnotaryConfig): string[] {
  return Object.keys(config.suites);
}

/** The JSON schema for `testnotary.json`, as published at CONFIG_SCHEMA_URL. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(configSchema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
}

function effectiveEnv(config: TestnotaryConfig, own: TestnotaryConfig["env"]): EnvRules {
  const pass = [...new Set([...(config.env?.pass ?? []), ...(own?.pass ?? [])])];
  return { pass, set: { ...config.env?.set, ...own?.set } };
}

// Rules the schema can't express: the stripped environment's own names stay as Testnotary sets
// them (env.set may override CI, TZ and LANG only), and no name is both passed and set.
function envProblems(config: TestnotaryConfig): string[] {
  const problems: string[] = [];
  const check = (where: string, rules: TestnotaryConfig["env"]) => {
    for (const name of rules?.pass ?? []) {
      if (BASELINE_NAMES.includes(name)) problems.push(`${where}.pass: ${name} is part of the stripped environment and can't be passed from the shell`);
    }
    for (const name of Object.keys(rules?.set ?? {})) {
      if (BASELINE_NAMES.includes(name) && !BASELINE_OVERRIDABLE.includes(name)) {
        problems.push(`${where}.set: ${name} is part of the stripped environment; env.set may override only ${BASELINE_OVERRIDABLE.join(", ")}`);
      }
    }
  };
  check("env", config.env);
  for (const [name, declared] of Object.entries(config.suites)) {
    check(`suites.${name}.env`, declared.env);
    const effective = effectiveEnv(config, declared.env);
    for (const passed of effective.pass) {
      if (Object.hasOwn(effective.set, passed)) problems.push(`suites.${name}: ${passed} is both passed from the shell and set`);
    }
  }
  return problems;
}

function describeIssue(issue: z.core.$ZodIssue): string[] {
  const where = issue.path.length > 0 ? formatPath(issue.path) : "testnotary.json";
  switch (issue.code) {
    case "unrecognized_keys":
      return issue.keys.map((key) => `${where}: unknown key ${JSON.stringify(key)}`);
    case "invalid_key":
      return issue.issues.flatMap((inner) => describeIssue({ ...inner, path: issue.path } as z.core.$ZodIssue));
    default:
      return [`${where}: ${issue.message}`];
  }
}

function formatPath(path: PropertyKey[]): string {
  return path
    .map((part, index) => (typeof part === "number" ? `[${part}]` : index === 0 ? String(part) : `.${String(part)}`))
    .join("");
}
