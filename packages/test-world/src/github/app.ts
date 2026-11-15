import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FakeRepo } from "./state.ts";

// The Testnotary GitHub App as the fake GitHub knows it: its client id (device flow), its webhook
// secret and where its webhooks go. NOTES/github-behaviours.md §11 and §12.

export interface FakeApp {
  id: number;
  slug: string;
  /** The App's OAuth client id: the device flow's `client_id`. No secret is needed for it. */
  clientId: string;
  /** Signs every delivery (`X-Hub-Signature-256`). The service gets the same value. */
  webhookSecret: string;
  /** Where deliveries go. The world points it at the service's webhook route. */
  webhookUrl: string | undefined;
}

/** A GitHub account an installation belongs to: a person or an organization. */
export interface FakeAccount {
  login: string;
  id: number;
  type: "User" | "Organization";
}

export interface FakeInstallation {
  id: number;
  account: FakeAccount;
  /** Ids of the repos the account gave the App. */
  repoIds: Set<number>;
  suspended: boolean;
}

/** One webhook GitHub sent, and what the service answered (GitHub's "Recent deliveries"). */
export interface WebhookDelivery {
  id: string;
  event: string;
  action: string | undefined;
  payload: unknown;
  status: number;
  body: unknown;
}

export interface DeliverOptions {
  /** `X-GitHub-Delivery`; a redelivery reuses the original's. */
  deliveryId?: string;
  /** Signs with another secret, or sends no signature header at all (`null`). */
  secret?: string | null;
}

export function newApp(id: number): FakeApp {
  return {
    id,
    slug: "testnotary-world",
    clientId: `Iv23li${randomBytes(7).toString("hex")}`,
    webhookSecret: randomBytes(20).toString("hex"),
    webhookUrl: undefined,
  };
}

/** A repo as webhook payloads carry it (`repositories`, `repositories_added`, …). */
export function repoPayload(repo: FakeRepo) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.visibility === "private",
  };
}

export function installationPayload(app: FakeApp, installation: FakeInstallation) {
  return {
    id: installation.id,
    account: { login: installation.account.login, id: installation.account.id, type: installation.account.type },
    app_id: app.id,
    app_slug: app.slug,
    target_id: installation.account.id,
    target_type: installation.account.type,
    repository_selection: "selected",
    permissions: { contents: "read", metadata: "read" },
    events: ["installation", "installation_repositories", "repository"],
    suspended_at: installation.suspended ? new Date().toISOString() : null,
  };
}

/** POSTs one signed delivery the way GitHub does (headers per the webhook docs, §12). */
export async function deliver(app: FakeApp, event: string, payload: Record<string, unknown>, options: DeliverOptions = {}): Promise<WebhookDelivery> {
  if (!app.webhookUrl) throw new Error("the fake App has no webhook URL; the world sets it to the service's");
  const id = options.deliveryId ?? randomUUID();
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "GitHub-Hookshot/fake",
    "x-github-event": event,
    "x-github-delivery": id,
    "x-github-hook-id": "1",
    "x-github-hook-installation-target-type": "integration",
    "x-github-hook-installation-target-id": String(app.id),
  };
  const secret = options.secret === undefined ? app.webhookSecret : options.secret;
  if (secret !== null) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(app.webhookUrl, { method: "POST", headers, body });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    // Not JSON: keep the text.
  }
  return { id, event, action: typeof payload.action === "string" ? payload.action : undefined, payload, status: response.status, body: parsed };
}
