#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  process.stdout.write(`testnotary ${pkg.version}\n`);
  process.exit(0);
}

process.stderr.write("testnotary: no commands yet\n");
process.exit(64);
