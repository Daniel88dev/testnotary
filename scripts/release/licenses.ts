// The license allowlist: which SPDX license expressions a dependency may carry. Used by the CI
// check over every installed package (check-licenses.ts) and by the build over what a bundle
// inlines (notices.ts), where no exception applies.
import { readFileSync } from "node:fs";

export interface Allowlist {
  /** SPDX ids, OSI-approved only. */
  licenses: string[];
  /** Package name to the one license it was reviewed under, and why it may stay. */
  exceptions: Record<string, { license: string; reason: string }>;
}

export interface PackageLicense {
  name: string;
  version: string;
  /** The package's SPDX expression as declared, e.g. `MIT` or `(MIT OR CC0-1.0)`. */
  license: string;
}

export interface Verdict {
  package: PackageLicense;
  /** `allowed`, `exception` (allowed by a named exception), or `refused` with the reason. */
  status: "allowed" | "exception" | "refused";
  reason?: string;
}

export function loadAllowlist(path = new URL("./license-allowlist.json", import.meta.url)): Allowlist {
  return JSON.parse(readFileSync(path, "utf8")) as Allowlist;
}

/**
 * Judges each package against the allowlist. With `exceptions: false` (what a bundle inlines),
 * the named exceptions do not apply: nothing under an exception may be shipped.
 */
export function judge(packages: PackageLicense[], allowlist: Allowlist, options: { exceptions?: boolean } = {}): Verdict[] {
  const allowed = new Set(allowlist.licenses);
  return packages.map((pkg): Verdict => {
    if (satisfies(pkg.license, allowed)) return { package: pkg, status: "allowed" };
    const exception = Object.hasOwn(allowlist.exceptions, pkg.name) ? allowlist.exceptions[pkg.name] : undefined;
    if (exception && options.exceptions !== false) {
      if (exception.license === pkg.license) return { package: pkg, status: "exception", reason: exception.reason };
      return { package: pkg, status: "refused", reason: `is not allowed: its exception was reviewed under ${JSON.stringify(exception.license)}` };
    }
    if (exception) return { package: pkg, status: "refused", reason: "is not allowed in a bundle: its exception covers installing it, never shipping it" };
    return { package: pkg, status: "refused", reason: "is not an allowed license (OSI-approved licenses only)" };
  });
}

/** One line per refused package: `name@version: "license" <reason>`. */
export function describeRefusal(verdict: Verdict): string {
  return `${verdict.package.name}@${verdict.package.version}: ${JSON.stringify(verdict.package.license)} ${verdict.reason}`;
}

/**
 * Whether an SPDX expression can be satisfied with allowed licenses only: `A OR B` needs one side,
 * `A AND B` both, `A WITH exception` and `A+` count as `A`. Anything unparsable is refused.
 */
export function satisfies(expression: string, allowed: ReadonlySet<string>): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const fail = (): never => {
    throw new SyntaxError(expression);
  };
  const or = (): boolean => {
    let result = and();
    while (tokens[at]?.toUpperCase() === "OR") {
      at++;
      const right = and();
      result = result || right;
    }
    return result;
  };
  const and = (): boolean => {
    let result = atom();
    while (tokens[at]?.toUpperCase() === "AND") {
      at++;
      const right = atom();
      result = result && right;
    }
    return result;
  };
  const atom = (): boolean => {
    const token = tokens[at++] ?? fail();
    if (token === "(") {
      const result = or();
      if (tokens[at++] !== ")") fail();
      return result;
    }
    if (token === ")" || /^(AND|OR|WITH)$/i.test(token)) fail();
    if (tokens[at]?.toUpperCase() === "WITH") {
      at++;
      if (!tokens[at++]) fail();
    }
    return allowed.has(token.replace(/\+$/, ""));
  };
  try {
    const result = or();
    return at === tokens.length && tokens.length > 0 && result;
  } catch {
    return false;
  }
}
