// Whether the installed dependencies match the lockfile, read from the state file each package
// manager writes at the end of an install. Testnotary never runs an install or a package-manager
// command. Each comparison follows the tool's own:
//
// - npm: the hidden lockfile `node_modules/.package-lock.json` (npm's record of what is in
//   `node_modules`) against `package-lock.json`, entry by entry (version, resolved, integrity,
//   link), the lockfile's root entry aside. An optional package left out (another platform's) is
//   fine; anything else missing, different or extra is stale.
// - pnpm 11 and later: `validation.lockfile` in `node_modules/.pnpm-workspace-state-v1.json`, the
//   first 32 hex digits of the SHA-256 of the `pnpm-lock.yaml` it installed.
// - pnpm 10, whose state file has no digest: `node_modules/.pnpm/lock.yaml`, the copy of the
//   lockfile it installed, byte for byte.
// - Yarn Berry: `lockFileChecksum` in `.yarn/install-state.gz` (or `installStatePath`), the SHA-512
//   of Yarn's install-state version followed by `yarn.lock`'s text, as Yarn compares it.
// - Yarn classic: `node_modules/.yarn-integrity`, whose `systemParams` must be this machine's
//   (`<platform>-<arch>-<Node modules ABI>`) and whose `lockfileEntries` must equal `yarn.lock`'s
//   patterns and resolved URLs, as Yarn's own integrity check does.
//
// Hand edits inside `node_modules` are not detected.
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { gunzipSync } from "node:zlib";
import { readBytes, readText } from "./project.ts";
import type { SupportedPackageManager } from "./package-manager.ts";

/** Why the install is stale, as lines for the refusal; undefined when it matches the lockfile. */
export async function installProblem(root: string, name: SupportedPackageManager, lockfile: string): Promise<string[] | undefined> {
  const reinstall = `run \`${{ npm: "npm ci", pnpm: "pnpm install", yarn: "yarn install" }[name]}\`, then run again`;
  const lockText = await readText(root, lockfile);
  if (lockText === undefined) return [`${lockfile} can't be read`, reinstall];
  const result = await compare(root, name, lockfile, lockText);
  if (result.kind === "ok") return undefined;
  if (result.kind === "missing") return [`${result.file} is missing, so the installed dependencies can't be shown to match ${lockfile}: they were never installed here, or not by ${name}`, reinstall];
  if (result.kind === "unreadable") return [`${result.file} can't be read (${result.reason}), so the installed dependencies can't be shown to match ${lockfile}`, reinstall];
  return [`the installed dependencies don't match ${lockfile}: ${result.detail}`, reinstall];
}

type Comparison =
  | { kind: "ok" }
  | { kind: "missing"; file: string }
  | { kind: "unreadable"; file: string; reason: string }
  | { kind: "stale"; detail: string };

