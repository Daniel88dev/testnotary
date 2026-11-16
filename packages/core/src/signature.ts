// Signature mode's shared definitions (open decision 5): the namespace, the `allowed_signers`
// principal syntax, the sandbox signing key's format, and a verifier for OpenSSH signatures
// (`ssh-keygen -Y sign`, PROTOCOL.sshsig). The library signs with `ssh-keygen`; the action and the
// service check with `verifySshSignature`, which needs no `ssh-keygen`. WebCrypto only (no
// `node:` imports): it does no I/O.

/** The namespace every attestation signature is made under. `ssh-keygen -Y sign -n <this>`. */
export const SIGNATURE_NAMESPACE = "attestation@testnotary.dev";

/** The repo's own list of trusted signing keys, read from the base branch. A guarded file. */
export const ALLOWED_SIGNERS_FILE = ".testnotary/allowed_signers";

/** The variable a sandbox's signing key comes from: the value `testnotary sandbox-key` prints. */
export const SIGNING_KEY_VARIABLE = "TESTNOTARY_SIGNING_KEY";

/** Where the key that made a signature is trusted from. */
export type KeySource = "github" | "allowed_signers";

/** Who a signature is from: a person's GitHub account (laptop token) or a sandbox token. */
export type Signer = { account: number } | { sandboxToken: string };

// ---------------------------------------------------------------------------------------------
// Principals: the first field of an `allowed_signers` line.
//
// - A person, by GitHub account id: `github:<account id>`, e.g. `github:583231`.
// - A sandbox token, by token id and its creator's account id:
//   `sandbox:<token id>/github:<creator account id>`.
//
// Ids, never logins: a login can be renamed and taken by someone else, an id can't. A line may
// list several principals separated by commas. Patterns (`*`, `?`) and negation (`!`) are not
// supported: such a principal never matches, so a line can only name exact signers.
// ---------------------------------------------------------------------------------------------

/** `github:<id>`: a person's own key, for attestations made with their laptop token. */
export function accountPrincipal(accountId: number): string {
  return `github:${accountId}`;
}

/** `sandbox:<token id>/github:<creator id>`: a sandbox token's own key. */
export function sandboxPrincipal(tokenId: string, creatorAccountId: number): string {
  return `sandbox:${tokenId}/${accountPrincipal(creatorAccountId)}`;
}

/** The principal an attestation's signature must be listed under, from the payload's attester. */
export function attesterPrincipal(attester: { account: number; token: string; tokenKind: "laptop" | "sandbox" }): string {
  return attester.tokenKind === "sandbox" ? sandboxPrincipal(attester.token, attester.account) : accountPrincipal(attester.account);
}

/** The signer an attestation's signature names, from the payload's attester. */
export function attesterSigner(attester: { account: number; token: string; tokenKind: "laptop" | "sandbox" }): Signer {
  return attester.tokenKind === "sandbox" ? { sandboxToken: attester.token } : { account: attester.account };
}

/** One `allowed_signers` line, as `sandbox-key` writes it: principal, namespace option, key, comment. */
export function allowedSignersLine(options: { principal: string; publicKey: string; comment?: string }): string {
  const comment = options.comment ? ` ${options.comment.replace(/[\r\n]+/g, " ")}` : "";
  return `${options.principal} namespaces="${SIGNATURE_NAMESPACE}" ${options.publicKey.trim().split(/\s+/).slice(0, 2).join(" ")}${comment}`;
}

// ---------------------------------------------------------------------------------------------
// The sandbox signing key (`TESTNOTARY_SIGNING_KEY`): the OpenSSH private key file `ssh-keygen -t
// ed25519` writes, base64-encoded on one line so any secret store keeps it intact. The raw file
// text (`-----BEGIN OPENSSH PRIVATE KEY-----` …) is accepted too.
// ---------------------------------------------------------------------------------------------

const OPENSSH_PRIVATE_KEY = /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END OPENSSH PRIVATE KEY-----\s*$/;

/** The value to store as the sandbox secret, from the private key file's text. */
export function encodeSigningKey(privateKeyFile: string): string {
  return toBase64(new TextEncoder().encode(privateKeyFile));
}

