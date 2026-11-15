import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** The root of this checkout (or worktree). */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

export const paths = {
  composeFile: `${repoRoot}/packages/test-world/compose.yaml`,
  rolesSql: `${repoRoot}/docker/postgres/init/01-roles.sql`,
  webApp: `${repoRoot}/apps/web`,
  migrations: `${repoRoot}/apps/web/drizzle`,
  cli: `${repoRoot}/packages/testnotary/src/cli.ts`,
  keychainStub: `${repoRoot}/packages/test-world/src/keychain-stub.ts`,
  rootFilesPreload: `${repoRoot}/packages/test-world/src/root-files-preload.ts`,
  packageManagerStub:`${repoRoot}/packages/test-world/src/package-manager-stub.ts`,
  actionEntry: `${repoRoot}/packages/action/src/main.ts`,
};

/** A short id for this checkout, so two worktrees never pick the same compose project. */
export const checkoutId = createHash("sha256").update(repoRoot).digest("hex").slice(0, 10);
