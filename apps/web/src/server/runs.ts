import { and, eq } from "drizzle-orm";
import {
  SERVICE_REFUSALS,
  decodeAttestationPayload,
  type CompletedRunUpload,
  type RunResponse,
  type RunUpload,
  type ServiceRefusal,
} from "@testnotary/protocol";
import type { Database } from "../db/client.ts";
import { attestations, runs, tokens } from "../db/schema.ts";
import { deletedAt } from "./accounts.ts";
import { now } from "./config.ts";
import { apiError } from "./http.ts";
import { installedRepoByName, latestRepoState, type RepoView } from "./installations.ts";
import { accountLogin, authenticate, type Authenticated } from "./tokens.ts";
import { hasWriteAccess } from "./write-access.ts";

// Runs and their attestations: the preflight's and the upload's shared gate, storing a run, and
// reading one back. A run's attestation payload is stored as the exact bytes uploaded.

/** How far a run's end may lie ahead of the service clock (the library's clock may run fast). */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** A clear no from the service: the library refuses the run with this code. */
export function serviceRefusal(code: ServiceRefusal): Response {
  return apiError(SERVICE_REFUSALS[code], code);
}

/**
 * What the preflight and the upload both check, in this order: the token (`token_rejected`), the
 * repo named by `owner/name` has the App installed (`repo_not_installed`), and the token's
 * account, live on GitHub, has `admin` or `write` (`no_write_access`). A sandbox token reaches
 * only its own repo. GitHub errors propagate (wrap the handler in `withGitHubErrors`).
 */
export async function gate(db: Database, request: Request, repository: string): Promise<{ auth: Authenticated; repo: RepoView } | { response: Response }> {
  const auth = await authenticate(request);
  if (!auth) return { response: serviceRefusal("token_rejected") };
  const repo = await installedRepoByName(db, repository);
  if (!repo) return { response: serviceRefusal("repo_not_installed") };
  if (auth.token.kind === "sandbox" && auth.token.repoId !== repo.id) return { response: serviceRefusal("no_write_access") };
  if (!(await hasWriteAccess(db, repo, auth.account.id))) return { response: serviceRefusal("no_write_access") };
  return { auth, repo };
}

/**
 * Why a completed run's record can't be stored, or undefined when it can. A pass must carry a
 * canonical payload that says exactly what the record says, about this repo and this token; a
 * failure carries none.
 */
export function uploadProblem(upload: CompletedRunUpload, auth: Authenticated, repo: RepoView): { error: string; message: string } | undefined {
  const started = Date.parse(upload.startedAt);
  const ended = Date.parse(upload.endedAt);
  if (started > ended) return { error: "bad_request", message: "startedAt is after endedAt." };
  if (ended > now().getTime() + CLOCK_SKEW_MS) return { error: "bad_request", message: "endedAt is in the future." };
  if (upload.outcome === "failed") {
    return upload.attestation ? { error: "bad_request", message: "A failed run has no attestation." } : undefined;
  }
  if (!upload.attestation) return { error: "bad_request", message: "A passed run carries its attestation payload." };
  const payload = decodeAttestationPayload(upload.attestation.payload);
  if (!payload) return { error: "attestation_invalid", message: "The attestation payload is not a canonical payload of a known format." };
  const expected: [string, unknown, unknown][] = [
    ["repository", payload.repository, repo.id],
    ["suite", payload.suite, upload.suite],
    ["command", JSON.stringify(payload.command), JSON.stringify(upload.command)],
    ["tree", payload.tree, upload.tree],
    ["commit", payload.commit, upload.commit],
    ["attester.account", payload.attester.account, auth.account.id],
    ["attester.token", payload.attester.token, auth.token.id],
    ["attester.tokenKind", payload.attester.tokenKind, auth.token.kind],
    ["endedAt", payload.endedAt, upload.endedAt],
  ];
  const differs = expected.find(([, got, want]) => got !== want);
  if (differs) return { error: "attestation_invalid", message: `The attestation payload's ${differs[0]} does not match the run.` };
  return undefined;
}

