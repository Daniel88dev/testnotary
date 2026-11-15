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
