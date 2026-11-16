import { tryGit } from "../../git.ts";
import type { RunCheck } from "../context.ts";
import { treeStatus } from "../locate.ts";

const SHOWN = 5;

/**
 * `tree_changed_during_run`: `HEAD` and `git status` after the command, compared with before it.
 * A command that writes into files git sees, deletes them, commits or checks out has tested
 * something other than the tree the attestation would name. Only the two states are compared;
 * nothing watches the tree while the command runs.
 */
export const treeChangedDuringRun: RunCheck = {
  name: "tree_changed_during_run",
  async check(context) {
    const before = context.checkout.commit;
    const after = await tryGit(context.root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], context.env);
    if (after !== before) {
      return {
        refusal: "tree_changed_during_run",
        lines: [
          `HEAD moved from ${before.slice(0, 12)} to ${after?.slice(0, 12) ?? "nothing"} while the command ran (a commit, checkout or reset during the run), so what it tested isn't one tree`,
          "make sure the suite's command doesn't commit or check out, then run again",
        ],
      };
    }
    const status = await treeStatus(context.root, context.env);
    if (status !== undefined && status === context.statusBefore) return undefined;
    const changed = status === undefined ? [] : entries(status).filter((entry) => !entries(context.statusBefore ?? "").includes(entry));
    const more = changed.length > SHOWN ? [`  … and ${changed.length - SHOWN} more`] : [];
    return {
      refusal: "tree_changed_during_run",
      lines: [
        status === undefined ? "the working tree changed while the command ran (git status failed afterwards)" : `the working tree changed while the command ran (${changed.length || "files"}):`,
        ...changed.slice(0, SHOWN).map((entry) => `  ${entry}`),
        ...more,
        "the command must not write into files git sees: send its output (coverage, reports, snapshots) to a directory listed in .gitignore, then run again",
      ],
    };
  },
};

function entries(status: string): string[] {
  return status.split("\0").filter((entry) => entry.length > 0);
}
