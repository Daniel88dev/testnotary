import { AUDIT_RATE_DEFAULTS, auditDrawn, auditOneIn, auditPoint, repoAuditKey, type TokenKind } from "@testnotary/core";
import type { WorldDatabase } from "./database.ts";
import type { FakeRepo } from "./github/state.ts";

/**
 * Every world's audit master key. Fixed, so audit draws are deterministic: a tree and suite in a
 * repo at a key version is always drawn, or never.
 */
export const WORLD_AUDIT_MASTER_KEY = "testnotary-world-audit-master-key";

/** A tree and suite, as the draw sees them. */
export interface AuditTree {
  tree: string;
  suite: string;
}

/**
 * The audit draw as the service makes it, under the world's master key, and the one lever a test
 * has over it: the repo's audit key version, which only ever goes up, as a rotation would raise it.
 * Nothing in the service is bypassed: a test that needs a tree audited, or not audited, picks the
 * key version under which the real draw comes out that way.
 */
export interface WorldAudits {
  masterKey: string;
  /** The repo's key version now (1 until it is first rotated). */
  keyVersion(repo: FakeRepo): Promise<number>;
  /** Whether the service would draw this tree and suite for an audit now (or at `keyVersion`). */
  drawn(repo: FakeRepo, subject: AuditTree & { tokenKind?: TokenKind; keyVersion?: number }): Promise<boolean>;
  /**
   * Raises the repo's key version, if needed, to the lowest one under which none of the trees is
   * drawn, whatever the token (default: every tree attested in the repo so far). For tests about
   * something other than audits that expect a skip in enforce mode.
   */
  forbid(repo: FakeRepo, trees?: AuditTree[]): Promise<void>;
  /** Raises the repo's key version, if needed, to the lowest one under which every tree is drawn, whatever the token. */
  force(repo: FakeRepo, trees?: AuditTree[]): Promise<void>;
  /** Records `version` as the repo's key version (it must not be lower than the current one). */
  setKeyVersion(repo: FakeRepo, version: number): Promise<void>;
}

export function worldAudits(db: WorldDatabase): WorldAudits {
  const sql = () => db.connect("app");

  async function keyVersion(repo: FakeRepo): Promise<number> {
    const connection = sql();
    try {
      const [row] = await connection<{ version: number }[]>`
        select version from audit_key_versions where repo_id = ${repo.id} order by id desc limit 1`;
      return row?.version ?? 1;
    } finally {
      await connection.end({ timeout: 1 });
    }
  }

  async function rates(repo: FakeRepo): Promise<{ auditOneIn: number; sandboxAuditOneIn: number }> {
    const connection = sql();
    try {
      const [row] = await connection<{ auditOneIn: number; sandboxAuditOneIn: number }[]>`
        select audit_one_in as "auditOneIn", sandbox_audit_one_in as "sandboxAuditOneIn"
        from repo_setting_changes where repo_id = ${repo.id} order by id desc limit 1`;
      return row ?? { ...AUDIT_RATE_DEFAULTS };
    } finally {
      await connection.end({ timeout: 1 });
    }
  }

  async function attestedTrees(repo: FakeRepo): Promise<AuditTree[]> {
    const connection = sql();
    try {
      return await connection<AuditTree[]>`select distinct tree, suite from attestations where repo_id = ${repo.id}`;
    } finally {
      await connection.end({ timeout: 1 });
    }
  }

  async function setKeyVersion(repo: FakeRepo, version: number): Promise<void> {
    const current = await keyVersion(repo);
    if (version < current) throw new Error(`audit key versions only go up: ${repo.fullName} is at ${current}`);
    if (version === current) return;
    const connection = sql();
    try {
      await connection`insert into audit_key_versions (repo_id, version, reason) values (${repo.id}, ${version}, 'test')`;
    } finally {
      await connection.end({ timeout: 1 });
    }
  }

  /** The lowest version from the current one up under which every tree's draw point passes `wanted`. */
  async function pick(repo: FakeRepo, trees: AuditTree[], wanted: (point: number, oneIn: { least: number; most: number }) => boolean) {
    const settings = await rates(repo);
    // Drawn whatever the token: under the least frequent rate. Not drawn whatever the token: under the most frequent.
    const oneIn = { least: auditOneIn(settings, "laptop"), most: auditOneIn(settings, "sandbox") };
    const from = await keyVersion(repo);
    for (let version = from; version < from + 10_000; version++) {
      const key = await repoAuditKey({ masterKey: WORLD_AUDIT_MASTER_KEY, repoId: repo.id, keyVersion: version });
      const points = await Promise.all(trees.map((tree) => auditPoint(key, tree)));
      if (points.every((point) => wanted(point, oneIn))) return setKeyVersion(repo, version);
    }
    throw new Error(`no audit key version for ${repo.fullName} draws these trees as asked`);
  }

  return {
    masterKey: WORLD_AUDIT_MASTER_KEY,
    keyVersion,
    async drawn(repo, subject) {
      const version = subject.keyVersion ?? (await keyVersion(repo));
      const key = await repoAuditKey({ masterKey: WORLD_AUDIT_MASTER_KEY, repoId: repo.id, keyVersion: version });
      return auditDrawn(key, subject, auditOneIn(await rates(repo), subject.tokenKind ?? "laptop"));
    },
    async forbid(repo, trees) {
      await pick(repo, trees ?? (await attestedTrees(repo)), (point, oneIn) => point * oneIn.most >= 1);
    },
    async force(repo, trees) {
      await pick(repo, trees ?? (await attestedTrees(repo)), (point, oneIn) => point * oneIn.least < 1);
    },
    setKeyVersion,
  };
}