/** The private key file's text from `TESTNOTARY_SIGNING_KEY`, or undefined when it holds no key. */
export function decodeSigningKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (OPENSSH_PRIVATE_KEY.test(trimmed)) return `${trimmed}\n`;
  const bytes = fromBase64(trimmed.replace(/\s+/g, ""));
  if (!bytes) return undefined;
  const text = new TextDecoder().decode(bytes).trim();
  return OPENSSH_PRIVATE_KEY.test(text) ? `${text}\n` : undefined;
}

// ---------------------------------------------------------------------------------------------
// Public keys
// ---------------------------------------------------------------------------------------------

/** An SSH public key: its type and its wire-format blob. */
export interface SshPublicKey {
  type: string;
  blob: Uint8Array;
}

/** `ssh-ed25519 AAAA…` (type and base64 blob, no comment). */
export function publicKeyText(key: SshPublicKey): string {
  return `${key.type} ${toBase64(key.blob)}`;
}

/** Parses `type base64 [comment]`, as GitHub lists keys and `.pub` files hold them. */
export function parsePublicKey(text: string): SshPublicKey | undefined {
  const [type, data] = text.trim().split(/\s+/);
  if (!type || !data) return undefined;
  const blob = fromBase64(data);
  if (!blob) return undefined;
  try {
    return new WireReader(blob).text() === type ? { type, blob } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether two keys are the same key (type and blob), whatever their comments. */
export function sameKey(a: SshPublicKey, b: SshPublicKey): boolean {
  return a.type === b.type && equalBytes(a.blob, b.blob);
}

/** `SHA256:<base64 without padding>`, as `ssh-keygen -l` prints it. */
export async function keyFingerprint(key: SshPublicKey): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", key.blob as Uint8Array<ArrayBuffer>));
  return `SHA256:${toBase64(digest).replace(/=+$/, "")}`;
}

// ---------------------------------------------------------------------------------------------
// Signatures (PROTOCOL.sshsig)
// ---------------------------------------------------------------------------------------------

/** What an armored `-----BEGIN SSH SIGNATURE-----` block holds. */
export interface SshSignature {
  publicKey: SshPublicKey;
  namespace: string;
  hashAlgorithm: string;
  signatureType: string;
  signatureBlob: Uint8Array;
  reserved: Uint8Array;
}

/** Parses an armored SSH signature; undefined when it is not one. */
export function parseSshSignature(armored: string): SshSignature | undefined {
  const match = /^\s*-----BEGIN SSH SIGNATURE-----\r?\n([A-Za-z0-9+/=\s]+?)\r?\n?-----END SSH SIGNATURE-----\s*$/.exec(armored);
  if (!match) return undefined;
  const bytes = fromBase64(match[1]!.replace(/\s+/g, ""));
  if (!bytes) return undefined;
  try {
    const reader = new WireReader(bytes);
    if (new TextDecoder().decode(reader.bytes(6)) !== "SSHSIG") return undefined;
    if (reader.uint32() !== 1) return undefined;
    const keyBlob = reader.string();
    const namespace = new TextDecoder().decode(reader.string());
    const reserved = reader.string();
    const hashAlgorithm = new TextDecoder().decode(reader.string());
    const signature = new WireReader(reader.string());
    if (!reader.done()) return undefined;
    const signatureType = signature.text();
    const signatureBlob = signature.string();
    // Nothing may follow the signature blob, as in `sshsig_peek_hashalg`/`sshkey_sig_from_blob`.
    if (!signature.done()) return undefined;
    const keyType = new WireReader(keyBlob).text();
    return { publicKey: { type: keyType, blob: keyBlob }, namespace, hashAlgorithm, signatureType, signatureBlob, reserved };
  } catch {
    return undefined;
  }
}

export type SignatureCheck =
  | { ok: true; signature: SshSignature; publicKey: string; fingerprint: string }
  | { ok: false; problem: string };

/**
 * Checks an armored SSH signature over `message` under `namespace`, with the key the signature
 * carries. Supported keys: Ed25519, ECDSA P-256/384/521 and RSA (`rsa-sha2-256`/`512`). Whether
 * that key is trusted is the caller's question (GitHub's list or `allowed_signers`).
 */
export async function verifySshSignature(armored: string, message: Uint8Array, namespace = SIGNATURE_NAMESPACE): Promise<SignatureCheck> {
  const signature = parseSshSignature(armored);
  if (!signature) return { ok: false, problem: "not an SSH signature" };
  if (signature.namespace !== namespace) return { ok: false, problem: `made under namespace ${JSON.stringify(signature.namespace)}, not ${namespace}` };
  const hash = { sha256: "SHA-256", sha512: "SHA-512" }[signature.hashAlgorithm];
  if (!hash) return { ok: false, problem: `hash algorithm ${JSON.stringify(signature.hashAlgorithm)} is not supported` };
  const digest = new Uint8Array(await crypto.subtle.digest(hash, message as Uint8Array<ArrayBuffer>));
  const signed = concat(
    new TextEncoder().encode("SSHSIG"),
    wireString(new TextEncoder().encode(signature.namespace)),
    wireString(signature.reserved),
    wireString(new TextEncoder().encode(signature.hashAlgorithm)),
    wireString(digest),
  );
  let valid: boolean;
  try {
    const verifier = await verifierFor(signature);
    if (typeof verifier === "string") return { ok: false, problem: verifier };
    valid = await verifier(signed);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, problem: "not valid over the attestation's bytes" };
  return { ok: true, signature, publicKey: publicKeyText(signature.publicKey), fingerprint: await keyFingerprint(signature.publicKey) };
}

/** The smallest RSA modulus `ssh-keygen -Y verify` accepts. */
const RSA_MINIMUM_BITS = 1024;

/** The bit length of an mpint modulus. */
function modulusBits(n: Uint8Array): number {
  const bytes = stripZeros(n);
  return bytes.length === 0 ? 0 : (bytes.length - 1) * 8 + (32 - Math.clz32(bytes[0]!));
}

const CURVES: Record<string, { name: string; size: number; hash: string }> = {
  nistp256: { name: "P-256", size: 32, hash: "SHA-256" },
  nistp384: { name: "P-384", size: 48, hash: "SHA-384" },
  nistp521: { name: "P-521", size: 66, hash: "SHA-512" },
};

/** A function that checks the signature over the signed data, or why the key can't be used. */
async function verifierFor(signature: SshSignature): Promise<((data: Uint8Array) => Promise<boolean>) | string> {
  const key = new WireReader(signature.publicKey.blob);
  const type = key.text();
  const subtle = crypto.subtle;
  // Like `sshkey_from_blob`, a key blob holds its fields and nothing after them.
  const trailing = "the key blob has trailing bytes";
  if (type === "ssh-ed25519") {
    if (signature.signatureType !== type) return "the signature type does not match the key";
    const raw = key.string();
    if (!key.done()) return trailing;
    const imported = await subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]);
    return (data) => subtle.verify({ name: "Ed25519" }, imported, signature.signatureBlob as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  }
  if (type.startsWith("ecdsa-sha2-")) {
    const curveId = key.text();
    const curve = CURVES[curveId];
    // The key type names its curve, and the curve field must be that curve (OpenSSH checks the
    // nid of both): `ecdsa-sha2-nistp256` carrying a P-521 point is no key at all.
    if (!curve || type !== `ecdsa-sha2-${curveId}`) return "the key type does not match its curve";
    if (signature.signatureType !== type) return "the signature type does not match the key";
    const point = key.string();
    if (!key.done()) return trailing;
    const imported = await subtle.importKey("raw", point as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
    const parts = new WireReader(signature.signatureBlob);
    const p1363 = concat(fixedWidth(parts.string(), curve.size), fixedWidth(parts.string(), curve.size));
    if (!parts.done()) return "the ECDSA signature has trailing bytes";
    return (data) => subtle.verify({ name: "ECDSA", hash: curve.hash }, imported, p1363 as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  }
  if (type === "ssh-rsa") {
    const hash = { "rsa-sha2-256": "SHA-256", "rsa-sha2-512": "SHA-512" }[signature.signatureType];
    if (!hash) return `signature type ${JSON.stringify(signature.signatureType)} is not supported`;
    const e = key.string();
    const n = key.string();
    if (!key.done()) return trailing;
    // OpenSSH refuses RSA keys under 1024 bits (SSH_RSA_MINIMUM_MODULUS_SIZE).
    const bits = modulusBits(n);
    if (bits < RSA_MINIMUM_BITS) return `the RSA key has ${bits} bits, under ${RSA_MINIMUM_BITS}`;
    const jwk = { kty: "RSA", e: toBase64Url(stripZeros(e)), n: toBase64Url(stripZeros(n)), ext: true };
    const imported = await subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    return (data) => subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, imported, signature.signatureBlob as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  }
  return `key type ${JSON.stringify(type)} is not supported`;
}

// ---------------------------------------------------------------------------------------------
// allowed_signers (`man ssh-keygen`, ALLOWED SIGNERS): `principals [options] keytype base64 [comment]`
// ---------------------------------------------------------------------------------------------

export interface AllowedSigner {
  /** The 1-based line number in the file. */
  line: number;
  principals: string[];
  /** `namespaces="…"`; undefined when the line doesn't restrict them. */
  namespaces: string[] | undefined;
  validAfter: Date | undefined;
  validBefore: Date | undefined;
  publicKey: SshPublicKey;
}

/**
 * The lines of an `allowed_signers` file that can name a signer. Comments, blank lines, and lines
 * Testnotary can't read in full (`cert-authority`, an unknown option, a broken key or date) are
 * left out: a line that can't be read never trusts anything.
 */
export function parseAllowedSigners(text: string): AllowedSigner[] {
  const signers: AllowedSigner[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const fields = splitOutsideQuotes(line, /\s/);
    if (fields.length < 3) return;
    let at = 1;
    let options: string[] = [];
    if (!isKeyType(fields[1]!)) {
      options = splitOutsideQuotes(fields[1]!, /,/);
      at = 2;
    }
    const publicKey = parsePublicKey(`${fields[at] ?? ""} ${fields[at + 1] ?? ""}`);
    if (!publicKey) return;
    const signer: AllowedSigner = {
      line: index + 1,
      principals: unquote(fields[0]!).split(","),
      namespaces: undefined,
      validAfter: undefined,
      validBefore: undefined,
      publicKey,
    };
    for (const option of options) {
      const eq = option.indexOf("=");
      const name = (eq < 0 ? option : option.slice(0, eq)).toLowerCase();
      const value = eq < 0 ? undefined : unquote(option.slice(eq + 1));
      if (name === "namespaces" && value !== undefined) signer.namespaces = value.split(",");
      else if ((name === "valid-after" || name === "valid-before") && value !== undefined) {
        const date = signerTime(value);
        if (!date) return;
        if (name === "valid-after") signer.validAfter = date;
        else signer.validBefore = date;
      } else return;
    }
    signers.push(signer);
  });
  return signers;
}

/**
 * The line that trusts `key` for `principal`, for a signature made at `signedAt` under the
 * namespace, or undefined. Principals match exactly.
 */
export function allowedSignerFor(signers: AllowedSigner[], principal: string, key: SshPublicKey, signedAt: Date): AllowedSigner | undefined {
  return signers.find(
    (signer) =>
      signer.principals.includes(principal) &&
      sameKey(signer.publicKey, key) &&
      (!signer.namespaces || signer.namespaces.includes(SIGNATURE_NAMESPACE)) &&
      (!signer.validAfter || signedAt.getTime() >= signer.validAfter.getTime()) &&
      (!signer.validBefore || signedAt.getTime() < signer.validBefore.getTime()),
  );
}

/** `YYYYMMDD[HHMM[SS]][Z]`, read as UTC. */
function signerTime(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?Z?$/i.exec(value);
  if (!match) return undefined;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isKeyType(field: string): boolean {
  return /^(?:ssh-|ecdsa-sha2-|sk-)/.test(field);
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function splitOutsideQuotes(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && separator.test(char)) {
      if (current) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------------------------

class WireReader {
  private offset = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  bytes(length: number): Uint8Array {
    if (this.offset + length > this.data.length) throw new Error("short read");
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  uint32(): number {
    const b = this.bytes(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }
  string(): Uint8Array {
    return this.bytes(this.uint32());
  }
  text(): string {
    return new TextDecoder().decode(this.string());
  }
  done(): boolean {
    return this.offset === this.data.length;
  }
}

function wireString(data: Uint8Array): Uint8Array {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  return concat(length, data);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function stripZeros(bytes: Uint8Array): Uint8Array {
  let at = 0;
  while (at < bytes.length - 1 && bytes[at] === 0) at++;
  return bytes.subarray(at);
}

/** An mpint as exactly `size` bytes (big-endian), as WebCrypto's ECDSA signatures are. */
function fixedWidth(mpint: Uint8Array, size: number): Uint8Array {
  const value = stripZeros(mpint);
  if (value.length > size) throw new Error("integer too large for the curve");
  const out = new Uint8Array(size);
  out.set(value, size - value.length);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length === 0) return undefined;
  try {
    const binary = atob(text);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}
