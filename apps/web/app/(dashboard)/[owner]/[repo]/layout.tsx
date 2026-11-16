import type { ReactNode } from "react";
import { LegalChanges } from "../../_components/legal-changes.tsx";
import { RepoColumn, visibleSections } from "../../_components/repo-column.tsx";
import { MobileBar } from "../../_components/shell.tsx";
import { database } from "../../../../src/db/client.ts";
import { now } from "../../../../src/server/config.ts";
import { suitesLastResult } from "../../../../src/server/history.ts";
import { openMismatchCounts } from "../../../../src/server/settings.ts";
import { rel } from "../../_lib/format.ts";
import { getReadableRepos, getViewer, requireRepoAccess } from "../../_lib/viewer.ts";

// A repo's pages at its GitHub path, `/<owner>/<repo>/…`. A private repo the person cannot read on
// GitHub, or a repo without the App, is not found, signed in or not. Every page under here calls
// `requireRepoAccess(params)` again (cached per request) to get the repo and the person's permission.

export default async function RepoLayout({ children, params }: { children: ReactNode; params: Promise<{ owner: string; repo: string }> }) {
  const access = await requireRepoAccess(params);
  const viewer = await getViewer();
  const repos = viewer ? await getReadableRepos() : [];
  const fullName = access.repo.fullName;
  const at = now();
  const suites = (await suitesLastResult(database(), access.repo.id)).map((suite) => ({
    name: suite.suite,
    lastResult: suite.result === "skip" || suite.result === "would_skip" ? ("skip" as const) : ("run" as const),
    at: rel(suite.at, at),
  }));
  const openMismatches = (await openMismatchCounts(database(), [access.repo.id])).get(access.repo.id) ?? 0;
  return (
    <>
      <RepoColumn access={access} viewer={viewer} repos={repos} suites={suites} openMismatches={openMismatches} />
      <main className="dash-main">
        <MobileBar title={fullName} repo={{ fullName, sections: visibleSections(fullName, viewer) }} viewer={viewer} />
        <LegalChanges />
        {children}
      </main>
    </>
  );
}
