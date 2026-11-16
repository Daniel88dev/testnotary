// Guarded files: a change to one can make CI behave differently from the run that attested the
// tree, so a pull request that changes one always runs its tests (`guarded_file_changed`). The
// product defaults below can't be removed; a repo adds globs with `guarded` in `testnotary.json`.
// The service decides with these, the library records which globs a run's change matched, and the
// docs and the dashboard show the same list. Pure functions: no I/O, safe in a browser bundle.
import type { TestnotaryConfig } from "./config.ts";

/**
 * The product-default guarded globs, which a repo can't remove. They match the way `.gitignore`
 * lines do (see `matchesGuardedGlob`): a name with no `/`, such as `package.json`, matches at any
 * depth, so these cover every `package.json` and every lockfile in a monorepo.
 */
export const GUARDED_DEFAULTS: readonly string[] = [
  ".github/workflows/**",
  ".github/actions/**",
  "testnotary.json",
  ".testnotary/allowed_signers",
  // every lockfile
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  // every package.json
  "package.json",
  // the Node version files
  ".nvmrc",
  ".node-version",
  ".tool-versions",
];

/**
 * The guarded globs in effect for a config (the one at the built commit's first parent): the
 * product defaults, then the file `nodeVersionFile` names (it picks CI's Node like `.nvmrc`), then
 * the repo's own `guarded` globs. Without a config, the defaults alone.
 */
export function guardedGlobs(config?: Pick<TestnotaryConfig, "guarded" | "nodeVersionFile">): string[] {
  const globs = [...GUARDED_DEFAULTS];
  const versionFile = config?.nodeVersionFile?.replace(/^(\.\/)+/, "");
  if (versionFile && !globs.some((glob) => matchesGuardedGlob(glob, versionFile))) globs.push(`/${literal(versionFile)}`);
  globs.push(...(config?.guarded ?? []));
  return [...new Set(globs)];
}

/** One changed path that a guarded glob matched. */
export interface GuardedMatch {
  path: string;
  glob: string;
}

/**
 * Every changed path a glob matches, in the order of `paths`, each with the first glob that
 * matched it. Paths are repo-relative with `/`, as git and GitHub's compare give them.
 */
export function guardedMatches(paths: readonly string[], globs: readonly string[]): GuardedMatch[] {
  const compiled = globs.map((glob) => ({ glob, test: compile(glob) }));
  const matches: GuardedMatch[] = [];
  for (const path of paths) {
    const hit = compiled.find((entry) => entry.test(path));
    if (hit) matches.push({ path, glob: hit.glob });
  }
  return matches;
}

/**
 * Whether a guarded glob matches a changed file, the way a `.gitignore` line matches:
 * - a glob with no `/` but at its end (`package.json`, `*.sql`) matches the name at any depth;
 * - any other glob is anchored at the repo root, and a leading `/` only anchors it
 *   (`/scripts/*.sh`, `docker/**`);
 * - a glob that matches a directory matches everything under it (`docker`, `docker/`);
 * - `*` and `?` stay within one path segment, `**` spans any number of them, `[abc]`/`[!abc]` is a
 *   class and `{a,b}` an alternative; a backslash takes the next character literally.
 * Dotfiles match like any other name. A leading `!` is a literal character: a repo can't use a
 * glob to remove a guarded file.
 */
export function matchesGuardedGlob(glob: string, path: string): boolean {
  return compile(glob)(path);
}

const cache = new Map<string, (path: string) => boolean>();

function compile(glob: string): (path: string) => boolean {
  const cached = cache.get(glob);
  if (cached) return cached;
  let pattern = glob.trim();
  const directory = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  const anchored = pattern.includes("/");
  pattern = pattern.replace(/^\/+/, "");
  const body = segmentsToRegExp(pattern);
  // A directory glob matches only what lies under it; any other also matches a directory's contents.
  const regExp = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${directory ? "/.+" : "(?:/.+)?"}$`);
  const test = (path: string) => pattern.length > 0 && regExp.test(path.replace(/^\/+/, ""));
  cache.set(glob, test);
  return test;
}

function segmentsToRegExp(pattern: string): string {
  const segments = pattern.split("/");
  let out = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // `a/**/b`: zero or more directories; a trailing `**`: anything at all below.
      out += last ? ".+" : "(?:[^/]+/)*";
      return;
    }
    out += segmentToRegExp(segment) + (last ? "" : "/");
  });
  return out;
}

function segmentToRegExp(segment: string): string {
  let out = "";
  let braces = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "\\" && i + 1 < segment.length) {
      out += escapeRegExp(segment[++i]!);
    } else if (c === "*") {
      while (segment[i + 1] === "*") i++;
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      let inner = segment.slice(i + 1, end);
      const negated = inner.startsWith("!") || inner.startsWith("^");
      if (negated) inner = inner.slice(1);
      out += `[${negated ? "^/" : ""}${inner.replace(/[\\\]^]/g, "\\$&")}]`;
      i = end;
    } else if (c === "{" && segment.indexOf("}", i) !== -1) {
      braces++;
      out += "(?:";
    } else if (c === "," && braces > 0) {
      out += "|";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else {
      out += escapeRegExp(c);
    }
  }
  return out + ")".repeat(braces);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** A path as a glob that matches exactly it. */
function literal(path: string): string {
  return path.replace(/[\\*?[\]{}]/g, "\\$&");
}
