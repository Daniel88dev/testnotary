import { nodeMatches, nodePinned } from "../../shared.ts";
import type { RunCheck } from "../context.ts";
import { currentNode, describeNode, nodeSources } from "../floor/node-runtime.ts";

/**
 * `runtime_mismatch`: this Node isn't one CI's `actions/setup-node` could install from the repo's
 * Node version source. No source, or a moving one (`lts/*`, `node`, `>=20`), records *runtime not
 * pinned* instead.
 */
export const runtimeMismatch: RunCheck = {
  name: "runtime_mismatch",
  async check(context) {
    const { used, problem } = await nodeSources(context);
    if (problem) return { refusal: "runtime_mismatch", lines: [problem, "point nodeVersionFile at the file CI's node-version-file reads, on the base branch"] };
    if (!used) {
      context.notes.notPinned.push("runtime");
      return undefined;
    }
    if (used.spec.kind === "invalid") {
      return { refusal: "runtime_mismatch", lines: [`${used.label} says "${used.spec.text}", which is not a Node version setup-node can install`] };
    }
    const node = currentNode();
    if (!nodeMatches(used.spec, node)) {
      return {
        refusal: "runtime_mismatch",
        lines: [
          `this is Node ${describeNode(node)}, but ${used.label} asks for ${used.spec.text}, which is what CI's setup-node installs from it`,
          "switch to a Node that matches (nvm use, fnm use, volta, mise, …), then run again",
        ],
      };
    }
    if (!nodePinned(used.spec)) context.notes.notPinned.push("runtime");
    return undefined;
  },
};
