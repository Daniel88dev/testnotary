import { database } from "../../../../src/db/client.ts";
import { hasVerifications, setupState } from "../../../../src/server/overview.ts";
import { EmptyLine, Section } from "../../_components/section.tsx";
import { SetupChecklist } from "../../_components/setup-checklist.tsx";
import { requireRepoAccess } from "../../_lib/viewer.ts";

// Overview: a repo admin judges at a glance whether Testnotary pays off and what to fix. A repo
// with no verification yet shows the setup checklist instead.

export default async function OverviewPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { repo } = await requireRepoAccess(params);
  const db = database();
  if (!(await hasVerifications(db, repo.id))) {
    return (
      <Section title="Overview" sub={`No verification has reached Testnotary for ${repo.fullName} yet. These are the steps left.`}>
        <SetupChecklist setup={await setupState(db, repo)} fullName={repo.fullName} />
      </Section>
    );
  }
  return (
    <Section title="Overview">
      <EmptyLine>Numbers follow.</EmptyLine>
    </Section>
  );
}
