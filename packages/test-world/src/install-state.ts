// Fixture projects for each package manager: the committed `package.json` and lockfile, and the
// install-state files an install leaves behind, written by hand in each tool's own format (no
// package manager runs, nothing is downloaded). The formats were read off real installs:
//
// - npm (lockfile v3): `node_modules/.package-lock.json`, the "hidden lockfile", lists the
//   installed packages as `package-lock.json` does, without its root ("") entry.
// - pnpm 11 and later: `node_modules/.pnpm-workspace-state-v1.json` records the lockfile it
//   installed as `validation.lockfile`, the first 32 hex digits of the lockfile's SHA-256.
// - pnpm 10: the same state file without `validation`; the lockfile it installed is copied to
//   `node_modules/.pnpm/lock.yaml`.
// - Yarn Berry: `.yarn/install-state.gz` is a gzipped `v8.serialize` of the project's install
//   state, whose `lockFileChecksum` is the SHA-512 hex of the install-state version ("3") followed by
//   `yarn.lock`'s text (yarnpkg/berry `Project.ts`, `makeLockfileChecksum`).
// - Yarn classic: `node_modules/.yarn-integrity` holds `systemParams` (`<platform>-<arch>-<modules ABI>`)
//   and `lockfileEntries`, each `yarn.lock` pattern mapped to its `resolved` URL.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { serialize } from "node:v8";
import { gzipSync } from "node:zlib";

export type InstallState = "npm" | "pnpm" | "pnpm-10" | "yarn-berry" | "yarn-classic";

export interface InstalledProject {
  /** For the base commit: `package.json`, the lockfile and a `.gitignore` covering the install. */
  files: Record<string, string>;
  /** The lockfile's path. */
  lockfile: string;
  /** What an install of `files` left behind in the repo at `dir`: write it after the commit. */
  installed(dir: string): Record<string, string | Uint8Array>;
  /** The lockfile after a dependency bump (left-pad 1.2.0 → 1.3.0): commit it to leave the install stale. */
  bumped: Record<string, string>;
}

export interface InstalledProjectOptions {
  name?: string;
  /** `package.json`'s `packageManager`, e.g. `pnpm@10.34.9`. */
  packageManager?: string;
  /** More `package.json` fields. */
  manifest?: Record<string, unknown>;
}

const RANGE = "^1.2.0";
const integrity = (version: string) => `sha512-${createHash("sha512").update(`left-pad@${version}`).digest("base64")}`;
const sha1 = (version: string) => createHash("sha1").update(`left-pad@${version}`).digest("hex");

function manifest(options: InstalledProjectOptions): string {
  const name = options.name ?? "widgets";
  const fields = { name, version: "1.0.0", private: true, ...(options.packageManager ? { packageManager: options.packageManager } : {}), dependencies: { "left-pad": RANGE }, ...options.manifest };
  return `${JSON.stringify(fields, null, 2)}\n`;
}

function npmLock(name: string, version: string, hidden: boolean): string {
  const root = { "": { name, version: "1.0.0", dependencies: { "left-pad": RANGE } } };
  const packages = {
    ...(hidden ? {} : root),
    "node_modules/left-pad": {
      version,
      resolved: `https://registry.npmjs.org/left-pad/-/left-pad-${version}.tgz`,
      integrity: integrity(version),
      deprecated: "use String.prototype.padStart()",
      license: "WTFPL",
    },
  };
  return `${JSON.stringify({ name, version: "1.0.0", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

function pnpmLock(version: string): string {
  return [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      left-pad:",
    `        specifier: ${RANGE}`,
    `        version: ${version}`,
    "",
    "packages:",
    "",
    `  left-pad@${version}:`,
    `    resolution: {integrity: ${integrity(version)}}`,
    "    deprecated: use String.prototype.padStart()",
    "",
    "snapshots:",
    "",
    `  left-pad@${version}: {}`,
    "",
  ].join("\n");
}

function pnpmState(dir: string, name: string, lockfile: string | undefined): string {
  const settings = { autoInstallPeers: true, catalogs: {}, dedupeDirectDeps: false, dev: true, nodeLinker: "isolated", optional: true, production: true };
  const state: Record<string, unknown> = { lastValidatedTimestamp: Date.now(), projects: { [dir]: { name, version: "1.0.0" } }, pnpmfiles: [], filteredInstall: false, settings };
  if (lockfile !== undefined) {
    const digest = createHash("sha256").update(lockfile).digest("hex").slice(0, 32);
    state.validation = {
      recordedAtNs: Date.now() * 1_000_000,
      files: { [join(dir, "pnpm-lock.yaml")]: { mtimeNs: Date.now() * 1_000_000, ctimeNs: Date.now() * 1_000_000, size: lockfile.length, digest } },
      lockfile: digest,
      manifests: { ".": createHash("sha256").update(name).digest("hex").slice(0, 32) },
    };
  }
  return `${JSON.stringify(state, null, 2)}\n`;
}

function berryLock(name: string, version: string): string {
  return [
    "# This file is generated by running \"yarn install\" inside your project.",
    "# Manual changes might be lost - proceed with caution!",
    "",
    "__metadata:",
    "  version: 8",
    "  cacheKey: 10c0",
    "",
    `"left-pad@npm:${RANGE}":`,
    `  version: ${version}`,
    `  resolution: "left-pad@npm:${version}"`,
    `  checksum: 10c0/${createHash("sha512").update(version).digest("hex")}`,
    "  languageName: node",
    "  linkType: hard",
    "",
    `"${name}@workspace:.":`,
    "  version: 0.0.0-use.local",
    `  resolution: "${name}@workspace:."`,
    "  dependencies:",
    `    left-pad: "npm:${RANGE}"`,
    "  languageName: unknown",
    "  linkType: soft",
    "",
  ].join("\n");
}

function berryState(lockfile: string): Uint8Array {
  const state = {
    linkersCustomData: new Map(),
    accessibleLocators: new Set(["left-pad@npm:1.2.0"]),
    conditionalLocators: new Set(),
    disabledLocators: new Set(),
    optionalBuilds: new Set(),
    storedDescriptors: new Map(),
    storedResolutions: new Map(),
    storedPackages: new Map(),
    lockFileChecksum: createHash("sha512").update(`3${lockfile}`).digest("hex"),
    skippedBuilds: new Set(),
    storedBuildState: new Map(),
  };
  return gzipSync(serialize(state));
}

function classicLock(version: string): string {
  return [
    "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
    "# yarn lockfile v1",
    "",
    "",
    `left-pad@${RANGE}:`,
    `  version "${version}"`,
    `  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-${version}.tgz#${sha1(version)}"`,
    `  integrity ${integrity(version)}`,
    "",
  ].join("\n");
}

