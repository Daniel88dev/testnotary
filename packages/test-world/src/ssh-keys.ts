import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A key pair made with the real `ssh-keygen`, no passphrase, in the world's temp directory. */
export interface SshKeyPair {
  /** The private key file (OpenSSH format, mode 0600). */
  privateKeyPath: string;
  /** Its text, as `ssh-keygen` wrote it. */
  privateKey: string;
  /** `type base64 comment`, as the `.pub` file holds it and GitHub lists it. */
  publicKey: string;
}

export type SshKeyType = "ed25519" | "ecdsa" | "rsa";

/**
 * Makes a fresh key pair under `dir`. Never touches `~/.ssh` or an ssh-agent: the key lives only in
 * the world's temp directory and is deleted with it.
 */
export async function makeSshKey(dir: string, options: { type?: SshKeyType; comment?: string } = {}): Promise<SshKeyPair> {
  const home = await mkdtemp(join(dir, "ssh-key-"));
  const privateKeyPath = join(home, "key");
  const type = options.type ?? "ed25519";
  const args = ["-q", "-t", type, ...(type === "rsa" ? ["-b", "3072"] : []), "-N", "", "-C", options.comment ?? "world key", "-f", privateKeyPath];
  await run("ssh-keygen", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } });
  return {
    privateKeyPath,
    privateKey: await readFile(privateKeyPath, "utf8"),
    publicKey: (await readFile(`${privateKeyPath}.pub`, "utf8")).trim(),
  };
}

/**
 * Signs `message` with the key under `namespace`, as `ssh-keygen -Y sign` does: the armored
 * signature. For tests that make their own attestations (a compromised service's, say).
 */
export async function sshSign(key: SshKeyPair, message: string, namespace: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "ssh-keygen",
      ["-Y", "sign", "-n", namespace, "-f", key.privateKeyPath],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(key.privateKeyPath, "..") } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(message);
  });
}
