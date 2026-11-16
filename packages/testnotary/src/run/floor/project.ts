// What the environment floor reads from the repo's top level: `package.json`, the lockfiles and
// small config files. Read once per run (the floor's checks share it), never written.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunContext } from "../context.ts";

/** The lockfiles each package manager writes, by the tool's name. */
export const LOCKFILES = {
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  bun: ["bun.lock", "bun.lockb"],
  deno: ["deno.lock"],
} as const;

export type LockfileOwner = keyof typeof LOCKFILES;

export interface Project {
  root: string;
  /** `package.json` at the top level, when there is one and it is a JSON object. */
  manifest: Record<string, unknown> | undefined;
  /** The lockfiles present at the top level, with their owners, in LOCKFILES order. */
  lockfiles: { owner: LockfileOwner; file: string }[];
}

const projects = new WeakMap<RunContext, Promise<Project>>();

/** The repo's top level as the floor sees it (memoised per run). */
export function project(context: RunContext): Promise<Project> {
  let found = projects.get(context);
  if (!found) {
    found = readProject(context.root);
    projects.set(context, found);
  }
  return found;
}

/** The repo's top level read afresh (`init` uses it; a run goes through `project`). */
export async function readProject(root: string): Promise<Project> {
  const text = await readText(root, "package.json");
  let manifest: Record<string, unknown> | undefined;
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
    } catch {
      // Unreadable: the floor treats the repo as having no package.json.
    }
  }
  const lockfiles: Project["lockfiles"] = [];
  for (const [owner, files] of Object.entries(LOCKFILES) as [LockfileOwner, readonly string[]][]) {
    for (const file of files) if ((await readBytes(root, file)) !== undefined) lockfiles.push({ owner, file });
  }
  return { root, manifest, lockfiles };
}

/** A file's text, or undefined when it can't be read. */
export async function readText(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

export async function readBytes(root: string, path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(join(root, path));
  } catch {
    return undefined;
  }
}
