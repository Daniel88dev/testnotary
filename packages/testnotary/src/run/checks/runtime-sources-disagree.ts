import { nodeMatches } from "../../shared.ts";
import { warn, type RunCheck } from "../context.ts";
import { currentNode, nodeSources } from "../floor/node-runtime.ts";

/**
 * The warning `runtime_sources_disagree`: a lower-priority Node version source asks for a Node
 * this one isn't, while the source used accepts it (`.nvmrc` says 24, `engines.node` says 22).
 * CI gets whichever its `node-version-file` names. Not raised when the config's `nodeVersionFile`
 * says which file counts.
 */
export const runtimeSourcesDisagree: RunCheck = {
  name: "runtime_sources_disagree",
  async check(context) {
    const { used, others } = await nodeSources(context);
    if (!used) return undefined;
    const node = currentNode();
    const disagree = others.filter((other) => (other.spec.kind === "range" || other.spec.kind === "lts") && !nodeMatches(other.spec, node));
    if (disagree.length === 0) return undefined;
    const list = disagree.map((other) => `${other.label} (${other.spec.text})`).join(", ");
    warn(
      context,
      "runtime_sources_disagree",
      `${list} ${disagree.length === 1 ? "disagrees" : "disagree"} with ${used.label} (${used.spec.text}), which is the one used: make them agree, or set nodeVersionFile in testnotary.json to the file CI's node-version-file reads`,
    );
    return undefined;
  },
};
