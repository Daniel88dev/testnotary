// The CI license allowlist (`pnpm licenses:check`): every package installed anywhere in the
// workspace, dev dependencies included, must carry an OSI-approved license, or be a named exception
// in license-allowlist.json under the exact license it was reviewed with.
//
//   node scripts/release/check-licenses.ts                  reads `pnpm licenses list --json -r`
//   node scripts/release/check-licenses.ts --input <file>   reads that output from a file
//
// Exit 0 when everything is allowed, 1 with one line per refused package on stderr.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describeRefusal, judge, loadAllowlist, type PackageLicense } from "./licenses.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

type Listing = Record<string, { name: string; versions: string[]; license?: string }[]>;

const { values } = parseArgs({ options: { input: { type: "string" } } });
const raw = values.input
  ? readFileSync(values.input, "utf8")
  : execFileSync("pnpm", ["licenses", "list", "--json", "--recursive"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const packages: PackageLicense[] = Object.entries(JSON.parse(raw) as Listing).flatMap(([group, entries]) =>
  entries.flatMap((entry) => entry.versions.map((version) => ({ name: entry.name, version, license: entry.license ?? group }))),
);
const verdicts = judge(packages, loadAllowlist());

for (const verdict of verdicts.filter((v) => v.status === "exception")) {
  process.stdout.write(`${verdict.package.name}@${verdict.package.version}: ${verdict.package.license}, allowed as an exception: ${verdict.reason}\n`);
}
const refused = verdicts.filter((verdict) => verdict.status === "refused");
if (refused.length > 0) {
  for (const verdict of refused) process.stderr.write(`${describeRefusal(verdict)}\n`);
  process.stderr.write(`${refused.length} of ${packages.length} packages carry a license the allowlist refuses (scripts/release/license-allowlist.json).\n`);
  process.exit(1);
}
process.stdout.write(`${packages.length} packages checked: all allowed.\n`);
