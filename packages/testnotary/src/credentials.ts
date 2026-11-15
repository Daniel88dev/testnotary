import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Where the laptop token lives on this machine: the OS keychain (macOS `security`, Linux
// libsecret's `secret-tool`), or a `0600` file under ~/.config/testnotary when there is no usable
// keychain. Entries are per service URL, so a development service never sees the real token.
// The token is passed to the keychain tools on stdin, never in argv where `ps` would show it.

const SERVICE = "testnotary";
const LABEL = "Testnotary laptop token";
const TOOL_TIMEOUT_MS = 5_000;

export type Storage = "keychain" | "file";

type Env = Readonly<Record<string, string | undefined>>;

interface ToolResult {
  ok: boolean;
  stdout: string;
}

function runTool(command: string, args: string[], input: string, env: Env): Promise<ToolResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], env: env as NodeJS.ProcessEnv });
    } catch {
      resolve({ ok: false, stdout: "" });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TOOL_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

interface Keychain {
  read(account: string): Promise<string | undefined>;
  write(account: string, token: string): Promise<boolean>;
  remove(account: string): Promise<void>;
}

function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function macKeychain(env: Env): Keychain {
  return {
    async read(account) {
      const result = await runTool("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], "", env);
      const token = result.stdout.trim();
      return result.ok && token ? token : undefined;
    },
    async write(account, token) {
      // `security -i` reads the command from stdin, keeping the token out of the process list.
      const line = `add-generic-password -U -s ${quoted(SERVICE)} -a ${quoted(account)} -l ${quoted(LABEL)} -w ${quoted(token)}\n`;
      const result = await runTool("security", ["-i"], line, env);
      return result.ok;
    },
    async remove(account) {
      await runTool("security", ["delete-generic-password", "-s", SERVICE, "-a", account], "", env);
    },
  };
}

function secretToolKeychain(env: Env): Keychain {
  return {
    async read(account) {
      const result = await runTool("secret-tool", ["lookup", "service", SERVICE, "account", account], "", env);
      const token = result.stdout.trim();
      return result.ok && token ? token : undefined;
    },
    async write(account, token) {
      const result = await runTool("secret-tool", ["store", `--label=${LABEL}`, "service", SERVICE, "account", account], token, env);
      return result.ok;
    },
    async remove(account) {
      await runTool("secret-tool", ["clear", "service", SERVICE, "account", account], "", env);
    },
  };
}

function keychain(env: Env): Keychain | undefined {
  if (process.platform === "darwin") return macKeychain(env);
  if (process.platform === "linux") return secretToolKeychain(env);
  return undefined;
}

/** The fallback file: `$XDG_CONFIG_HOME/testnotary/credentials.json`, or under `~/.config`. */
export function credentialsFile(env: Env): string {
  const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(config, "testnotary", "credentials.json");
}

interface CredentialsFile {
  tokens: Record<string, string>;
}

async function readFileStore(env: Env): Promise<CredentialsFile> {
  try {
    const parsed = JSON.parse(await readFile(credentialsFile(env), "utf8")) as Partial<CredentialsFile>;
    return { tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {} };
  } catch {
    return { tokens: {} };
  }
}

async function writeFileStore(env: Env, store: CredentialsFile): Promise<void> {
  const file = credentialsFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

/** The laptop token stored for this service, from the keychain or the fallback file. */
export async function readStoredToken(serviceUrl: string, env: Env): Promise<string | undefined> {
  const fromKeychain = await keychain(env)?.read(serviceUrl);
  if (fromKeychain) return fromKeychain;
  return (await readFileStore(env)).tokens[serviceUrl];
}

/** Keeps the laptop token: in the keychain when it takes it, otherwise in the `0600` file. */
export async function storeToken(serviceUrl: string, token: string, env: Env): Promise<Storage> {
  const chain = keychain(env);
  // A keychain that says yes is read back: `security -i` can exit 0 after a failed command.
  if (chain && (await chain.write(serviceUrl, token)) && (await chain.read(serviceUrl)) === token) {
    await dropFromFile(serviceUrl, env);
    return "keychain";
  }
  const store = await readFileStore(env);
  store.tokens[serviceUrl] = token;
  await writeFileStore(env, store);
  return "file";
}

/** Forgets the token for this service, wherever it was kept. */
export async function forgetToken(serviceUrl: string, env: Env): Promise<void> {
  await keychain(env)?.remove(serviceUrl);
  await dropFromFile(serviceUrl, env);
}

async function dropFromFile(serviceUrl: string, env: Env): Promise<void> {
  const store = await readFileStore(env);
  if (!(serviceUrl in store.tokens)) return;
  delete store.tokens[serviceUrl];
  await writeFileStore(env, store);
}
