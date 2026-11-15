"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { database } from "../../../../../src/db/client.ts";
import { deleteAccount } from "../../../../../src/server/accounts.ts";
import { COOKIE_PREFIX } from "../../../../../src/server/auth.ts";
import { getViewer } from "../../../_lib/viewer.ts";

/**
 * *Delete account*, after its one confirmation: the deletion row (tokens revoked, sessions ended,
 * records shown as *deleted account*), then the sign-in cookies are cleared.
 */
export async function deleteMyAccount(): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) redirect("/settings/account");
  await deleteAccount(database(), viewer.account.id, viewer.sessionId);
  const jar = await cookies();
  for (const cookie of jar.getAll()) {
    if (cookie.name.startsWith(`${COOKIE_PREFIX}.`) || cookie.name.startsWith(`__Secure-${COOKIE_PREFIX}.`)) jar.delete(cookie.name);
  }
  redirect("/settings/account?deleted=1");
}
