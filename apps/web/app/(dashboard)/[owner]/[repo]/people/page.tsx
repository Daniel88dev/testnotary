import { EmptyLine, Section } from "../../../_components/section.tsx";
import { requireRepoAccess } from "../../../_lib/viewer.ts";

// People. T-827 builds the accounts and their tokens, and blocking a laptop token for admins.

export default async function PeoplePage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  await requireRepoAccess(params);
  return (
    <Section title="People" sub="Everyone whose attestations this repo has used, with their tokens.">
      <EmptyLine>No one has attested on this repo yet.</EmptyLine>
    </Section>
  );
}
