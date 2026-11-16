import { database } from "../../../src/db/client.ts";
import { isAdmin, repoAccess, type RepoAccess } from "../../../src/server/access.ts";
import type { Viewer } from "../../../src/server/sessions.ts";
import { rememberAccount } from "../../../src/server/tokens.ts";
import { getViewer } from "./viewer.ts";

/**
 * The signed-in person, when GitHub says now (live, with their own token) that they are an admin
 * of the form's `repository`. Every admin action asks this on every submit: hiding a control is
 * not the check.
 */
export async function adminOf(form: FormData): Promise<{ viewer: Viewer; access: RepoAccess } | undefined> {
  const viewer = await getViewer();
  if (!viewer) return undefined;
  const [owner, name, ...rest] = String(form.get("repository") ?? "").split("/");
  if (!owner || !name || rest.length > 0) return undefined;
  const access = await repoAccess(viewer, owner, name);
  if (!access || !isAdmin(access)) return undefined;
  await rememberAccount(database(), viewer.account);
  return { viewer, access };
}
