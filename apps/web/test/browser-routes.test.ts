import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

describe("the avatar route", () => {
  test("serves a GitHub avatar from the service, fetched from GitHub's avatars host", async () => {
    const maria = world.github.addUser({ login: "maria-k" });

    const response = await fetch(`${world.service.url}/api/avatars/${maria.id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(world.github.requestsTo("GET", `/avatars/u/${maria.id}`)).toHaveLength(1);
  });

  test("answers 404 for an id that is not a number, without asking GitHub", async () => {
    const before = world.github.requests.length;

    const response = await fetch(`${world.service.url}/api/avatars/..%2Fuser`);

    expect(response.status).toBe(404);
    expect(world.github.requests.slice(before).filter((request) => request.path.startsWith("/avatars"))).toEqual([]);
  });

  test("answers 404 when GitHub has no image, and never passes on anything that is not one", async () => {
    const restore = world.github.override("GET", "/avatars/u/:id", () => new Response("<html>nope</html>", { headers: { "content-type": "text/html" } }));
    try {
      const response = await fetch(`${world.service.url}/api/avatars/4242`);
      expect(response.status).toBe(404);
    } finally {
      restore();
    }
  });
});

describe("sign-in and sign-out", () => {
  test("a form posted from another site cannot start a sign-in or end a session", async () => {
    for (const path of ["/api/session/sign-in", "/api/session/sign-out"]) {
      const response = await fetch(`${world.service.url}${path}`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
        body: "next=%2Fdashboard",
        redirect: "manual",
      });
      expect(response.status).toBe(403);
    }
  });

  test("a sign-in never sends the browser anywhere but this site afterwards", async () => {
    const response = await fetch(`${world.service.url}/api/session/sign-in`, {
      method: "POST",
      headers: { origin: world.service.url, "content-type": "application/x-www-form-urlencoded" },
      body: `next=${encodeURIComponent("//evil.example/x")}`,
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.origin).toBe(world.github.url);
    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(world.github.app.clientId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${world.service.url}/api/auth/callback/github`);

    // GitHub approves; the callback lands on the default page, not on the other site.
    const maria = world.github.addUser({ login: "maria-k" });
    world.github.webFlow.approveNext(maria);
    const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    const back = await fetch(authorize, { redirect: "manual" });
    const callback = await fetch(back.headers.get("location")!, { headers: { cookie: cookies }, redirect: "manual" });
    expect(callback.headers.get("location")).toBe("/dashboard");
  });
});
