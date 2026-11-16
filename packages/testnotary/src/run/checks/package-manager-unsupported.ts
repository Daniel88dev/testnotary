import { basename } from "node:path";
import type { RunCheck } from "../context.ts";
import { isSupported, packageManagerUse } from "../floor/package-manager.ts";

const UNSUPPORTED_PROGRAMS: Record<string, string> = { bun: "Bun", bunx: "Bun", deno: "Deno" };
const LABELS: Record<string, string> = { bun: "Bun", deno: "Deno" };

/**
 * `package_manager_unsupported`: v1 knows npm, pnpm and Yarn. A repo that pins or locks with
 * anything else (Bun, Deno), or a suite whose command is `bun`/`deno`, is refused.
 */
export const packageManagerUnsupported: RunCheck = {
  name: "package_manager_unsupported",
  async check(context) {
    const program = context.suite.command[0] ?? "";
    const runtime = UNSUPPORTED_PROGRAMS[basename(program)];
    if (runtime) {
      return {
        refusal: "package_manager_unsupported",
        lines: [`the suite's command runs ${program}, and ${runtime} is not supported in v1: testnotary supports npm, pnpm and Yarn`],
      };
    }
    const use = await packageManagerUse(context);
    if (use.name === undefined || isSupported(use.name)) return undefined;
    const where = use.pin ? `${use.pin.source} in package.json names ${use.name}` : `the repo has ${use.lockfile ?? "a lockfile"}, ${use.name}'s lockfile`;
    const label = LABELS[use.name] ?? use.name;
    return { refusal: "package_manager_unsupported", lines: [`${where}, and ${label} is not supported in v1: testnotary supports npm, pnpm and Yarn`] };
  },
};
