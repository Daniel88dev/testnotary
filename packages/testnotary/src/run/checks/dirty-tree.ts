import { tryGit } from "../../git.ts";
import type { RunCheck } from "../context.ts";

const SHOWN = 5;

/**
 * `dirty_tree`: anything `git status` reports, untracked files that aren't ignored included, would
 * make the tested files differ from the tree an attestation names. An unpushed commit is fine.
 * Submodules, which git's own settings can hide from this, have their own check (`submodules.ts`).
 */
export const dirtyTree: RunCheck = {
  name: "dirty_tree",
  async check(context) {
    const status = await tryGit(context.root, ["status", "--porcelain=v1", "--untracked-files=all"], context.env);
    if (status === undefined) return { refusal: "dirty_tree", lines: ["git status failed, so the tree can't be shown to be clean"] };
    const paths = status.split("\n").filter((line) => line.length > 0);
    if (paths.length === 0) return undefined;
    const more = paths.length > SHOWN ? [`  … and ${paths.length - SHOWN} more`] : [];
    return {
      refusal: "dirty_tree",
      lines: [
        `the working tree has changes that aren't committed (${paths.length}):`,
        ...paths.slice(0, SHOWN).map((line) => `  ${line}`),
        ...more,
        "commit them (an unpushed commit is fine), stash them, or add untracked files to .gitignore, then run again",
      ],
    };
  },
};
