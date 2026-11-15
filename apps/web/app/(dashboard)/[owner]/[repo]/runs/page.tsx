import { EmptyLine, Section } from "../../../_components/section.tsx";
import { requireRepoAccess } from "../../../_lib/viewer.ts";

// Runs. T-824 builds the table (`?outcome=`, `?page=`) and the run pages at `runs/<id>`.

export default async function RunsPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  await requireRepoAccess(params);
  return (
    <Section title="Runs" sub="Every run uploaded for this repo: passed, failed and refused.">
      <EmptyLine>No runs yet.</EmptyLine>
    </Section>
  );
}
