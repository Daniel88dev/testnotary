import { tryGit } from "../../git.ts";
import type { RunCheck } from "../context.ts";

/**
 * `dirty_tree` for submodules: one with changes in it, or checked out at another commit than the
 * one `HEAD` records, means the files tested aren't the tree the attestation would name. Asked with
 * `--ignore-submodules=none`, so an `ignore` setting in `.gitmodules` or the git config can't hide
 * it. Nested submodules show up as changes in the submodule that holds them.
 */
export const submodules: RunCheck = {
  name: "dirty_tree",
  async check(context) {
    const status = await tryGit(context.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"], context.env);
    if (status === undefined) return { refusal: "dirty_tree", lines: ["git status failed, so the submodules can't be shown to be clean"] };
    const problems = submoduleProblems(status);
    if (problems.length === 0) return undefined;
    return {
      refusal: "dirty_tree",
      lines: [
        ...problems,
        "commit the change in the submodule and record it in this repo, or bring the submodule back (git submodule update --recursive), then run again",
      ],
    };
  },
};

/**
 * One line per submodule that isn't as `HEAD` records it, from `git status --porcelain=v2 -z`.
 * A changed entry is `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`, where `<sub>` is `S<c><m><u>`
 * for a submodule: a new commit, modified content, untracked content (`.` when not).
 */
function submoduleProblems(status: string): string[] {
  const entries = status.split("\0");
  const problems: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const kind = entry[0];
    // A rename or copy (`2`) is followed by its original path as one more entry.
    if (kind === "2") i++;
    if (kind !== "1" && kind !== "2") continue;
    const fields = entry.split(" ");
    const xy = fields[1]!;
    const sub = fields[2]!;
    if (!sub.startsWith("S")) continue;
    const path = fields.slice(kind === "1" ? 8 : 9).join(" ");
    const [, commit, modified, untracked] = sub;
    if (commit === "C" || xy[0] !== ".") problems.push(`submodule ${path} is at another commit than the one this commit records`);
    if (modified === "M" || untracked === "U") problems.push(`submodule ${path} has changes that aren't committed`);
  }
  return problems;
}
