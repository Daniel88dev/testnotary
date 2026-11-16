import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { database } from "../db/client.ts";
import { webhookDeliveries } from "../db/schema.ts";
import { serviceConfig } from "./config.ts";
import {
  installationView,
  knownInstallation,
  latestRepoState,
  recordInstallationEvent,
  recordRepoState,
  rememberInstallation,
  type Executor,
  type InstallationView,
  type RepoInput,
  type RepoView,
} from "./installations.ts";

// The App's webhooks: `installation`, `installation_repositories`
// and `repository`. Handled inline, with no queue. Each delivery is applied once, by its
// `X-GitHub-Delivery` id, and the reply describes the installation afterwards, which GitHub shows
// under the App's "Recent deliveries".

export type WebhookReply =
  | {
      applied: true;
      installation: Omit<InstallationView, "repos">;
      /** The repos installed on it now. */
      repos: Pick<RepoView, "id" | "fullName" | "visibility" | "installed" | "mode">[];
    }
  | { applied: false; reason: "duplicate_delivery" | "ignored_event" | "unknown_installation" | "unknown_repo" };

/** The signature header GitHub sends, checked against the raw body before anything is parsed. */
export function signatureMatches(secret: string, body: string, header: string | null): boolean {
  const match = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(match[1]!, "hex"));
}

const repository = z.object({ id: z.number(), full_name: z.string(), private: z.boolean() });
const installation = z.object({
  id: z.number(),
  account: z.object({ id: z.number(), login: z.string(), type: z.string() }),
});

const installationEvent = z.object({
  action: z.string(),
  installation,
  repositories: z.array(repository).optional(),
});

const installationRepositoriesEvent = z.object({
  action: z.enum(["added", "removed"]),
  installation,
  repositories_added: z.array(repository),
  repositories_removed: z.array(repository),
});

const repositoryEvent = z.object({
  action: z.string(),
  repository: repository.extend({ visibility: z.string().optional() }),
  installation: z.object({ id: z.number() }),
});

function repoInput(repo: z.infer<typeof repository>): RepoInput {
  return { id: repo.id, fullName: repo.full_name, visibility: repo.private ? "private" : "public" };
}

export class WebhookPayloadError extends Error {}

/** Applies one verified delivery. */
export async function applyWebhook(event: string, deliveryId: string, payload: unknown): Promise<WebhookReply> {
  return database().transaction(async (tx) => {
    const action = typeof (payload as { action?: unknown })?.action === "string" ? (payload as { action: string }).action : null;
    const fresh = await tx.insert(webhookDeliveries).values({ deliveryId, event, action }).onConflictDoNothing().returning();
    if (fresh.length === 0) return { applied: false, reason: "duplicate_delivery" } as const;

    let installationId: number;
    if (event === "installation") {
      const body = parse(installationEvent, payload);
      installationId = body.installation.id;
      if (!["created", "deleted", "suspend", "unsuspend"].includes(body.action)) return { applied: false, reason: "ignored_event" } as const;
      await rememberInstallation(tx, body.installation);
      await recordInstallationEvent(tx, installationId, body.action, deliveryId);
      // Suspending keeps the repos as they are; the installation's state stops them meanwhile.
      if (body.action === "created" || body.action === "deleted") {
        const installed = body.action === "created";
        for (const repo of body.repositories ?? []) {
          await recordRepoState(tx, { repo: repoInput(repo), installationId, installed, change: installed ? "added" : "removed", deliveryId });
        }
      }
    } else if (event === "installation_repositories") {
      const body = parse(installationRepositoriesEvent, payload);
      installationId = body.installation.id;
      await rememberInstallation(tx, body.installation);
      for (const repo of body.repositories_added) {
        await recordRepoState(tx, { repo: repoInput(repo), installationId, installed: true, change: "added", deliveryId });
      }
      for (const repo of body.repositories_removed) {
        await recordRepoState(tx, { repo: repoInput(repo), installationId, installed: false, change: "removed", deliveryId });
      }
    } else if (event === "repository") {
      const body = parse(repositoryEvent, payload);
      installationId = body.installation.id;
      const reply = await applyRepositoryEvent(tx, body, deliveryId);
      if (reply) return reply;
    } else {
      return { applied: false, reason: "ignored_event" } as const;
    }
    return describe(tx, installationId);
  });
}

async function applyRepositoryEvent(tx: Executor, body: z.infer<typeof repositoryEvent>, deliveryId: string): Promise<WebhookReply | undefined> {
  const change = body.action;
  if (!["deleted", "transferred", "privatized", "publicized", "renamed"].includes(change)) return { applied: false, reason: "ignored_event" };
  if (!(await knownInstallation(tx, body.installation.id))) return { applied: false, reason: "unknown_installation" };
  const previous = await latestRepoState(tx, body.repository.id);
  if (!previous) return { applied: false, reason: "unknown_repo" };
  // Deleting or transferring a repo stops it at once; the other changes keep it as it was.
  const stops = change === "deleted" || change === "transferred";
  await recordRepoState(tx, {
    repo: repoInput(body.repository),
    installationId: previous.installationId,
    installed: stops ? false : previous.installed,
    change: change as "deleted" | "transferred" | "privatized" | "publicized" | "renamed",
    deliveryId,
  });
  return undefined;
}

async function describe(tx: Executor, installationId: number): Promise<WebhookReply> {
  const view = await installationView(tx, installationId);
  if (!view) return { applied: false, reason: "unknown_installation" };
  const { repos, ...installation } = view;
  return {
    applied: true,
    installation,
    repos: repos.map(({ id, fullName, visibility, installed, mode }) => ({ id, fullName, visibility, installed, mode })),
  };
}

function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const result = schema.safeParse(payload);
  if (!result.success) throw new WebhookPayloadError(result.error.message);
  return result.data;
}

export function webhookSecret(): string | undefined {
  return serviceConfig().githubWebhookSecret;
}
