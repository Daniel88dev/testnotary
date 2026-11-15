#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };
import { UsageError, type Command } from "./command.ts";
import { commands } from "./commands/index.ts";
import { EXIT } from "./report.ts";

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === "--version" || name === "-v") {
    process.stdout.write(`testnotary ${pkg.version}\n`);
    return 0;
  }
  if (name === "--help" || name === "-h" || name === "help") {
    process.stdout.write(helpText());
    return 0;
  }
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) {
    process.stderr.write(`testnotary: ${name === undefined ? "name a command" : `unknown command ${JSON.stringify(name)}`}\n${helpText()}`);
    return EXIT.usage;
  }
  try {
    return await command.run(args, { cwd: process.cwd(), env: process.env });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`testnotary: ${error.message}\nusage: ${usageLine(command)}\n`);
    return EXIT.usage;
  }
}

function usageLine(command: Command): string {
  return `testnotary ${command.usage}`;
}

function helpText(): string {
  const width = Math.max(...commands.map((command) => usageLine(command).length));
  const lines = commands.map((command) => `  ${usageLine(command).padEnd(width)}  ${command.summary}`);
  return `usage:\n${lines.join("\n")}\n  testnotary --version\n`;
}

process.exitCode = await main(process.argv.slice(2));
