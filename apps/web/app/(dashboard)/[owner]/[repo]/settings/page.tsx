import { notFound } from "next/navigation";
import { database } from "../../../../../src/db/client.ts";
import { hasWriteAccess, isAdmin } from "../../../../../src/server/access.ts";
import { sandboxTokens } from "../../../../../src/server/tokens.ts";
import { SandboxTokenForm } from "../../../_components/sandbox-token-form.tsx";
import { SandboxTokenTable } from "../../../_components/sandbox-token-table.tsx";
import { Section } from "../../../_components/section.tsx";
import { getViewer, requireRepoAccess } from "../../../_lib/viewer.ts";

// Settings, hidden (and not found) when signed out. T-828 builds the mode toggle, the rates and the
// guarded files; T-827 the blocked laptop tokens and an admin's Revoke on anyone's sandbox token.
// Changes are for admins only (`isAdmin(access)`), sandbox tokens for write access
// (`hasWriteAccess(access)`): a writer sees and revokes their own, an admin sees every one.

export default async function SettingsPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const access = await requireRepoAccess(params);
  const viewer = await getViewer();
  if (!viewer) notFound();
  const { repo } = access;
  const canCreate = hasWriteAccess(access);
  const tokens = isAdmin(access)
    ? await sandboxTokens(database(), { repoId: repo.id })
    : canCreate
      ? await sandboxTokens(database(), { repoId: repo.id, createdBy: viewer.account.id })
      : [];
  return (
    <Section title="Settings" sub={`${repo.mode === "enforce" ? "Enforcing" : "Shadow mode"}. Audits 1 in ${repo.auditOneIn}, sandbox tokens 1 in ${repo.sandboxAuditOneIn}.`}>
      <section className="set-row">
        <div className="lab">
          <h2>Sandbox tokens</h2>
          <p>
            For agent sandboxes that cannot open a browser. One repo each, upload only, never renewed. Their attestations name the token and its creator, and stop
            counting once the creator loses write access.
          </p>
        </div>
        <div className="panel">
          <div className="panel-h">
            <span className="muted num">{tokens.length} active</span>
          </div>
          {tokens.length > 0 ? <SandboxTokenTable tokens={tokens} label="Sandbox tokens" show="creator" viewerId={viewer.account.id} /> : null}
          <div className="panel-b" style={{ paddingTop: 16 }}>
            {canCreate ? (
              <SandboxTokenForm repository={repo.fullName} />
            ) : (
              <p className="muted">Write access to {repo.fullName} is needed to create a sandbox token.</p>
            )}
          </div>
        </div>
      </section>
    </Section>
  );
}
