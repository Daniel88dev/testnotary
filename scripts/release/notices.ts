// Third-party notices for a bundle: every package esbuild inlined from node_modules, with its
// license and the license text it ships, written beside the bundle as `licenses.txt`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metafile } from "esbuild";
import { describeRefusal, judge, loadAllowlist, type PackageLicense } from "./licenses.ts";

interface BundledPackage extends PackageLicense {
  dir: string;
  repository?: string;
}

/** The packages a bundle inlined from node_modules (workspace packages are first-party). */
export function bundledPackages(metafile: Metafile, root: string): BundledPackage[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) dirs.add(join(root, match[1]!));
  }
  const byId = new Map<string, BundledPackage>();
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license?: string | { type?: string };
      repository?: string | { url?: string };
    };
    const license = typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "UNKNOWN");
    const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    byId.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, version: manifest.version, license, dir, repository });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * The notices text for `subject` (what the bundle is), or a thrown error naming each inlined
 * package whose license is not on the allowlist: a bundle may never ship an exception.
 */
export function thirdPartyNotices(subject: string, packages: BundledPackage[]): string {
  const refused = judge(packages, loadAllowlist(), { exceptions: false }).filter((verdict) => verdict.status === "refused");
  if (refused.length > 0) {
    throw new Error(
      `the bundle would ship packages whose license is not allowed:\n${refused.map((verdict) => `  ${describeRefusal(verdict)}`).join("\n")}`,
    );
  }
  const rule = "=".repeat(80);
  const sections = packages.map((pkg) => {
    const header = [`${pkg.name} ${pkg.version}`, `License: ${pkg.license}`, ...(pkg.repository ? [`Source: ${pkg.repository.replace(/^git\+/, "")}`] : [])];
    const text = licenseText(pkg.dir);
    return `${rule}\n${header.join("\n")}\n\n${text ?? "(The package ships no license file; its package.json declares the license above.)"}\n`;
  });
  const intro =
    packages.length === 0
      ? `${subject} bundles no third-party packages.\n`
      : `${subject} bundles the following third-party packages. Each is listed with its license and the license text it ships.\n`;
  return `Third-party notices\n\n${intro}${sections.map((section) => `\n${section}`).join("")}`;
}

function licenseText(dir: string): string | undefined {
  const files = readdirSync(dir)
    .filter((name) => /^(licen[cs]e|copying|notice)(\b|[._-]|$)/i.test(name))
    .sort();
  if (files.length === 0) return undefined;
  return files.map((name) => readFileSync(join(dir, name), "utf8").trimEnd()).join("\n\n");
}
