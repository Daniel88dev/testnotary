"use server";

import { revalidatePath } from "next/cache";
import { SANDBOX_TOKEN_DEFAULT_DAYS } from "@testnotary/core";
import { database } from "../../../src/db/client.ts";
import { hasWriteAccess, repoAccess } from "../../../src/server/access.ts";
import { isSuspended } from "../../../src/server/accounts.ts";
import { issueSandboxToken, ownSandboxToken, revokeToken, sandboxTokenDays, tokenName } from "../../../src/server/tokens.ts";
import { getViewer } from "./viewer.ts";

// Creating and revoking sandbox tokens, from a repo's Settings and the account Tokens page. Each is
// a new row (the app role only inserts). Write access is asked of GitHub live, with the person's
// own token, on every creation; hiding the form is not the check.

/** What the creation form shows after a submit. The value is in it once and never again. */
export type CreateSandboxTokenState =
  | { kind: "idle" }
  | { kind: "created"; value: string; name: string; repository: string; expiresAt: string }
  | { kind: "error"; message: string };

export async function createSandboxToken(_previous: CreateSandboxTokenState, form: FormData): Promise<CreateSandboxTokenState> {
  const viewer = await getViewer();
  if (!viewer) return { kind: "error", message: "Sign in again to create a sandbox token." };
  if (await isSuspended(database(), viewer.account.id)) return { kind: "error", message: "Your account is suspended, so it is issued no token." };
  const name = tokenName(form.get("name"));
  if (!name) return { kind: "error", message: "Give the token a name, up to 100 characters." };
  const rawDays = form.get("days");
  const days = rawDays === null || rawDays === "" ? SANDBOX_TOKEN_DEFAULT_DAYS : sandboxTokenDays(rawDays);
  if (!days) return { kind: "error", message: "A sandbox token lasts from 1 day to 1 year." };
  const [owner, repoName, ...rest] = String(form.get("repository") ?? "").split("/");
  const access = owner && repoName && rest.length === 0 ? await repoAccess(viewer, owner, repoName) : undefined;
  if (!access || !hasWriteAccess(access)) return { kind: "error", message: "You need write access to an installed repo to create a sandbox token for it." };
  const issued = await issueSandboxToken(database(), { creator: viewer.account, repoId: access.repo.id, name, days });
  revalidatePath("/", "layout");
  return { kind: "created", value: issued.value, name, repository: access.repo.fullName, expiresAt: issued.info.expiresAt };
}

/** The creator revokes their own sandbox token (an admin revoking any of a repo's comes later). */
export async function revokeSandboxToken(form: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!viewer) return;
  const db = database();
  const token = await ownSandboxToken(db, viewer.account.id, String(form.get("token") ?? ""));
  if (!token) return;
  await revokeToken(db, token.id, "revoked", viewer.account.id);
  revalidatePath("/", "layout");
}