function classicIntegrity(version: string): string {
  const integrityFile = {
    systemParams: `${process.platform}-${process.arch}-${process.versions.modules}`,
    modulesFolders: ["node_modules"],
    flags: [],
    linkedModules: [],
    topLevelPatterns: [`left-pad@${RANGE}`],
    lockfileEntries: { [`left-pad@${RANGE}`]: `https://registry.yarnpkg.com/left-pad/-/left-pad-${version}.tgz#${sha1(version)}` },
    files: [],
    artifacts: {},
  };
  return `${JSON.stringify(integrityFile, null, 2)}\n`;
}

/** A project with one dependency (left-pad), its lockfile, and what installing it leaves behind. */
export function installedProject(kind: InstallState, options: InstalledProjectOptions = {}): InstalledProject {
  const name = options.name ?? "widgets";
  const packageJson = manifest(options);
  switch (kind) {
    case "npm":
      return {
        files: { "package.json": packageJson, "package-lock.json": npmLock(name, "1.2.0", false), ".gitignore": "node_modules/\n" },
        lockfile: "package-lock.json",
        installed: () => ({ "node_modules/.package-lock.json": npmLock(name, "1.2.0", true), "node_modules/left-pad/package.json": '{ "name": "left-pad", "version": "1.2.0" }\n' }),
        bumped: { "package-lock.json": npmLock(name, "1.3.0", false) },
      };
    case "pnpm":
    case "pnpm-10": {
      const lockfile = pnpmLock("1.2.0");
      return {
        files: { "package.json": packageJson, "pnpm-lock.yaml": lockfile, ".gitignore": "node_modules/\n" },
        lockfile: "pnpm-lock.yaml",
        installed: (dir) =>
          kind === "pnpm"
            ? { "node_modules/.pnpm-workspace-state-v1.json": pnpmState(dir, name, lockfile), "node_modules/.pnpm/lock.yaml": lockfile }
            : { "node_modules/.pnpm-workspace-state-v1.json": pnpmState(dir, name, undefined), "node_modules/.pnpm/lock.yaml": lockfile },
        bumped: { "pnpm-lock.yaml": pnpmLock("1.3.0") },
      };
    }
    case "yarn-berry": {
      const lockfile = berryLock(name, "1.2.0");
      return {
        files: { "package.json": packageJson, "yarn.lock": lockfile, ".yarnrc.yml": "nodeLinker: node-modules\n", ".gitignore": "node_modules/\n.yarn/install-state.gz\n" },
        lockfile: "yarn.lock",
        installed: () => ({ ".yarn/install-state.gz": berryState(lockfile), "node_modules/left-pad/package.json": '{ "name": "left-pad", "version": "1.2.0" }\n' }),
        bumped: { "yarn.lock": berryLock(name, "1.3.0") },
      };
    }
    case "yarn-classic":
      return {
        files: { "package.json": packageJson, "yarn.lock": classicLock("1.2.0"), ".gitignore": "node_modules/\n" },
        lockfile: "yarn.lock",
        installed: () => ({ "node_modules/.yarn-integrity": classicIntegrity("1.2.0"), "node_modules/left-pad/package.json": '{ "name": "left-pad", "version": "1.2.0" }\n' }),
        bumped: { "yarn.lock": classicLock("1.3.0") },
      };
  }
}
