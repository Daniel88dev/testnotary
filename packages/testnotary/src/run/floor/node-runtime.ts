// Where a repo says which Node it runs on, read as `actions/setup-node` reads its
// `node-version-file`: the config's `nodeVersionFile` alone when it is set, otherwise the first of
// `.node-version`, `.nvmrc`, `.tool-versions`, then `package.json`'s `volta.node`,
// `devEngines.runtime` and `engines.node`. The others are kept to warn when they disagree.
import { PACKAGE_JSON_NODE_FIELDS, nodeVersionFromFile, packageJsonNodeVersion, readNodeSpec, type NodeSpec } from "../../shared.ts";
import type { RunContext } from "../context.ts";
import { project, readText } from "./project.ts";

export interface NodeSource {
  /** How a person names it: `.nvmrc`, `package.json's engines.node`. */
  label: string;
  spec: NodeSpec;
}

export interface NodeSources {
  /** The source the run is checked against; undefined when the repo names no Node version. */
  used: NodeSource | undefined;
  /** Lower-priority sources, for `runtime_sources_disagree`. Empty when `nodeVersionFile` is set. */
  others: NodeSource[];
  /** Why the configured `nodeVersionFile` gives no version at all. */
  problem: string | undefined;
}

const PLAIN_FILES = [".node-version", ".nvmrc", ".tool-versions"];

const sources = new WeakMap<RunContext, Promise<NodeSources>>();

/** The repo's Node version sources (memoised per run). */
export function nodeSources(context: RunContext): Promise<NodeSources> {
  let found = sources.get(context);
  if (!found) {
    found = readSources(context);
    sources.set(context, found);
  }
  return found;
}

async function readSources(context: RunContext): Promise<NodeSources> {
  const configured = context.config.nodeVersionFile;
  if (configured !== undefined) {
    const where = `${configured} (nodeVersionFile in testnotary.json on ${context.base.ref})`;
    const text = await readText(context.root, configured);
    if (text === undefined) return { used: undefined, others: [], problem: `${where} doesn't exist, so CI's setup-node would fail to read a Node version from it` };
    const version = nodeVersionFromFile(text);
    if (version === null) return { used: undefined, others: [], problem: `${where} names no Node version` };
    return { used: { label: configured, spec: readNodeSpec(version) }, others: [], problem: undefined };
  }

  const found: NodeSource[] = [];
  for (const file of PLAIN_FILES) {
    const text = await readText(context.root, file);
    if (text === undefined) continue;
    // A `.tool-versions` without a Node line is about other tools.
    if (file === ".tool-versions" && !/^\s*node(js)?\s+\S/m.test(text)) continue;
    const version = nodeVersionFromFile(text);
    if (version !== null) found.push({ label: file, spec: readNodeSpec(version) });
  }
  const { manifest } = await project(context);
  for (const field of PACKAGE_JSON_NODE_FIELDS) {
    const version = packageJsonNodeVersion(manifest, field);
    if (version !== null) found.push({ label: `package.json's ${field}`, spec: readNodeSpec(version) });
  }
  return { used: found[0], others: found.slice(1), problem: undefined };
}

/** The Node this run has, as Node itself reports it. */
export function currentNode(): { version: string; lts: string | undefined } {
  const lts = (process.release as { lts?: unknown }).lts;
  return { version: process.version, lts: typeof lts === "string" ? lts : undefined };
}

/** `v24.11.0`, or `v24.11.0 (LTS Krypton)`. */
export function describeNode(node: { version: string; lts: string | undefined }): string {
  return node.lts ? `${node.version} (LTS ${node.lts})` : node.version;
}
