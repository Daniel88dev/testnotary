import type { RunCheck } from "../context.ts";
import { installProblem } from "../floor/install-state.ts";
import { isSupported, packageManagerUse } from "../floor/package-manager.ts";

/**
 * `install_stale`: the installed dependencies don't match the lockfile, as read from the state file
 * the package manager wrote at its last install (see `../floor/install-state.ts`). A missing or
 * unreadable state file is stale too. A repo without a lockfile has nothing to compare.
 */
export const installStale: RunCheck = {
  name: "install_stale",
  async check(context) {
    const { name, lockfile } = await packageManagerUse(context);
    if (name === undefined || !isSupported(name) || lockfile === undefined) return undefined;
    const lines = await installProblem(context.root, name, lockfile);
    return lines ? { refusal: "install_stale", lines } : undefined;
  },
};
