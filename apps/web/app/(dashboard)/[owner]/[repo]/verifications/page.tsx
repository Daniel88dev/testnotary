import { EmptyLine, Section } from "../../../_components/section.tsx";
import { requireRepoAccess } from "../../../_lib/viewer.ts";

// Verifications. T-824 builds the table, its filters (`?result=`, `?reason=`, `?suite=`, `?page=`)
// and the commit pages.

export default async function VerificationsPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  await requireRepoAccess(params);
  return (
    <Section title="Verifications" sub="Every decision CI asked Testnotary for, newest first.">
      <EmptyLine>No verifications yet.</EmptyLine>
    </Section>
  );
}
