// Stand-ins for `npx`, `pnpm` and `yarn` on the simulated runner, so action tests never need a real
// package manager or the network. Each runner puts small scripts first on PATH that run this file:
// `package-manager-stub.ts <tool> <log file> <args…>`. A stub appends its argv to the log, then
// does what the real tool does with a locally installed bin: it looks for
// `node_modules/.bin/<name>` from the working directory up and runs it, or fails as the real tool
// does when the package isn't installed. Only the forms the action uses are understood:
// `npx --no-install <bin> …`, `pnpm exec <bin> …`, `yarn <bin> …`.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const [tool, log, ...args] = process.argv.slice(2);
if (!tool || !log) throw new Error("usage: package-manager-stub.ts <tool> <log file> …");
appendFileSync(log, `${JSON.stringify([tool, ...args])}\n`);

function localBin(name: string): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

let bin: string | undefined;
let rest: string[] = [];
if (tool === "npx" && args[0] === "--no-install" && args[1]) {
  bin = args[1];
  rest = args.slice(2);
  if (!localBin(bin)) fail(`npm error npx canceled due to missing packages and no YES option: ["${bin}"]`);
} else if (tool === "pnpm" && args[0] === "exec" && args[1]) {
  bin = args[1];
  rest = args.slice(2);
  if (!localBin(bin)) fail(` ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "${bin}" not found`);
} else if (tool === "yarn" && args[0]) {
  bin = args[0];
  rest = args.slice(1);
  if (!localBin(bin)) fail(`Usage Error: Couldn't find a script named "${bin}".`);
} else {
  fail(`${tool}: the test world's stub does not understand ${JSON.stringify(args)}`, 2);
}

const child = spawnSync(localBin(bin)!, rest, { stdio: "inherit" });
if (child.error) fail(`${tool}: ${child.error.message}`);
process.exit(child.status ?? 1);
