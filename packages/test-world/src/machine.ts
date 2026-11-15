import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeychainEntry } from "./keychain-stub.ts";
import { paths } from "./paths.ts";

export type { KeychainEntry };

export interface MachineOptions {
  /** `unavailable`: every keychain call fails, as on a headless Linux box or a locked keychain. */
  keychain?: "available" | "unavailable";
}

/**
 * One developer machine for CLI processes: a HOME that lasts across `runCli` calls (so `login`
 * then `whoami` see the same credentials) and a keychain stub first on PATH. The real OS keychain
 * is never reached: `security` and `secret-tool` always resolve to the stub.
 */
export interface Machine {
  home: string;
  /** Put first on PATH by `runCli`. */
  bin: string;
  /** What the keychain stub holds now. */
  keychain(): Promise<KeychainEntry[]>;
  setKeychain(state: "available" | "unavailable"): Promise<void>;
  /** The `0600` fallback file, if `login` wrote one: its mode and text. */
  credentialsFile(): Promise<{ mode: number; text: string } | undefined>;
}

/** Where the library keeps its fallback credentials file under HOME (no XDG_CONFIG_HOME set). */
export const CREDENTIALS_FILE = join(".config", "testnotary", "credentials.json");

export async function createMachine(tmp: string, options: MachineOptions = {}): Promise<Machine> {
  const dir = await mkdtemp(join(tmp, "machine-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  await Promise.all([mkdir(home), mkdir(bin)]);
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
  };
  await machine.setKeychain(options.keychain ?? "available");
  return machine;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
