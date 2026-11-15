import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

// The web app as it starts in production: its own server process, the secrets in its environment
// only as references to Secrets Manager, and errors reported to Sentry. Secrets Manager and Sentry
// are the world's local fakes; no request leaves the machine.

describe("a service whose secrets live in Secrets Manager", () => {
  const world = useWorld({ service: "next", secrets: ["DATABASE_URL"] });

  test("reads the database credentials from Secrets Manager when it starts", async () => {
    const response = await fetch(`${world.service.url}/api/v1/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "ok" });
    expect(world.secretsManager.requests).toContainEqual(
      expect.objectContaining({ action: "GetSecretValue", secretId: "testnotary/world/DATABASE_URL", signed: true }),
    );
  });
});

describe("a service with a secret it cannot read", () => {
  // A reference to a secret the fake Secrets Manager does not hold.
  const world = useWorld({
    service: "next",
    secrets: ["DATABASE_URL"],
    serviceEnv: { AUDIT_MASTER_KEY: "secretsmanager:testnotary/world/AUDIT_MASTER_KEY" },
  });

  test("answers no request and reports which secret is missing to Sentry", async () => {
    // The standalone server answers every request 500 (so a deploy fails its health check);
    // `next dev` drops the connection instead.
    const answer = await fetch(`${world.service.url}/api/v1/health`).then(
      (response) => response.status,
      () => "connection closed",
    );

    expect(answer).not.toBe(200);
    const event = await world.sentry.waitForEvent();
    expect(event.exception?.values?.map((value) => value.value)).toContain(
      "AUDIT_MASTER_KEY: cannot read secret testnotary/world/AUDIT_MASTER_KEY from Secrets Manager",
    );
  });
});

describe("a service that cannot reach its database", () => {
  // Nothing listens on port 1, so every connection is refused.
  const world = useWorld({
    service: "next",
    serviceEnv: { DATABASE_URL: "postgres://testnotary_app:testnotary_app@127.0.0.1:1/testnotary" },
  });

  test("reports the error to Sentry", async () => {
    const response = await fetch(`${world.service.url}/api/v1/health`, {
      headers: { authorization: "Bearer tnl_never-reaches-sentry", cookie: "session=never-reaches-sentry" },
    });

    expect(response.status).toBe(503);
    const event = await world.sentry.waitForEvent();
    // Drizzle's "Failed query" error, with the refused connection as its cause.
    expect(event.exception?.values?.map((value) => value.value).join("\n")).toMatch(/ECONNREFUSED/);
    expect(JSON.stringify(world.sentry.envelopes)).not.toContain("never-reaches-sentry");
  });
});
