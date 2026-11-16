// Which package manager a repo uses, which version it pins, and which version a run would get, all
// without running a package manager: `packageManager` and `devEngines.packageManager` in
// `package.json`, the lockfiles, then the tool itself as it lies on PATH.
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import type { Env, RunContext } from "../context.ts";
import { project, readText, type LockfileOwner, type Project } from "./project.ts";

/** The package managers v1 supports. Bun and Deno are refused (`package_manager_unsupported`). */
export const SUPPORTED = ["npm", "pnpm", "yarn"] as const;
export type SupportedPackageManager = (typeof SUPPORTED)[number];

export function isSupported(name: string): name is SupportedPackageManager {
  return (SUPPORTED as readonly string[]).includes(name);
}

export type PackageManagerPin =
  /** `packageManager: "pnpm@10.34.9+sha512…"`: this exact version (the hash is ignored). */
  | { source: "packageManager"; name: string; version: string }
  /** `devEngines.packageManager`: any version in `range` (none given: any version). */
  | { source: "devEngines.packageManager"; name: string; range: string | undefined }
  /** `packageManager` that isn't `<name>@<version>`. */
  | { source: "packageManager"; name: undefined; text: string };

export interface PackageManagerUse {
  /** The tool the repo uses: the pinned one, else the one whose lockfile is there. */
  name: string | undefined;
  pin: PackageManagerPin | undefined;
  /** The lockfile of `name`, when present. */
  lockfile: string | undefined;
}

const PACKAGE_MANAGER = /^(?<name>(?:@[^/@\s]+\/)?[^@\s]+)@(?<version>[^+\s]+)(?:\+\S*)?$/;

/** The repo's package manager and its pin, from `package.json` and the lockfiles. */
export async function packageManagerUse(context: RunContext): Promise<PackageManagerUse> {
  return packageManagerOf(await project(context));
}

/** The same, for a project read with `readProject` (`init` has no run context). */
export function packageManagerOf({ manifest, lockfiles }: Pick<Project, "manifest" | "lockfiles">): PackageManagerUse {
  let pin: PackageManagerPin | undefined;
  const declared = manifest?.packageManager;
  if (typeof declared === "string") {
    const match = PACKAGE_MANAGER.exec(declared.trim());
    pin = match ? { source: "packageManager", name: match.groups!.name!.toLowerCase(), version: match.groups!.version! } : { source: "packageManager", name: undefined, text: declared };
  } else {
    const devEngines = manifest?.devEngines as { packageManager?: unknown } | undefined;
    const entries = [devEngines?.packageManager].flat() as { name?: unknown; version?: unknown }[];
    const entry = entries.find((candidate) => typeof candidate?.name === "string" && candidate.name !== "");
    if (entry) pin = { source: "devEngines.packageManager", name: (entry.name as string).toLowerCase(), range: typeof entry.version === "string" ? entry.version : undefined };
  }
  const name = pin?.name ?? lockfiles[0]?.owner;
  const lockfile = lockfiles.find((found) => found.owner === (name as LockfileOwner))?.file;
  return { name, pin, lockfile };
}

/** How a run learns the version it would use, for the explanation. */
export type VersionInUse =
  | { kind: "found"; version: string; how: string }
  | { kind: "not_on_path" }
  /** On PATH at `path`, but nothing short of running it tells its version. */
  | { kind: "unknown"; path: string };

/**
 * The version of `name` a command in this repo would get, read without running it:
 *
 * 1. `npm_config_user_agent`, which npm, pnpm and Yarn set for what they start (`npx testnotary`,
 *    `pnpm exec testnotary`, `yarn testnotary`): the tool that started this run, so the one in use.
 * 2. The tool on PATH: the `package.json` of the package its bin belongs to (`npm install --global`,
 *    nvm, the standalone pnpm), or Homebrew's `Cellar/<name>/<version>`. A Corepack shim, and
 *    pnpm 10 and later (which switches to `packageManager`'s version unless
 *    `manage-package-manager-versions` is off), run the exact version `packageManager` pins; Yarn
 *    runs the release `yarnPath` in `.yarnrc.yml` names.
 */