/** Stores a run, and for a pass its attestation with the payload's bytes, in one transaction. */
export async function recordRun(db: Database, upload: RunUpload, auth: Authenticated, repo: RepoView): Promise<{ runId: string; attestationId: string | null }> {
  return db.transaction(async (tx) => {
    const base = { repoId: repo.id, tokenId: auth.token.id, accountId: auth.account.id, receivedAt: now() };
    if (upload.outcome === "refused") {
      const [row] = await tx
        .insert(runs)
        .values({
          ...base,
          outcome: "refused",
          refusal: upload.refusal,
          tree: upload.tree,
          commit: upload.commit,
          passedEnv: [],
          guardedMatched: [],
          warnings: [],
          notPinned: [],
          baselineOverrides: [],
        })
        .returning({ id: runs.id });
      return { runId: row!.id, attestationId: null };
    }
    const [row] = await tx
      .insert(runs)
      .values({
        ...base,
        outcome: upload.outcome,
        suite: upload.suite,
        tree: upload.tree,
        commit: upload.commit,
        command: upload.command,
        exitCode: upload.exitCode,
        startedAt: new Date(upload.startedAt),
        endedAt: new Date(upload.endedAt),
        durationMs: upload.durationMs,
        environment: upload.environment,
        session: upload.session,
        passedEnv: upload.passedEnv,
        guardedMatched: upload.guardedMatched,
        warnings: upload.warnings,
        notPinned: upload.notPinned,
        baselineOverrides: upload.baselineOverrides,
      })
      .returning({ id: runs.id });
    if (upload.outcome !== "passed" || !upload.attestation) return { runId: row!.id, attestationId: null };
    const payload = decodeAttestationPayload(upload.attestation.payload)!;
    const [attestation] = await tx
      .insert(attestations)
      .values({
        runId: row!.id,
        repoId: repo.id,
        suite: upload.suite,
        tree: upload.tree,
        commit: upload.commit,
        tokenId: auth.token.id,
        accountId: auth.account.id,
        endedAt: new Date(upload.endedAt),
        format: payload.format,
        payload: Buffer.from(upload.attestation.payload, "utf8"),
        createdAt: base.receivedAt,
      })
      .returning({ id: attestations.id });
    return { runId: row!.id, attestationId: attestation!.id };
  });
}

/** One of the account's own runs, with its attestation's payload exactly as stored. */
export async function readRun(db: Database, runId: string, accountId: number): Promise<RunResponse | undefined> {
  const [row] = await db
    .select({ run: runs, tokenKind: tokens.kind })
    .from(runs)
    .innerJoin(tokens, eq(tokens.id, runs.tokenId))
    .where(and(eq(runs.id, runId), eq(runs.accountId, accountId)));
  if (!row) return undefined;
  const run = row.run;
  // Runs from before the account was deleted are no longer its own, even if it signs in again.
  const deleted = await deletedAt(db, accountId);
  if (deleted && run.receivedAt.getTime() <= deleted.getTime()) return undefined;
  const [attestation] = await db.select().from(attestations).where(eq(attestations.runId, run.id));
  const iso = (date: Date | null) => date?.toISOString() ?? null;
  return {
    run: {
      id: run.id,
      repository: { id: run.repoId, fullName: (await latestRepoState(db, run.repoId))?.fullName ?? "" },
      outcome: run.outcome as RunResponse["run"]["outcome"],
      refusal: run.refusal,
      suite: run.suite,
      tree: run.tree,
      commit: run.commit,
      command: run.command,
      exitCode: run.exitCode,
      startedAt: iso(run.startedAt),
      endedAt: iso(run.endedAt),
      durationMs: run.durationMs,
      receivedAt: run.receivedAt.toISOString(),
      account: { id: run.accountId, login: (await accountLogin(db, run.accountId)) ?? "" },
      token: { id: run.tokenId, kind: row.tokenKind === "sandbox" ? "sandbox" : "laptop" },
      environment: run.environment,
      session: run.session,
      passedEnv: run.passedEnv,
      guardedMatched: run.guardedMatched,
      warnings: run.warnings,
      notPinned: run.notPinned,
      baselineOverrides: run.baselineOverrides,
    },
    attestation: attestation ? { id: attestation.id, format: attestation.format, payload: attestation.payload.toString("utf8") } : null,
  };
}
