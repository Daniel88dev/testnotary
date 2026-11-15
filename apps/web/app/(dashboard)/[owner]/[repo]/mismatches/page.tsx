import { EmptyLine, Section } from "../../../_components/section.tsx";
import { requireRepoAccess } from "../../../_lib/viewer.ts";

// Mismatches. T-828 builds the open and explained mismatches and their explanations.

export default async function MismatchesPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  await requireRepoAccess(params);
  return (
    <Section title="Mismatches" sub="Audits where CI's tests failed on a tree an attestation said passed.">
      <EmptyLine>No mismatches.</EmptyLine>
    </Section>
  );
}
