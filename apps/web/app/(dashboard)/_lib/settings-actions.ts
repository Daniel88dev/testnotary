"use server";

import { revalidatePath } from "next/cache";
import { database } from "../../../src/db/client.ts";
import { changeRepoSettings, explainMismatch, type SettingsRequest } from "../../../src/server/settings.ts";
import { adminOf } from "./admin.ts";

// A repo admin's changes in Settings (the mode toggle, the audit rates) and on Mismatches (an
// explanation). Each is one new row; admin is asked of GitHub live on every submit, and a form
// from anyone else changes nothing.

export interface FormState {
  /** Why nothing changed, in words the page shows. */
  problem?: string;
  /** Bumped on every success, so a dialog knows to close. */
  done?: number;
}

const NOT_ADMIN = "Only an admin of the repository can change this. GitHub no longer says you are one.";

export async function changeModeAction(_state: FormState, form: FormData): Promise<FormState> {
  const mode = form.get("mode");
  if (mode !== "enforce" && mode !== "shadow") return { problem: "Choose enforce or shadow mode." };
  return change(form, { mode });
}

export async function changeRatesAction(_state: FormState, form: FormData): Promise<FormState> {
  const sandbox = String(form.get("sandboxAuditOneIn") ?? "");
  return change(form, { auditOneIn: Number(form.get("auditOneIn")), sandboxAuditOneIn: sandbox === "default" ? "default" : Number(sandbox) });
}

async function change(form: FormData, request: SettingsRequest): Promise<FormState> {
  const admin = await adminOf(form);
  if (!admin) return { problem: NOT_ADMIN };
  const result = await changeRepoSettings(database(), { repoId: admin.access.repo.id, by: admin.viewer.account, ...request });
  if (!result.ok) return { problem: result.problem };
  revalidatePath("/", "layout");
  return { done: Date.now() };
}

export async function explainMismatchAction(_state: FormState, form: FormData): Promise<FormState> {
  const admin = await adminOf(form);
  if (!admin) return { problem: NOT_ADMIN };
  const explained = await explainMismatch(database(), {
    repoId: admin.access.repo.id,
    mismatchId: String(form.get("mismatch") ?? ""),
    by: admin.viewer.account,
    cause: String(form.get("cause") ?? ""),
    note: String(form.get("note") ?? ""),
  });
  if (!explained) return { problem: "Choose a cause. A mismatch is explained once, and this one may be explained already." };
  revalidatePath("/", "layout");
  return { done: Date.now() };
}
