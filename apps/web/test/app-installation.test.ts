import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

/** A GitHub repo the fake knows, backed by a fixture repo. */
async function githubRepo(name: string, visibility: "public" | "private" = "public") {
  const fixture = await world.fixtureRepo();
  return world.github.addRepo(fixture, { owner: "acme", name, visibility });
}

describe("installing the GitHub App", () => {
  test("an installation webhook creates the installation and its repos, each in shadow mode", async () => {
    const widgets = await githubRepo("widgets");
    const gadgets = await githubRepo("gadgets", "private");

    const { installation, delivery } = await world.github.installApp({
      account: { login: "acme", type: "Organization" },
      repos: [widgets, gadgets],
    });

    expect(delivery.status).toBe(200);
    expect(delivery.body).toEqual({
      applied: true,
      installation: { id: installation.id, account: "acme", state: "active" },
      repos: [
        { id: gadgets.id, fullName: "acme/gadgets", visibility: "private", installed: true, mode: "shadow" },
        { id: widgets.id, fullName: "acme/widgets", visibility: "public", installed: true, mode: "shadow" },
      ],
    });
  });

  test("repository-added and repository-removed webhooks update the installation's repos", async () => {
    const first = await githubRepo("first");
    const second = await githubRepo("second");
    const { installation } = await world.github.installApp({ account: { login: "repo-owner" }, repos: [first] });

    const added = await world.github.addInstallationRepos(installation, [second]);
    const removed = await world.github.removeInstallationRepos(installation, [first]);

    expect(added).toMatchObject({ status: 200, body: { applied: true } });
    expect(names(added.body)).toEqual(["acme/first", "acme/second"]);
    expect(removed).toMatchObject({ status: 200, body: { applied: true } });
    expect(names(removed.body)).toEqual(["acme/second"]);
  });

  test("a repo given back after removal starts in shadow mode again", async () => {
    const repo = await githubRepo("returns");
    const { installation } = await world.github.installApp({ account: { login: "returner" }, repos: [repo] });
    await world.github.removeInstallationRepos(installation, [repo]);

    const back = await world.github.addInstallationRepos(installation, [repo]);

    expect(back.body).toMatchObject({ repos: [{ id: repo.id, installed: true, mode: "shadow" }] });
  });

  test("uninstalling the App, or suspending it, stops every repo at once", async () => {
    const repo = await githubRepo("stopped");
    const { installation } = await world.github.installApp({ account: { login: "uninstaller" }, repos: [repo] });

    const suspended = await world.github.setSuspended(installation, true);
    const unsuspended = await world.github.setSuspended(installation, false);
    const uninstalled = await world.github.uninstallApp(installation);

    expect(suspended.body).toMatchObject({ installation: { state: "suspended" }, repos: [] });
    expect(unsuspended.body).toMatchObject({ installation: { state: "active" }, repos: [{ fullName: "acme/stopped" }] });
    expect(uninstalled.body).toMatchObject({ installation: { state: "deleted" }, repos: [] });
  });

  test("repository events rename, change visibility, and stop deleted or transferred repos", async () => {
    const renamed = await githubRepo("old-name");
    const hidden = await githubRepo("hidden");
    const moved = await githubRepo("moved");
    const gone = await githubRepo("gone");
    const { installation } = await world.github.installApp({ account: { login: "lifecycle" }, repos: [renamed, hidden, moved, gone] });

    await world.github.repositoryEvent(installation, renamed, { action: "renamed", name: "new-name" });
    await world.github.repositoryEvent(installation, hidden, { action: "privatized" });
    await world.github.repositoryEvent(installation, moved, { action: "transferred", owner: "elsewhere" });
    const last = await world.github.repositoryEvent(installation, gone, { action: "deleted" });

    expect(last.body).toMatchObject({
      applied: true,
      repos: [
        { fullName: "acme/hidden", visibility: "private", installed: true },
        { fullName: "acme/new-name", visibility: "public", installed: true },
      ],
    });
    expect(names(last.body)).toEqual(["acme/hidden", "acme/new-name"]);
  });

  test("a redelivered webhook is applied once", async () => {
    const repo = await githubRepo("redelivered");
    const { installation } = await world.github.installApp({ account: { login: "redeliverer" }, repos: [repo] });
    const removal = await world.github.removeInstallationRepos(installation, [repo]);

    const again = await world.github.deliverWebhook("installation_repositories", removal.payload as Record<string, unknown>, {
      deliveryId: removal.id,
    });

    expect(again).toMatchObject({ status: 200, body: { applied: false, reason: "duplicate_delivery" } });
  });

  test("a webhook without a valid signature is refused and changes nothing", async () => {
    const repo = await githubRepo("forged");
    const payload = {
      action: "created",
      installation: { id: 999_001, account: { login: "forger", id: 999_002, type: "User" } },
      repositories: [{ id: repo.id, full_name: repo.fullName, name: repo.name, private: false }],
    };

    const unsigned = await world.github.deliverWebhook("installation", payload, { secret: null });
    const wrongSecret = await world.github.deliverWebhook("installation", payload, { secret: "not-the-secret" });
    const genuineRemoval = await world.github.deliverWebhook("installation_repositories", {
      action: "removed",
      installation: payload.installation,
      repositories_added: [],
      repositories_removed: [],
    });

    expect(unsigned.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    // Had the forged `created` been applied, the installation would exist and list the repo.
    expect(genuineRemoval.body).toMatchObject({ applied: true, repos: [] });
  });
});

function names(body: unknown): string[] {
  return (body as { repos: { fullName: string }[] }).repos.map((repo) => repo.fullName);
}
