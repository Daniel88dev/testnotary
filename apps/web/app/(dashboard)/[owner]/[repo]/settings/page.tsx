import { notFound } from "next/navigation";
import { accountName } from "@testnotary/protocol";
import { database } from "../../../../../src/db/client.ts";
import { hasWriteAccess, isAdmin } from "../../../../../src/server/access.ts";
import { blockedLaptopTokens } from "../../../../../src/server/revocations.ts";
import { sandboxTokens } from "../../../../../src/server/tokens.ts";
import { SandboxTokenForm } from "../../../_components/sandbox-token-form.tsx";
import { SandboxTokenTable } from "../../../_components/sandbox-token-table.tsx";
import { Section } from "../../../_components/section.tsx";
import { day } from "../../../_lib/format.ts";
import { getViewer, requireRepoAccess } from "../../../_lib/viewer.ts";

// Settings, hidden (and not found) when signed out. T-828 builds the mode toggle, the rates and the
// guarded files. Changes are for admins only (`isAdmin(access)`), sandbox tokens for write access
// (`hasWriteAccess(access)`): a writer sees and revokes their own, an admin sees and revokes every
// one. Blocked laptop tokens are listed for every signed-in reader; admins block them from People,
// and nothing unblocks one.

export default async function SettingsPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const access = await requireRepoAccess(params);
  const viewer = await getViewer();
  if (!viewer) notFound();
  const { repo } = access;
  const admin = isAdmin(access);
  const canCreate = hasWriteAccess(access);
  const db = database();
  const [tokens, blocked] = await Promise.all([
    admin
      ? sandboxTokens(db, { repoId: repo.id })
      : canCreate
        ? sandboxTokens(db, { repoId: repo.id, createdBy: viewer.account.id })
        : Promise.resolve([]),
    blockedLaptopTokens(db, repo.id),
  ]);
  return (
    <Section title="Settings" sub={`${repo.mode === "enforce" ? "Enforcing" : "Shadow mode"}. Audits 1 in ${repo.auditOneIn}, sandbox tokens 1 in ${repo.sandboxAuditOneIn}.`}>
      <section className="set-row">
        <div className="lab">
          <h2>Sandbox tokens</h2>
          <p>
            For agent sandboxes that cannot open a browser. One repo each, upload only, never renewed. Their attestations name the token and its creator, and stop
            counting once the token is revoked or expires, or the creator loses write access.
          </p>
        </div>
        <div className="panel">
          <div className="panel-h">
            <span className="muted num">{tokens.length} active</span>
          </div>
          {tokens.length > 0 ? (
            <SandboxTokenTable tokens={tokens} label="Sandbox tokens" show="creator" viewerId={viewer.account.id} adminOf={admin ? repo.fullName : undefined} />
          ) : null}
          <div className="panel-b" style={{ paddingTop: 16 }}>
            {canCreate ? (
              <SandboxTokenForm repository={repo.fullName} />
            ) : (
              <p className="muted">Write access to {repo.fullName} is needed to create a sandbox token.</p>
            )}
          </div>
        </div>
      </section>
      <section className="set-row">
        <div className="lab">
          <h2>Blocked laptop tokens</h2>
          <p>A blocked token can no longer attest on this repo, and its unexpired attestations stop counting at once. It still works on other repos.</p>
        </div>
        <div className="panel">
          {blocked.length === 0 ? (
            <div className="panel-b" style={{ paddingTop: 16 }}>
              <p className="empty-line">No laptop token is blocked on {repo.fullName}.{admin ? " Block one from People." : ""}</p>
            </div>
          ) : (
            <table className="tbl" aria-label="Blocked laptop tokens">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Blocked by</th>
                  <th className="num">When</th>
                </tr>
              </thead>
              <tbody>
                {blocked.map((block) => (
                  <tr key={block.tokenId}>
                    <td className="wrap">
                      {accountName(block.owner)} <span className="muted">laptop token{block.owner.login === null ? "" : ` "${block.name}"`}</span>
                    </td>
                    <td className="wrap">
                      {accountName(block.blockedBy)}
                      {block.note ? <span className="faint"> {block.note}</span> : null}
                    </td>
                    <td className="num muted">{day(block.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </Section>
  );
}
