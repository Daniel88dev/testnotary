import Link from "next/link";
import type { SandboxTokenView } from "../../../src/server/tokens.ts";
import { revokeSandboxToken } from "../_lib/sandbox-token-actions.ts";
import { date, rel } from "../_lib/format.ts";
import { Avatar } from "./avatar.tsx";

// Live sandbox tokens as a table: on the Tokens page (yours, with their repo) and in a repo's
// Settings (with who created each). Only a token's creator gets Revoke here; an admin revoking
// anyone's token is T-827's, and adds its own control in `Actions` below.

export function LastUse({ at }: { at: Date | null }) {
  if (!at) return <span className="faint">Not used yet</span>;
  return (
    <time dateTime={at.toISOString()} title={at.toISOString()}>
      {rel(at)}
    </time>
  );
}

function Actions({ token, viewerId }: { token: SandboxTokenView; viewerId: number }) {
  if (token.createdBy.id !== viewerId) return null;
  return (
    <details className="menu">
      <summary className="btn text">Revoke</summary>
      <div className="menu-pop" style={{ minWidth: 300, padding: 12 }}>
        <form action={revokeSandboxToken} className="field">
          <input type="hidden" name="token" value={token.id} />
          <p className="muted" style={{ whiteSpace: "normal", textAlign: "left" }}>
            Revoke {token.name}? The sandbox can no longer upload runs, and attestations it made stop counting at once.
          </p>
          <div>
            <button type="submit" className="btn amber" aria-label={`Revoke ${token.name}`}>
              Revoke token
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}

export function SandboxTokenTable({ tokens, label, show, viewerId }: { tokens: SandboxTokenView[]; label: string; show: "repo" | "creator"; viewerId: number }) {
  return (
    // No `.tbl-wrap`: its overflow would clip the Revoke popover.
    <div>
      <table className="tbl" aria-label={label}>
        <thead>
          <tr>
            <th>Name</th>
            <th>{show === "repo" ? "Repo" : "Created by"}</th>
            <th className="num hide-s">Expires</th>
            <th className="num">Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr key={token.id}>
              <td>
                <span className="mono">{token.name}</span>
              </td>
              <td>
                {show === "repo" ? (
                  <Link className="ink-link" href={`/${token.repo.fullName}/settings`}>
                    {token.repo.fullName}
                  </Link>
                ) : (
                  <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                    <Avatar accountId={token.createdBy.id} />@{token.createdBy.login}
                  </span>
                )}
              </td>
              <td className="num muted hide-s">{date(token.expiresAt)}</td>
              <td className="num muted">
                <LastUse at={token.lastUsedAt} />
              </td>
              <td className="num">
                <Actions token={token} viewerId={viewerId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