async function compare(root: string, name: SupportedPackageManager, lockfile: string, lockText: string): Promise<Comparison> {
  switch (name) {
    case "npm":
      return compareNpm(root, lockfile, lockText);
    case "pnpm":
      return comparePnpm(root, lockText);
    case "yarn":
      return /^__metadata:/m.test(lockText) ? compareYarnBerry(root, lockText) : compareYarnClassic(root, lockText);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type NpmEntry = Record<string, unknown>;

async function compareNpm(root: string, lockfile: string, lockText: string): Promise<Comparison> {
  const STATE = "node_modules/.package-lock.json";
  const wanted = (parseJson(lockText) as { packages?: Record<string, NpmEntry> } | undefined)?.packages;
  if (!wanted) return { kind: "stale", detail: `${lockfile} lists no packages (a lockfile from npm 6 or earlier); npm install rewrites it` };
  const stateText = await readText(root, STATE);
  if (stateText === undefined) return { kind: "missing", file: STATE };
  const installed = (parseJson(stateText) as { packages?: Record<string, NpmEntry> } | undefined)?.packages;
  if (typeof installed !== "object" || installed === null) return { kind: "unreadable", file: STATE, reason: "not a lockfile" };

  for (const [location, entry] of Object.entries(wanted)) {
    if (location === "") continue;
    const there = installed[location];
    if (!there) {
      if (entry.optional === true) continue;
      return { kind: "stale", detail: `${location} is locked at ${String(entry.version ?? entry.resolved)} but isn't installed` };
    }
    for (const field of ["version", "resolved", "integrity", "link"]) {
      if (entry[field] !== there[field]) {
        return { kind: "stale", detail: `${location} is locked at ${describe(entry)}, installed at ${describe(there)}` };
      }
    }
  }
  for (const location of Object.keys(installed)) {
    if (!(location in wanted)) return { kind: "stale", detail: `${location} is installed but not in ${lockfile}` };
  }
  return { kind: "ok" };
}

function describe(entry: NpmEntry): string {
  return String(entry.version ?? entry.resolved ?? "a link");
}

async function comparePnpm(root: string, lockText: string): Promise<Comparison> {
  const STATE = "node_modules/.pnpm-workspace-state-v1.json";
  const stateText = await readText(root, STATE);
  if (stateText === undefined) return { kind: "missing", file: STATE };
  const state = parseJson(stateText) as { validation?: { lockfile?: unknown } } | undefined;
  if (typeof state !== "object" || state === null) return { kind: "unreadable", file: STATE, reason: "not JSON" };

  const digest = state.validation?.lockfile;
  if (typeof digest === "string") {
    const now = createHash("sha256").update(lockText).digest("hex").slice(0, 32);
    return digest === now ? { kind: "ok" } : { kind: "stale", detail: "pnpm-lock.yaml changed since the last pnpm install" };
  }
  // pnpm 10 records no digest; the lockfile it installed is kept beside the packages.
  const CURRENT = "node_modules/.pnpm/lock.yaml";
  const current = await readText(root, CURRENT);
  if (current === undefined) return { kind: "missing", file: CURRENT };
  return current === lockText ? { kind: "ok" } : { kind: "stale", detail: `pnpm-lock.yaml changed since the last pnpm install (${CURRENT} differs)` };
}

async function compareYarnBerry(root: string, lockText: string): Promise<Comparison> {
  const configured = /^installStatePath:\s*["']?([^"'\n]+?)["']?\s*$/m.exec((await readText(root, ".yarnrc.yml")) ?? "")?.[1];
  const STATE = configured ?? ".yarn/install-state.gz";
  const bytes = await readBytes(root, STATE);
  if (bytes === undefined) return { kind: "missing", file: STATE };
  let checksum: unknown;
  try {
    checksum = (deserialize(gunzipSync(bytes)) as { lockFileChecksum?: unknown }).lockFileChecksum;
  } catch (error) {
    return { kind: "unreadable", file: STATE, reason: error instanceof Error ? error.message : String(error) };
  }
  if (typeof checksum !== "string") return { kind: "unreadable", file: STATE, reason: "it holds no lockFileChecksum" };
  // Yarn salts the checksum with its install-state version (3 today); any version of it will do,
  // the lockfile's text has to be the same.
  for (const salt of ["", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    if (createHash("sha512").update(`${salt}${lockText}`).digest("hex") === checksum) return { kind: "ok" };
  }
  return { kind: "stale", detail: "yarn.lock changed since the last yarn install" };
}

async function compareYarnClassic(root: string, lockText: string): Promise<Comparison> {
  const STATE = "node_modules/.yarn-integrity";
  const stateText = await readText(root, STATE);
  if (stateText === undefined) return { kind: "missing", file: STATE };
  const state = parseJson(stateText) as { systemParams?: unknown; lockfileEntries?: unknown } | undefined;
  if (typeof state !== "object" || state === null || typeof state.lockfileEntries !== "object" || state.lockfileEntries === null) {
    return { kind: "unreadable", file: STATE, reason: "not a Yarn integrity file" };
  }
  const here = `${process.platform}-${process.arch}-${process.versions.modules ?? ""}`;
  if (state.systemParams !== here) return { kind: "stale", detail: `the install was made for ${String(state.systemParams)}, and this machine and Node are ${here}` };
  const installed = state.lockfileEntries as Record<string, unknown>;
  const wanted = classicLockfileEntries(lockText);
  for (const [pattern, resolved] of wanted) {
    if (installed[pattern] !== resolved) return { kind: "stale", detail: `${pattern} changed since the last yarn install` };
  }
  for (const pattern of Object.keys(installed)) if (!wanted.has(pattern)) return { kind: "stale", detail: `${pattern} is installed but no longer in yarn.lock` };
  return { kind: "ok" };
}

/** Each pattern of a Yarn classic (v1) lockfile, with its `resolved` URL ("" when it has none). */
function classicLockfileEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  let current: string[] = [];
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, "$1");
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    if (!/^\s/.test(line) && line.endsWith(":")) {
      current = line.slice(0, -1).split(/,\s*/).map(unquote);
      for (const pattern of current) entries.set(pattern, "");
      continue;
    }
    const resolved = /^ {2}resolved\s+(.+)$/.exec(line);
    if (resolved) for (const pattern of current) entries.set(pattern, unquote(resolved[1]!));
  }
  return entries;
}
