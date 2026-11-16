"use server";

import { revalidatePath } from "next/cache";
import { database } from "../../../src/db/client.ts";
import { blockLaptopToken, revokeRepoSandboxToken } from "../../../src/server/revocations.ts";
import { adminOf } from "./admin.ts";

// A repo admin's two ways to cut off a token: revoke any of the repo's sandbox tokens (from
// Settings), or block a laptop token from attesting on the repo (from People). Each is one new row.
// Admin is asked of GitHub live, with the person's own token, on every submit; hiding the controls
// is not the check. A form for a token that does not belong there is ignored.

const NOTE_MAX = 200;

export async function revokeRepoSandboxTokenAction(form: FormData): Promise<void> {
  const admin = await adminOf(form);
  if (!admin) return;
  await revokeRepoSandboxToken(database(), { tokenId: String(form.get("token") ?? ""), repoId: admin.access.repo.id, by: admin.viewer.account });
  revalidatePath("/", "layout");
}

export async function blockLaptopTokenAction(form: FormData): Promise<void> {
  const admin = await adminOf(form);
  if (!admin) return;
  const note = String(form.get("note") ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, NOTE_MAX);
  await blockLaptopToken(database(), { tokenId: String(form.get("token") ?? ""), repoId: admin.access.repo.id, by: admin.viewer.account, note });
  revalidatePath("/", "layout");
}
