// `testnotary sandbox-key <token-name>`: on the sandbox token creator's laptop, makes an Ed25519
// key pair for the sandbox, prints the private half to store as the sandbox's
// `TESTNOTARY_SIGNING_KEY` secret beside its token, and writes the `.testnotary/allowed_signers`
// line for a pull request. The service only lists the person's sandbox tokens; it never sees
// either half of the key.
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError, parseCommandArgs, type Command } from "../command.ts";
import { readStoredToken } from "../credentials.ts";
import { tryGit } from "../git.ts";
import { Output } from "../output.ts";
import { EXIT } from "../report.ts";
import { githubRepository } from "../run/locate.ts";
import { ServiceUnreachable, callService } from "../service.ts";
import {
  ALLOWED_SIGNERS_FILE,
  SIGNING_KEY_VARIABLE,
  allowedSignersLine,
  encodeSigningKey,
  resolveServiceUrl,
  sandboxPrincipal,
  sandboxTokensResponse,
  type SandboxTokensResponse,
} from "../shared.ts";

type SandboxToken = SandboxTokensResponse["tokens"][number];

export const sandboxKey: Command = {
  name: "sandbox-key",
  usage: "sandbox-key <token-name> [--json]",
  summary: "Make a signing key for a sandbox token and the allowed_signers line for a signature-mode repo.",
  async run(args, context) {
    const { flags, positionals } = parseCommandArgs(args, []);
    if (positionals.length !== 1) throw new UsageError("name the sandbox token: testnotary sandbox-key <token-name>");
    const name = positionals[0]!;
    const out = new Output(flags.json);
    const env = context.env;
    const serviceUrl = resolveServiceUrl(env);
    const token = await readStoredToken(serviceUrl, env);
    if (!token) return out.fail("not_signed_in", ["not signed in: run `testnotary login` on the laptop of the person who created the sandbox token"]);

    let listed: SandboxTokensResponse;
    try {
      const answer = await callService(serviceUrl, "/tokens/sandbox", sandboxTokensResponse, { token });
      if (answer.status === 401) return out.fail("token_rejected", ["this machine's laptop token was rejected (revoked or expired): run `testnotary login`"]);
      if (!answer.body) return out.fail("service_error", [`the service answered ${answer.status}`]);
      listed = answer.body;
    } catch (error) {
      if (error instanceof ServiceUnreachable) return out.fail("service_unreachable", [`the Testnotary service could not be reached: ${error.message}`]);
      throw error;
    }

    const root = await tryGit(context.cwd, ["rev-parse", "--show-toplevel"], env);
    const origin = root ? await tryGit(root, ["config", "--get", "remote.origin.url"], env) : undefined;
    const here = origin ? githubRepository(origin) : undefined;
    const named = listed.tokens.filter((candidate) => candidate.name === name);
    const inThisRepo = named.filter((candidate) => here !== undefined && candidate.repository.fullName.toLowerCase() === here.toLowerCase());
    const chosen: SandboxToken | undefined = named.length === 1 ? named[0] : inThisRepo.length === 1 ? inThisRepo[0] : undefined;
    if (!chosen) {
      if (named.length === 0) {
        const yours = listed.tokens.map((candidate) => `"${candidate.name}" (${candidate.repository.fullName})`);
        return out.fail("token_not_found", [
          `you have no live sandbox token named "${name}"${yours.length ? `; yours: ${yours.join(", ")}` : ""}. Create one in the dashboard (Tokens, or the repo's Settings) first`,
        ]);
      }
      return out.fail("token_ambiguous", [
        `several of your sandbox tokens are named "${name}" (${named.map((candidate) => candidate.repository.fullName).join(", ")}): run this inside a clone of the token's repo`,
      ]);
    }

    let pair: { privateKey: string; publicKey: string };
    try {
      pair = await ed25519Pair(`testnotary sandbox token ${chosen.name}`);
    } catch (error) {
      return out.fail("ssh_keygen_failed", [`ssh-keygen could not make the key: ${error instanceof Error ? error.message : String(error)}`]);
    }
    const signingKey = encodeSigningKey(pair.privateKey);
    const line = allowedSignersLine({
      principal: sandboxPrincipal(chosen.id, listed.account.id),
      publicKey: pair.publicKey,
      comment: `sandbox token "${chosen.name}" for ${chosen.repository.fullName}, created by @${listed.account.login}`,
    });

    // The line goes into the clone of the token's repo the command runs in; anywhere else it is printed.
    let file: string | null = null;
    if (root && here && here.toLowerCase() === chosen.repository.fullName.toLowerCase()) {
      const path = join(root, ALLOWED_SIGNERS_FILE);
      await mkdir(dirname(path), { recursive: true });
      const before = await readFile(path, "utf8").catch(() => "");
      await appendFile(path, `${before && !before.endsWith("\n") ? "\n" : ""}${line}\n`);
      file = ALLOWED_SIGNERS_FILE;
      out.say(`added the line for sandbox token "${chosen.name}" to ${ALLOWED_SIGNERS_FILE}: merge it into the base branch in a pull request; its runs skip only once it is there`);
    } else {
      out.say(`add this line to ${ALLOWED_SIGNERS_FILE} in ${chosen.repository.fullName}, in a pull request to the base branch:`);
      out.say(line);
    }
    out.say(`store the value on stdout as the sandbox secret ${SIGNING_KEY_VARIABLE}, beside its TESTNOTARY_TOKEN. It is shown this once and kept nowhere else; Testnotary never sees it`);
    out.answer(signingKey, {
      token: { id: chosen.id, name: chosen.name, repository: chosen.repository.fullName },
      signingKey,
      allowedSignersLine: line,
      file,
    });
    return EXIT.passed;
  },
};

/** A fresh Ed25519 pair from `ssh-keygen`, made in a private temp directory that is removed at once. */
async function ed25519Pair(comment: string): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), "testnotary-key-"));
  try {
    const path = join(dir, "key");
    await new Promise<void>((resolve, reject) => {
      execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path], { timeout: 30_000 }, (error, _stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
      );
    });
    return { privateKey: await readFile(path, "utf8"), publicKey: (await readFile(`${path}.pub`, "utf8")).trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
