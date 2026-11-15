import { EmptyLine, Section } from "../../_components/section.tsx";
import { requireRepoAccess } from "../../_lib/viewer.ts";

// Overview. T-826 builds the KPIs, chart, suites, reasons and the live log, and the setup checklist
// a repo with no verifications shows.

export default async function OverviewPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { repo } = await requireRepoAccess(params);
  return (
    <Section title="Overview" sub={`${repo.fullName} is in ${repo.mode === "enforce" ? "enforce" : "shadow"} mode.`}>
      <EmptyLine>No verification has reached Testnotary for this repo yet.</EmptyLine>
    </Section>
  );
}