export async function versionInUse(context: RunContext, name: SupportedPackageManager, pinned: string | undefined): Promise<VersionInUse> {
  const agent = /^(\S+)\/(\S+)/.exec(context.env.npm_config_user_agent ?? "");
  if (agent && agent[1] === name) return { kind: "found", version: agent[2]!, how: "the package manager that started testnotary" };

  const path = await onPath(name, context.env);
  if (!path) return { kind: "not_on_path" };

  if (name === "yarn") {
    const yarnPath = /^yarnPath:\s*["']?([^"'\n]+?)["']?\s*$/m.exec((await readText(context.root, ".yarnrc.yml")) ?? "")?.[1];
    const release = yarnPath && /^yarn-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.c?js$/.exec(basename(yarnPath));
    if (release) return { kind: "found", version: release[1]!, how: `yarnPath in .yarnrc.yml (${yarnPath})` };
  }

  const real = await realpath(path).catch(() => path);
  const owner = await owningPackage(real);
  if (owner?.name === "corepack") {
    return pinned ? { kind: "found", version: pinned, how: "Corepack, which runs the version packageManager pins" } : { kind: "unknown", path };
  }
  let version: string | undefined;
  const PACKAGES: Record<SupportedPackageManager, string[]> = { npm: ["npm"], pnpm: ["pnpm", "@pnpm/exe"], yarn: ["yarn", "@yarnpkg/cli-dist"] };
  if (owner && PACKAGES[name].includes(owner.name)) version = owner.version;
  if (!version) {
    const cellar = /\/Cellar\/([^/]+)\/([^/]+)\//.exec(real);
    if (cellar && cellar[1] === name) version = cellar[2]!.replace(/_\d+$/, "");
  }
  if (!version) return { kind: "unknown", path };
  if (name === "pnpm" && pinned && Number(version.split(".")[0]) >= 10 && !(await pnpmSwitchingDisabled(context.root))) {
    return { kind: "found", version: pinned, how: `pnpm ${version} on PATH, which switches to the version packageManager pins` };
  }
  return { kind: "found", version, how: path };
}

/** The first executable called `name` on PATH, as the command would find it. */
async function onPath(name: string, env: Env): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if ((await stat(candidate)).isFile()) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The nearest `package.json` above a bin (a few levels up), with its name and version. */
async function owningPackage(file: string): Promise<{ name: string; version: string | undefined } | undefined> {
  let dir = dirname(file);
  for (let level = 0; level < 6; level++) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (typeof parsed.name === "string") return { name: parsed.name, version: typeof parsed.version === "string" ? parsed.version : undefined };
    } catch {
      // No package.json here.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function pnpmSwitchingDisabled(root: string): Promise<boolean> {
  const npmrc = (await readText(root, ".npmrc")) ?? "";
  const workspace = (await readText(root, "pnpm-workspace.yaml")) ?? "";
  return /^\s*manage-package-manager-versions\s*=\s*false\s*$/m.test(npmrc) || /^managePackageManagerVersions:\s*false\s*$/m.test(workspace);
}

/** How to run testnotary through `name`, which then tells it its version. */
export function throughPackageManager(name: SupportedPackageManager): string {
  return { npm: "npx testnotary run", pnpm: "pnpm exec testnotary run", yarn: "yarn testnotary run" }[name];
}

/** How to install `name` at `version` (a version or a range) without Corepack, and with it. */
export function installAdvice(name: string, version: string): string {
  const spec = /^[\w.+-]+$/.test(version) ? `${name}@${version}` : `${name}@"${version}"`;
  return `install it with \`npm install --global ${spec}\`, or let Corepack provide it: \`npm install --global corepack && corepack enable\` (Node 25 and later no longer ship Corepack)`;
}
