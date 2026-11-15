// A stand-in for the OS keychain tools, so CLI tests never touch the real keychain. Each machine
// (see machine.ts) puts `security` (macOS) and `secret-tool` (Linux libsecret) first on PATH as
// small scripts that run this file: `keychain-stub.ts <tool> <machine dir> <tool args…>`.
// Entries live in `<machine dir>/keychain.json`; `<machine dir>/keychain-mode` set to
// `unavailable` makes every call fail the way a locked or absent keychain does.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface KeychainEntry {
  service: string;
  account: string;
  secret: string;
}

const [tool, dir, ...args] = process.argv.slice(2);
if (!tool || !dir) throw new Error("usage: keychain-stub.ts <tool> <machine dir> …");
const storePath = join(dir, "keychain.json");

function load(): KeychainEntry[] {
  try {
    return JSON.parse(readFileSync(storePath, "utf8")) as KeychainEntry[];
  } catch {
    return [];
  }
}

function save(entries: KeychainEntry[]): void {
  writeFileSync(storePath, JSON.stringify(entries, null, 2));
}

function unavailable(): boolean {
  try {
    return readFileSync(join(dir!, "keychain-mode"), "utf8").trim() === "unavailable";
  } catch {
    return false;
  }
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Reads `-x value` options, as `security` takes them. */
function options(list: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < list.length; i++) {
    const flag = list[i]!;
    if (!flag.startsWith("-")) continue;
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      result[flag] = next;
      i++;
    } else result[flag] = true;
  }
  return result;
}

/** Splits a `security -i` command line, honouring double quotes. */
function words(line: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of line.matchAll(pattern)) out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]!);
  return out;
}

function security(argv: string[]): void {
  if (unavailable()) fail("security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.", 51);
  const [command, ...rest] = argv;
  if (command === "-i") {
    const input = readFileSync(0, "utf8");
    for (const line of input.split("\n")) if (line.trim()) security(words(line));
    return;
  }
  const opts = options(rest);
  const service = String(opts["-s"] ?? "");
  const account = String(opts["-a"] ?? "");
  const entries = load();
  const index = entries.findIndex((entry) => entry.service === service && entry.account === account);
  if (command === "add-generic-password") {
    const secret = opts["-w"];
    if (typeof secret !== "string") fail("security: a password is required", 2);
    if (index >= 0 && !opts["-U"]) fail("security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.", 45);
    if (index >= 0) entries.splice(index, 1);
    entries.push({ service, account, secret });
    save(entries);
  } else if (command === "find-generic-password") {
    if (index < 0) fail("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.", 44);
    process.stdout.write(`${entries[index]!.secret}\n`);
  } else if (command === "delete-generic-password") {
    if (index < 0) fail("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.", 44);
    entries.splice(index, 1);
    save(entries);
  } else {
    fail(`security: unknown command ${command ?? ""}`, 2);
  }
}

/** `secret-tool store --label=… key value …`, `lookup key value …`, `clear key value …`. */
function secretTool(argv: string[]): void {
  if (unavailable()) fail("secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY", 1);
  const [command, ...rest] = argv;
  const pairs = rest.filter((arg) => !arg.startsWith("--"));
  const attributes: Record<string, string> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) attributes[pairs[i]!] = pairs[i + 1]!;
  const service = attributes.service ?? "";
  const account = attributes.account ?? "";
  const entries = load();
  const index = entries.findIndex((entry) => entry.service === service && entry.account === account);
  if (command === "store") {
    const secret = readFileSync(0, "utf8");
    if (index >= 0) entries.splice(index, 1);
    entries.push({ service, account, secret });
    save(entries);
  } else if (command === "lookup") {
    if (index < 0) process.exit(1);
    process.stdout.write(entries[index]!.secret);
  } else if (command === "clear") {
    if (index >= 0) {
      entries.splice(index, 1);
      save(entries);
    }
  } else {
    fail(`secret-tool: unknown command ${command ?? ""}`, 2);
  }
}

if (tool === "security") security(args);
else if (tool === "secret-tool") secretTool(args);
else fail(`keychain-stub: unknown tool ${tool}`, 2);
