"use server";

import { revalidatePath } from "next/cache";
import { database } from "../../../../../src/db/client.ts";
import { ownLaptopToken, renameToken, revokeToken, tokenName } from "../../../../../src/server/tokens.ts";
import { getViewer } from "../../../_lib/viewer.ts";

// The Tokens page's two changes, each a new row (the app role only inserts). Only the token's owner
// may make them; anything else is ignored, as is a form for a token that is not theirs.

const PAGE = "/settings/tokens";

export async function renameLaptopToken(form: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) return;
  const db = database();
  const name = tokenName(form.get("name"));
  const token = await ownLaptopToken(db, viewer.account.id, String(form.get("token") ?? ""));
  if (!name || !token) return;
  await renameToken(db, token.id, name);
  revalidatePath(PAGE);
}

export async function revokeLaptopToken(form: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) return;
  const db = database();
  const token = await ownLaptopToken(db, viewer.account.id, String(form.get("token") ?? ""));
  if (!token) return;
  await revokeToken(db, token.id, "revoked", viewer.account.id);
  revalidatePath(PAGE);
}
