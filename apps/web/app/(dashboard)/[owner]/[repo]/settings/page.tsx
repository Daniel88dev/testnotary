import { notFound } from "next/navigation";
import { EmptyLine, Section } from "../../../_components/section.tsx";
import { getViewer, requireRepoAccess } from "../../../_lib/viewer.ts";

// Settings, hidden (and not found) when signed out. T-828 builds the mode toggle, the rates and the
// guarded files; T-823 and T-827 the sandbox and blocked tokens. Changes are for admins only
// (`isAdmin(access)`), sandbox tokens for write access (`hasWriteAccess(access)`).

export default async function SettingsPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { repo } = await requireRepoAccess(params);
  if (!(await getViewer())) notFound();
  return (
    <Section title="Settings" sub={`${repo.mode === "enforce" ? "Enforcing" : "Shadow mode"}. Audits 1 in ${repo.auditOneIn}, sandbox tokens 1 in ${repo.sandboxAuditOneIn}.`}>
      <EmptyLine>Nothing to change here yet.</EmptyLine>
    </Section>
  );
}
