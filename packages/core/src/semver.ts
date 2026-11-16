// The part of node-semver's version and range grammar that Node version files and
// `devEngines.packageManager` use: exact versions, partials (`20`, `20.1`, `20.x`), `^`, `~`,
// comparators (`>=20 <23`), hyphen ranges and `||`. Ranges match as node-semver's `satisfies`
// does without `includePrerelease`: a prerelease only satisfies a range that names a prerelease
// of the same major.minor.patch. No dependency, so the library stays free of one.

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** An exact version (`24.11.0`, `v24.11.0`, `10.0.0-rc.1`), or undefined. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
  };
}

export function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; ; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined && y === undefined) return 0;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
}

type Operator = "<" | "<=" | ">" | ">=" | "=";
interface Comparator {
  operator: Operator;
  version: Version;
}
type ComparatorSet = Comparator[];

/** `1`, `1.2`, `1.2.3`, `1.x`, `*`, with an optional prerelease on a full version. */
interface Partial {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: (string | number)[];
}

const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*])(?:\.(\d+|[xX*])(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)?)?$/;

function parsePartial(text: string): Partial | undefined {
  if (text === "" || text === "*" || text === "x" || text === "X") return { prerelease: [] };
  const match = PARTIAL.exec(text);
  if (!match) return undefined;
  const number = (part: string | undefined) => (part === undefined || /^[xX*]$/.test(part) ? undefined : Number(part));
  const major = number(match[1]);
  const minor = major === undefined ? undefined : number(match[2]);
  const patch = minor === undefined ? undefined : number(match[3]);
  const prerelease = patch !== undefined && match[4] ? match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major, minor, patch, prerelease };
}

const v = (major: number, minor: number, patch: number, prerelease: (string | number)[] = []): Version => ({ major, minor, patch, prerelease });
/** The lowest version of a line, below its prereleases too (node-semver's `-0`). */
const floor = (major: number, minor: number, patch: number): Version => v(major, minor, patch, [0]);
const ANY: ComparatorSet = [{ operator: ">=", version: v(0, 0, 0) }];

function fromPartial(operator: string, p: Partial): ComparatorSet | undefined {
  const { major, minor, patch } = p;
  const low = v(major ?? 0, minor ?? 0, patch ?? 0, p.prerelease);
  switch (operator) {
    case "":
    case "=":
      if (major === undefined) return ANY;
      if (minor === undefined) return [{ operator: ">=", version: low }, { operator: "<", version: floor(major + 1, 0, 0) }];
      if (patch === undefined) return [{ operator: ">=", version: low }, { operator: "<", version: floor(major, minor + 1, 0) }];
      return [{ operator: "=", version: low }];
    case "~":
    case "~>":
      if (major === undefined) return ANY;
      if (minor === undefined) return [{ operator: ">=", version: low }, { operator: "<", version: floor(major + 1, 0, 0) }];
      return [{ operator: ">=", version: low }, { operator: "<", version: floor(major, minor + 1, 0) }];
    case "^": {
      if (major === undefined) return ANY;
      let high: Version;
      if (major > 0 || minor === undefined) high = floor(major + 1, 0, 0);
      else if (minor > 0 || patch === undefined) high = floor(0, minor + 1, 0);
      else high = floor(0, 0, patch + 1);
      return [{ operator: ">=", version: low }, { operator: "<", version: high }];
    }
    case ">":
      if (major === undefined) return [{ operator: "<", version: v(0, 0, 0, [0]) }];
      if (minor === undefined) return [{ operator: ">=", version: v(major + 1, 0, 0) }];
      if (patch === undefined) return [{ operator: ">=", version: v(major, minor + 1, 0) }];
      return [{ operator: ">", version: low }];
    case ">=":
      return major === undefined ? ANY : [{ operator: ">=", version: low }];
    case "<":
      if (major === undefined) return [{ operator: "<", version: v(0, 0, 0, [0]) }];
      return [{ operator: "<", version: patch === undefined ? floor(major, minor ?? 0, 0) : low }];
    case "<=":
      if (major === undefined) return ANY;
      if (minor === undefined) return [{ operator: "<", version: floor(major + 1, 0, 0) }];
      if (patch === undefined) return [{ operator: "<", version: floor(major, minor + 1, 0) }];
      return [{ operator: "<=", version: low }];
    default:
      return undefined;
  }
}

function parseSet(text: string): ComparatorSet | undefined {
  const trimmed = text.trim();
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) {
    const from = parsePartial(hyphen[1]!);
    const to = parsePartial(hyphen[2]!);
    if (!from || !to) return undefined;
    const low = fromPartial(">=", from);
    const high = to.major === undefined ? [] : fromPartial("<=", to);
    return low && high ? [...low, ...high] : undefined;
  }
  // `>= 20` is `>=20`: node-semver lets an operator stand apart from its version.
  const tokens = trimmed.replace(/(<=|>=|~>|[<>=~^])\s+/g, "$1").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return ANY;
  const set: ComparatorSet = [];
  for (const token of tokens) {
    const match = /^(<=|>=|~>|[<>=~^])?(.*)$/.exec(token)!;
    const partial = parsePartial(match[2]!);
    if (!partial) return undefined;
    const comparators = fromPartial(match[1] ?? "", partial);
    if (!comparators) return undefined;
    set.push(...comparators);
  }
  return set;
}

function parseRange(range: string): ComparatorSet[] | undefined {
  const sets = range.split("||").map(parseSet);
  return sets.every((set): set is ComparatorSet => set !== undefined) ? sets : undefined;
}

function test(comparator: Comparator, version: Version): boolean {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "=":
      return order === 0;
  }
}

function setSatisfied(set: ComparatorSet, version: Version): boolean {
  if (!set.every((comparator) => test(comparator, version))) return false;
  if (version.prerelease.length === 0) return true;
  // A prerelease counts only where the range itself names a prerelease of that same version.
  return set.some(
    ({ version: c }) =>
      c.prerelease.length > 0 && !(c.prerelease.length === 1 && c.prerelease[0] === 0) && c.major === version.major && c.minor === version.minor && c.patch === version.patch,
  );
}

/** True when `range` is a range this module understands. */
export function isValidRange(range: string): boolean {
  return parseRange(range) !== undefined;
}

/** Whether `version` satisfies `range`; undefined when either can't be read. */
export function satisfies(version: string | Version, range: string): boolean | undefined {
  const parsed = typeof version === "string" ? parseVersion(version) : version;
  const sets = parseRange(range);
  if (!parsed || !sets) return undefined;
  return sets.some((set) => setSatisfied(set, parsed));
}

/**
 * True when no later release can ever fall outside `range` (`>=20`, `*`, `20 || >=22`): whoever
 * resolves it to "the newest that matches", as `actions/setup-node` does, gets a moving target.
 */
export function isOpenRange(range: string): boolean {
  return satisfies(v(Number.MAX_SAFE_INTEGER, 0, 0), range) === true;
}
