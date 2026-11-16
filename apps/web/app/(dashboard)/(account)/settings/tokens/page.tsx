import type { Metadata } from "next";
import { database } from "../../../../../src/db/client.ts";
import { laptopTokensOf, sandboxTokens, TOKEN_NAME_MAX, type LaptopTokenView } from "../../../../../src/server/tokens.ts";
import { SandboxTokenForm } from "../../../_components/sandbox-token-form.tsx";
import { LastUse, SandboxTokenTable } from "../../../_components/sandbox-token-table.tsx";
import { SignIn } from "../../../_components/shell.tsx";
import { date } from "../../../_lib/format.ts";
import { getReadableRepos, getViewer } from "../../../_lib/viewer.ts";
import { renameLaptopToken, revokeLaptopToken } from "./actions.ts";

export const metadata: Metadata = { title: "Tokens · Testnotary" };

function LaptopRow({ token }: { token: LaptopTokenView }) {
  return (
    <tr>
      <td>
        <span style={{ fontWeight: 500 }}>{token.name}</span> <span className="mono faint">{token.id.slice(0, 8)}…</span>
      </td>
      <td className="num muted hide-s">{date(token.createdAt)}</td>
      <td className="num muted hide-s">{date(token.expiresAt)}</td>
      <td className="num muted">
        <LastUse at={token.lastUsedAt} />
      </td>
      <td className="num">
        <div style={{ display: "inline-flex", gap: 4 }}>
          <details className="menu">
            <summary className="btn text">Rename</summary>
            <div className="menu-pop" style={{ minWidth: 300, padding: 12 }}>
              <form action={renameLaptopToken} className="field">
                <input type="hidden" name="token" value={token.id} />
                <label htmlFor={`name-${token.id}`}>New name</label>
                <input
                  id={`name-${token.id}`}
                  className="input"
                  name="name"
                  defaultValue={token.name}
                  required
                  maxLength={TOKEN_NAME_MAX}
                  aria-label={`New name for ${token.name}`}
                />
                <div>
                  <button type="submit" className="btn primary">
                    Save name
                  </button>
                </div>
              </form>
            </div>
          </details>
          <details className="menu">
            <summary className="btn text">Revoke</summary>
            <div className="menu-pop" style={{ minWidth: 300, padding: 12 }}>
              <form action={revokeLaptopToken} className="field">
                <input type="hidden" name="token" value={token.id} />
                <p className="muted" style={{ whiteSpace: "normal", textAlign: "left" }}>
                  Revoke {token.name}? The machine can no longer upload runs, and attestations it made stop counting at once.
                </p>
                <div>
                  <button type="submit" className="btn amber" aria-label={`Revoke ${token.name}`}>
                    Revoke token
                  </button>
                </div>
              </form>
            </div>
          </details>
        </div>
      </td>
    </tr>
  );
}

export default async function TokensPage() {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <div className="stack" style={{ maxWidth: 560, margin: "72px auto 0" }}>
        <h1>Tokens</h1>
        <p className="muted">Sign in to see your tokens.</p>
        <SignIn next="/settings/tokens" large />
      </div>
    );
  }
  const [laptop, sandbox, readable] = await Promise.all([
    laptopTokensOf(database(), viewer.account.id),
    sandboxTokens(database(), { createdBy: viewer.account.id }),
    getReadableRepos(),
  ]);
  const writable = readable.filter((repo) => repo.permission === "admin" || repo.permission === "write").map((repo) => repo.fullName);
  return (
    <div className="stack" style={{ gap: 20, maxWidth: 1080 }}>
      <div className="title-row">
        <div>
          <h1>Tokens</h1>
          <p className="sub">Revoking a token voids its unexpired attestations at once.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h">
          <h2>Laptop tokens</h2>
          <span className="side">
            <span>
              From <span className="mono">testnotary login</span>, one per machine, 90 days, renewed on use
            </span>
          </span>
        </div>
        {laptop.length === 0 ? (
          <div className="panel-b">
            <p className="empty-line">No laptop token. Run testnotary login on a machine to sign it in.</p>
          </div>
        ) : (
          // No `.tbl-wrap`: its overflow would clip the Rename and Revoke popovers.
          <div>
            <table className="tbl" aria-label="Laptop tokens">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num hide-s">Created</th>
                  <th className="num hide-s">Expires</th>
                  <th className="num">Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {laptop.map((token) => (
                  <LaptopRow key={token.id} token={token} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="panel">
        <div className="panel-h">
          <h2>Sandbox tokens you created</h2>
          <span className="side">For agent sandboxes: one repo each, upload only</span>
        </div>
        {sandbox.length === 0 ? (
          <div className="panel-b">
            <p className="empty-line">You have not created a sandbox token.</p>
          </div>
        ) : (
          <SandboxTokenTable tokens={sandbox} label="Sandbox tokens you created" show="repo" viewerId={viewer.account.id} />
        )}
        <div className="panel-b" style={{ paddingTop: 16 }}>
          {writable.length > 0 ? (
            <SandboxTokenForm repositories={writable} />
          ) : (
            <p className="muted">A sandbox token needs write access to a repo with Testnotary installed.</p>
          )}
        </div>
      </div>
    </div>
  );
}
