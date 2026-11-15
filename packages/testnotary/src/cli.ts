#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };
import { commands } from "./commands/index.ts";
import { EXIT } from "./output.ts";

const [name, ...args] = process.argv.slice(2);

if (name === "--version" || name === "-v") {
  process.stdout.write(`testnotary ${pkg.version}\n`);
  process.exit(EXIT.ok);
}

const command = name ? commands[name] : undefined;
if (!command) {
  const width = Math.max(...Object.keys(commands).map((key) => key.length));
  const lines = Object.entries(commands).map(([key, { summary }]) => `  ${key.padEnd(width)}  ${summary}`);
  process.stderr.write(`${name ? `testnotary: unknown command "${name}"\n` : ""}usage: testnotary <command> [--json]\n\n${lines.join("\n")}\n`);
  process.exit(EXIT.usage);
}

process.exitCode = await command.run(args);
