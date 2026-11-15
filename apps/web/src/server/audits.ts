import { desc, eq } from "drizzle-orm";
import { repoAuditKey } from "@testnotary/core";
import { auditKeyVersions } from "../db/schema.ts";
import { now, serviceConfig } from "./config.ts";
import type { Executor } from "./installations.ts";

// The audit key: each repo's is derived from the master key (a secret the service reads from
// Secrets Manager) with the repo id and the repo's key version. The database holds only the
// version; rotating a key raises it, for one repo or for every repo (scripts/ops.ts).

/** The service has no audit master key, so it can draw no audit, and so it never skips. */
export class AuditNotConfigured extends Error {
  constructor() {
    super("AUDIT_MASTER_KEY is not set: the service draws no audit, so it answers no skip");
  }
}

/** The repo's audit key version now: 1 until it is first rotated. */
export async function auditKeyVersion(db: Executor, repoId: number): Promise<number> {
  const [row] = await db
    .select({ version: auditKeyVersions.version })
    .from(auditKeyVersions)
    .where(eq(auditKeyVersions.repoId, repoId))
    .orderBy(desc(auditKeyVersions.id))
    .limit(1);
  return row?.version ?? 1;
}

/** The repo's audit key: HKDF(master key, repo id, key version). */
export async function auditKeyOf(db: Executor, repoId: number): Promise<Uint8Array> {
  const masterKey = serviceConfig().auditMasterKey;
  if (!masterKey) throw new AuditNotConfigured();
  return repoAuditKey({ masterKey, repoId, keyVersion: await auditKeyVersion(db, repoId) });
}

/** Raises each repo's audit key version by one, so its draws change. Returns the new versions by repo id. */
export async function rotateAuditKeys(db: Executor, repoIds: number[], reason: string): Promise<Map<number, number>> {
  const rotated = new Map<number, number>();
  for (const repoId of repoIds) {
    const version = (await auditKeyVersion(db, repoId)) + 1;
    await db.insert(auditKeyVersions).values({ repoId, version, reason, at: now() });
    rotated.set(repoId, version);
  }
  return rotated;
}
