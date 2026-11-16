// Node version specs the way `actions/setup-node` reads them (`getNodeVersionFromFile` in its
// `src/util.ts`, and the alias handling of its installer), so a run checks Node against what CI's
// `node-version-file` will install.
import { isOpenRange, isValidRange, satisfies } from "./semver.ts";

/** The `package.json` fields setup-node reads, in its order. */
export const PACKAGE_JSON_NODE_FIELDS = ["volta.node", "devEngines.runtime", "engines.node"] as const;
export type PackageJsonNodeField = (typeof PACKAGE_JSON_NODE_FIELDS)[number];

/** The Node version a `package.json` declares in one of setup-node's fields, or null. */
export function packageJsonNodeVersion(manifest: unknown, field: PackageJsonNodeField): string | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const m = manifest as { volta?: { node?: unknown }; devEngines?: { runtime?: unknown }; engines?: { node?: unknown } };
  switch (field) {
    case "volta.node":
      return typeof m.volta?.node === "string" && m.volta.node ? m.volta.node : null;
    case "devEngines.runtime": {
      const entries = [m.devEngines?.runtime].flat() as { name?: unknown; version?: unknown }[];
      const node = entries.find((entry) => typeof entry?.name === "string" && entry.name.toLowerCase() === "node" && entry.version);
      return typeof node?.version === "string" ? node.version : null;
    }
    case "engines.node":
      return typeof m.engines?.node === "string" && m.engines.node ? m.engines.node : null;
  }
}

/**
 * What setup-node takes from a version file's text: a JSON object is read as a `package.json`
 * (`volta.node`, then `devEngines.runtime`, then `engines.node`, else nothing); otherwise the first
 * line that is one word, optionally after `node`/`nodejs` (as in `.tool-versions`), without a
 * leading `v`; otherwise the whole text, trimmed. (setup-node also reads `mise.toml`'s
 * `tools.node`; Testnotary does not.)
 */
export function nodeVersionFromFile(contents: string): string | null {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed === "object" && parsed !== null) {
      for (const field of PACKAGE_JSON_NODE_FIELDS) {
        const found = packageJsonNodeVersion(parsed, field);
        if (found !== null) return found;
      }
      return null;
    }
  } catch {
    // Not JSON: a plain version file.
  }
  const found = /^(?:node(js)?\s+)?v?(?<version>[^\s]+)$/m.exec(contents);
  return found?.groups?.version ?? contents.trim();
}

/** A Node version spec, sorted by what it promises about the Node CI gets. */
export type NodeSpec =
  /** `node`, `latest`, `current`, `lts/*`, `lts/-1`: whatever is newest when CI runs. */
  | { kind: "moving"; text: string }
  /** `lts/<codename>`: the newest release of one LTS line. */
  | { kind: "lts"; text: string; codename: string }
  /** A version or a range; `open` when it has no upper bound (`>=20`), so CI gets the newest. */
  | { kind: "range"; text: string; open: boolean }
  | { kind: "invalid"; text: string };

export function readNodeSpec(text: string): NodeSpec {
  const spec = text.trim();
  const lower = spec.toLowerCase();
  if (lower === "node" || lower === "latest" || lower === "current" || lower === "lts/*" || /^lts\/-\d+$/.test(lower)) return { kind: "moving", text: spec };
  if (lower.startsWith("lts/")) return /^lts\/[a-z]+$/.test(lower) ? { kind: "lts", text: spec, codename: lower.slice(4) } : { kind: "invalid", text: spec };
  if (spec === "" || !isValidRange(spec)) return { kind: "invalid", text: spec };
  return { kind: "range", text: spec, open: isOpenRange(spec) };
}

/** The Node a run has: `process.version` and `process.release.lts` (an LTS codename, or nothing). */
export interface NodeRuntime {
  version: string;
  lts: string | undefined;
}

/** Whether this Node is one CI could install for `spec`. A moving alias admits any. */
export function nodeMatches(spec: NodeSpec, node: NodeRuntime): boolean {
  switch (spec.kind) {
    case "moving":
      return true;
    case "lts":
      return node.lts?.toLowerCase() === spec.codename;
    case "range":
      return satisfies(node.version, spec.text) === true;
    case "invalid":
      return false;
  }
}

/** Pinned: the spec names one release line or narrower, so CI and a laptop get the same Node. */
export function nodePinned(spec: NodeSpec): boolean {
  return spec.kind === "lts" || (spec.kind === "range" && !spec.open);
}
