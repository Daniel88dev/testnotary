// What a run knows about itself once it has found its repo, base config and suite, and the shape
// every refusal check has. Checks live one per file under `checks/` and are listed, in order, in
// `checks/index.ts`.
import { say } from "../report.ts";
import type { RefusalCode, Suite, TestnotaryConfig, WarningCode } from "../shared.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** The token a run sends, and where it came from. */
export interface RunToken {
  /** Sent as `Bearer` exactly as it is. */
  value: string;
  /** `env`: `TESTNOTARY_TOKEN`; `stored`: the laptop token in the keychain or the `0600` file. */
  source: "env" | "stored";
}

/**
 * What the uploaded record carries beyond the run's own facts. Checks fill these in as they learn
 * them (the environment floor sets `packageManager` and `notPinned`, agent detection `session`,
 * …); the upload sends whatever they hold when the run ends.
 */
export interface RunNotes {
  /** Warning codes, in the order they were raised. Use `warn()`, which also prints the line. */
  warnings: string[];
  notPinned: ("runtime" | "package_manager")[];
  packageManager: { name: string; version: string } | null;
  guardedMatched: string[];
  session: { vendor: string; id: string | null; url: string | null } | null;
}

export interface RunContext {
  /** Where the user ran `testnotary`. */
  cwd: string;
  /** The shell's environment. */
  env: Env;
  serviceUrl: string;
  /** The repo's top level: the command runs here. */
  root: string;
  /** `HEAD` when the run was prepared. */
  checkout: { commit: string; tree: string };
  /** `git status` (`treeStatus()`) when the run was prepared, to compare with after the command. */
  statusBefore: string | undefined;
  origin: {
    url: string;
    /** `owner/name` when `origin` is a github.com repo; the service knows repos by it. */
    repository: string | undefined;
  };
  base: {
    branch: string;
    /** `origin/<branch>`, where the config was read. */
    ref: string;
    /** False when the fetch failed and the last fetched ref was used (offline). */
    fetched: boolean;
  };
  /** `testnotary.json` as the base branch has it. */
  config: TestnotaryConfig;
  suite: Suite;
  /** Whatever came after a bare `--` on the command line. */
  extraArguments: string[];
  token: RunToken | undefined;
  notes: RunNotes;
}

/** A clear reason not to run: the run ends *refused* with this code, after printing the lines. */
export interface Refusal {
  refusal: RefusalCode;
  lines: string[];
  /** False: the refused run is not uploaded (the token must not be sent). Uploaded by default. */
  upload?: boolean;
}

/**
 * One refusal check. It looks at the prepared run and returns a refusal, or nothing. A check may
 * also `warn()` (never refuse for a warning) and fill in `context.notes`.
 */
export interface RunCheck {
  /** The refusal code it gives, for reading the list. */
  name: string;
  check(context: RunContext): Promise<Refusal | undefined>;
}

/** Raises a warning: the code goes into `warnings[]`, the line to stderr with the `testnotary:` prefix. */
export function warn(context: { notes: RunNotes }, code: WarningCode, line: string): void {
  if (!context.notes.warnings.includes(code)) context.notes.warnings.push(code);
  say(line);
}

export function emptyNotes(): RunNotes {
  return { warnings: [], notPinned: [], packageManager: null, guardedMatched: [], session: null };
}
