// Builds what ships from reviewed source:
//
//   node scripts/release/build.ts action  [--out <dir>]   → <dir>/action/index.js, <dir>/licenses.txt (default <repo>/dist)
//   node scripts/release/build.ts library [--out <dir>]   → <dir>/cli.js, <dir>/licenses.txt (default packages/testnotary/dist)
//   node scripts/release/build.ts                         → both, at their defaults
//
// The action bundle runs on the runner's Node 24 (`runs.using: node24` in action.yml); the library
// runs on the users' Node, from 20 up (`engines` in its package.json). Both inline the workspace
// packages and their dependencies, so neither installs anything at runtime, and each gets the
// third-party notices of what it inlined.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build, type BuildOptions } from "esbuild";
import { bundledPackages, thirdPartyNotices } from "./notices.ts";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

const common: BuildOptions = {
  absWorkingDir: repoRoot,
  bundle: true,
  platform: "node",
  format: "esm",
  metafile: true,
  // Notices go into licenses.txt; the bundle itself stays plain.
  legalComments: "none",
  logLevel: "warning",
  // A CommonJS dependency's `require` of a Node builtin still works inside the ES module.
  banner: { js: "import { createRequire as __testnotaryCreateRequire } from 'node:module'; const require = __testnotaryCreateRequire(import.meta.url);" },
};

/** The action bundle: `<out>/action/index.js` (the `runs.main` of action.yml) and `<out>/licenses.txt`. */
export async function buildAction(out = join(repoRoot, "dist")): Promise<void> {
  await rm(join(out, "action"), { recursive: true, force: true });
  const result = await build({
    ...common,
    entryPoints: [join(repoRoot, "packages/action/src/main.ts")],
    outfile: join(out, "action", "index.js"),
    target: "node24",
  });
  // On the tagged commit the root package.json says `"type": "module"` too; this keeps the bundle
  // an ES module wherever it is copied.
  await writeFile(join(out, "action", "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  await writeFile(join(out, "licenses.txt"), thirdPartyNotices("The Testnotary action (dist/action/index.js)", bundledPackages(result.metafile!, repoRoot)));
}

/** The library's CLI for npm: `<out>/cli.js` (the `testnotary` bin) and `<out>/licenses.txt`. */
export async function buildLibrary(out = join(repoRoot, "packages/testnotary/dist")): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const result = await build({
    ...common,
    entryPoints: [join(repoRoot, "packages/testnotary/src/cli.ts")],
    outfile: join(out, "cli.js"),
    // The library's floor (`engines.node`): syntax newer than Node 20 is lowered or refused here.
    target: "node20",
  });
  await writeFile(join(out, "licenses.txt"), thirdPartyNotices("The testnotary package (dist/cli.js)", bundledPackages(result.metafile!, repoRoot)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
  const [what = "all"] = positionals;
  if (!["action", "library", "all"].includes(what) || (what === "all" && values.out)) {
    process.stderr.write("usage: build.ts [action|library] [--out <dir>]\n");
    process.exit(64);
  }
  try {
    if (what !== "library") await buildAction(values.out);
    if (what !== "action") await buildLibrary(values.out);
  } catch (error) {
    process.stderr.write(`build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
