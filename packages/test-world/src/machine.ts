import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeychainEntry } from "./keychain-stub.ts";
import { paths } from "./paths.ts";

export type { KeychainEntry };

/** The package managers a machine can have installed globally. */
export type InstalledPackageManager = "npm" | "pnpm" | "yarn";

/**
 * The versions a machine has unless a test says otherwise: those the test world's own fixtures pin
 * (`pnpm@10.34.9`), and a Yarn classic global, as most machines with Yarn Berry projects have.
 */
export const DEFAULT_PACKAGE_MANAGERS: Readonly<Record<InstalledPackageManager, string>> = { npm: "11.6.0", pnpm: "10.34.9", yarn: "1.22.22" };

export interface MachineOptions {
  /** `unavailable`: every keychain call fails, as on a headless Linux box or a locked keychain. */
  keychain?: "available" | "unavailable";
  /**
   * The package managers installed on the machine and their versions (DEFAULT_PACKAGE_MANAGERS
   * for the ones left out); null: not installed. See `Machine.bin`.
   */
  packageManagers?: Partial<Record<InstalledPackageManager, string | null>>;
}

/**
 * One developer machine for CLI processes: a HOME that lasts across `runCli` calls (so `login`
 * then `whoami` see the same credentials) and a keychain stub first on PATH. The real OS keychain
 * is never reached: `security` and `secret-tool` always resolve to the stub.
 */
export interface Machine {
  home: string;
  /**
   * Put first on PATH by `runCli`. Besides the keychain stub it holds `npm`, `pnpm` and `yarn`,
   * each linked into a global install laid out as `npm install --global` leaves one
   * (`lib/node_modules/<package>/package.json` with its version, the bin under it). They stand in
   * for the real tools and never run one: started, they record their argv
   * (`packageManagerCalls()`) and exit 1. So no test reaches a registry, and the real tools on the
   * developer's PATH are never found while a test's PATH keeps the machine's bin first.
   */
  bin: string;
  /** What the keychain stub holds now. */
  keychain(): Promise<KeychainEntry[]>;
  setKeychain(state: "available" | "unavailable"): Promise<void>;
  /** The `0600` fallback file, if `login` wrote one: its mode and text. */
  credentialsFile(): Promise<{ mode: number; text: string } | undefined>;
  /** Installs `version` of a package manager in place of the one there, or removes it (null). */
  setPackageManager(name: InstalledPackageManager, version: string | null): Promise<void>;
  /** Every time anything started this machine's `npm`, `pnpm` or `yarn`: the tool, then its arguments. */
  packageManagerCalls(): Promise<string[][]>;
}

/** Where the library keeps its fallback credentials file under HOME (no XDG_CONFIG_HOME set). */
export const CREDENTIALS_FILE = join(".config", "testnotary", "credentials.json");

/** The npm package a global install of `name` at `version` comes from. */
function packageOf(name: InstalledPackageManager, version: string): string {
  return name === "yarn" && !version.startsWith("1.") ? "@yarnpkg/cli-dist" : name;
}

export async function createMachine(tmp: string, options: MachineOptions = {}): Promise<Machine> {
  const dir = await mkdtemp(join(tmp, "machine-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const global = join(dir, "global", "lib", "node_modules");
  const calls = join(dir, "package-manager-calls.jsonl");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(global, { recursive: true }), writeFile(calls, "")]);
  for (const tool of ["security", "secret-tool"]) {
    const script = join(bin, tool);
    await writeFile(
      script,
      `#!/bin/sh\nexec ${quote(process.execPath)} --disable-warning=ExperimentalWarning ${quote(paths.keychainStub)} ${tool} ${quote(dir)} "$@"\n`,
    );
    await chmod(script, 0o755);
  }
  const machine: Machine = {
    home,
    bin,
    async keychain() {
      try {
        return JSON.parse(await readFile(join(dir, "keychain.json"), "utf8")) as KeychainEntry[];
      } catch {
        return [];
      }
    },
    async setKeychain(state) {
      await writeFile(join(dir, "keychain-mode"), state);
    },
    async credentialsFile() {
      const file = join(home, CREDENTIALS_FILE);
      try {
        const [info, text] = await Promise.all([stat(file), readFile(file, "utf8")]);
        return { mode: info.mode & 0o777, text };
      } catch {
        return undefined;
      }
    },
    async setPackageManager(name, version) {
      await rm(join(bin, name), { force: true });
      for (const old of name === "yarn" ? ["yarn", "@yarnpkg"] : [name]) await rm(join(global, old), { recursive: true, force: true });
      if (version === null) return;
      const pkg = join(global, packageOf(name, version));
      await mkdir(join(pkg, "bin"), { recursive: true });
      await writeFile(join(pkg, "package.json"), `${JSON.stringify({ name: packageOf(name, version), version, bin: { [name]: `bin/${name}.js` } }, null, 2)}\n`);
      const script = join(pkg, "bin", `${name}.js`);
      const record = `require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n"); console.error("${name}: the test world's stand-in runs no package-manager command"); process.exit(1);`;
      await writeFile(script, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(record)} ${quote(calls)} ${name} "$@"\n`);
      await chmod(script, 0o755);
      await symlink(script, join(bin, name));
    },
    async packageManagerCalls() {
      const text = await readFile(calls, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
  await machine.setKeychain(options.keychain ?? "available");
  for (const name of Object.keys(DEFAULT_PACKAGE_MANAGERS) as InstalledPackageManager[]) {
    const version = options.packageManagers?.[name];
    await machine.setPackageManager(name, version === undefined ? DEFAULT_PACKAGE_MANAGERS[name] : version);
  }
  return machine;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
