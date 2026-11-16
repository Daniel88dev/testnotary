import { tryGit } from "../../git.ts";
import { warn, type RunCheck } from "../context.ts";

/**
 * `branch_behind_base`: `HEAD` doesn't contain the base's tip. The run still attests the head tree,
 * but CI tests the pull request merged into the base, a different tree, so it won't skip. The
 * library never merges or rebases.
 */
export const branchBehindBase: RunCheck = {
  name: "branch_behind_base",
  async check(context) {
    const contains = await tryGit(context.root, ["merge-base", "--is-ancestor", `refs/remotes/${context.base.ref}`, "HEAD"], context.env);
    if (contains !== undefined) return undefined;
    warn(
      context,
      "branch_behind_base",
      `this branch is behind ${context.base.ref} (it doesn't contain its tip): the run attests your head tree, but CI tests it merged into the base, so the pull request won't skip until you update it (merge or rebase; testnotary never does)`,
    );
    return undefined;
  },
};
