import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { displayArgv } from "../../suite-command.ts";
import type { RunCheck } from "../context.ts";

/**
 * `history_dependent_command`: a command that picks its tests by what changed since some commit
 * (`--changed`, `--changedSince`, `--onlyChanged`, `--since`, `nx affected`, turbo's git-ref
 * filters and `--affected`) tests less than the tree it would attest. Checked in the declared argv
 * and in the `package.json` script it names, one level deep: a flag in a script that script calls
 * is left to audits.
 */
export const historyDependentCommand: RunCheck = {
  name: "history_dependent_command",
  async check(context) {
    const { command } = context.suite;
    const inCommand = historyMarker(command);
    if (inCommand) return refuse(inCommand, `the command (${displayArgv(command)})`);
    const named = scriptName(command);
    if (!named) return undefined;
    const text = (await packageScripts(context.root))[named];
    if (text === undefined) return undefined;
    const inScript = historyMarker(shellWords(text));
    if (inScript) return refuse(inScript, `package.json script ${JSON.stringify(named)} (${text}), which the command runs`);
    return undefined;
  },
};

function refuse(marker: string, where: string) {
  return {
    refusal: "history_dependent_command" as const,
    lines: [
      `${marker} in ${where} selects tests by what changed since a commit, so the suite would test less than the tree it attests`,
      "declare a suite that runs every test (without history filters) in testnotary.json on the base branch",
    ],
  };
}

const HISTORY_FLAGS = ["--changed", "--changedSince", "--onlyChanged", "--since", "--affected"];

/** The first history-dependent word or pair of words in `words`, as written, or undefined. */
function historyMarker(words: readonly string[]): string | undefined {
  for (const [index, word] of words.entries()) {
    const flag = word.split("=", 1)[0]!;
    if (HISTORY_FLAGS.includes(flag)) return word;
    if (programName(word) === "nx" && words[index + 1]?.startsWith("affected")) return `nx ${words[index + 1]}`;
    // Turbo's filters name a git range in brackets: `[main]`, `...[HEAD^1]`, `pkg...[origin/main]`.
    if (flag === "--filter" || word === "-F") {
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[index + 1];
      if (value !== undefined && /\[[^\]]*\]/.test(value)) return word.includes("=") ? word : `${word} ${value}`;
    }
  }
  return undefined;
}

function programName(word: string): string {
  return basename(word);
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * The `package.json` script the command runs, if it names one: `npm test`, `npm run <name>`,
 * `npm run-script <name>`, `pnpm [run] <name>`, `yarn [run] <name>`. Options before the name are
 * skipped. For pnpm and yarn a bare word may be a built-in command; it only counts when the
 * package.json has a script by that name.
 */
function scriptName(command: readonly string[]): string | undefined {
  const [program, ...rest] = command;
  if (program === undefined || !PACKAGE_MANAGERS.has(programName(program))) return undefined;
  const words = rest.filter((word) => !word.startsWith("-"));
  const [first, second] = words;
  if (first === undefined) return undefined;
  if (first === "run" || first === "run-script") return second;
  if (["test", "t", "tst"].includes(first)) return "test";
  return first;
}

async function packageScripts(root: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: unknown };
    const scripts = parsed.scripts;
    if (!scripts || typeof scripts !== "object") return {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** A shell command line split into words, roughly as sh would: quotes removed, operators as breaks. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  const end = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(char) || ";&|()<>".includes(char)) {
      end();
    } else {
      word += char;
      started = true;
    }
  }
  end();
  return words;
}
