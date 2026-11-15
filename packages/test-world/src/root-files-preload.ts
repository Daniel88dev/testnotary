// Loaded with `node --import` into a CLI process that `runCli` starts with `rootFiles`: those
// absolute paths then exist for the process (`fs.existsSync`), though nothing is written outside
// the test's temp directories. It stands in for files a real sandbox has at fixed places, such as
// Devin's `/opt/.devin`. The library itself has no hook for this.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const files = new Set<string>(JSON.parse(process.env.TESTNOTARY_WORLD_ROOT_FILES ?? "[]") as string[]);
const existsSync = fs.existsSync;
fs.existsSync = (path) => (typeof path === "string" && files.has(path)) || existsSync(path);
syncBuiltinESMExports();
