import { accountName, DELETED_ACCOUNT } from "@testnotary/protocol";
import { database } from "../../../../../src/db/client.ts";
import { isAdmin } from "../../../../../src/server/access.ts";
import { now } from "../../../../../src/server/config.ts";
import { RETAINED_DAYS } from "../../../../../src/server/history.ts";
import { peopleOf, type PersonToken } from "../../../../../src/server/people.ts";
import { Avatar } from "../../../_components/avatar.tsx";
import { EmptyLine, Section } from "../../../_components/section.tsx";
import { day, rel } from "../../../_lib/format.ts";
import { blockLaptopTokenAction } from "../../../_lib/revocation-actions.ts";
import { requireRepoAccess } from "../../../_lib/viewer.ts";

// People (prototype `P.people`): each account that uploaded runs to the repo in the last 90 days,
// with its runs, attestations, skips earned, audits and mismatches, and under it the tokens it used
// with the agent labels their runs reported (self-reported: unverified). An admin, as GitHub says
// now, gets "Block on this repo" on a laptop token that still stands; nobody else sees a control.

const n = (value: number) => value.toLocaleString("en-US");

function Standing({ token, at }: { token: PersonToken; at: Date }) {
  switch (token.standing.kind) {
    case "blocked":
      return <span className="chip ghost run">Blocked {day(token.standing.at)}</span>;
    case "revoked":
      return <span className="chip ghost">Revoked</span>;
    case "expired":
      return <span className="chip ghost">Expired</span>;
    default:
      return token.lastUsedAt ? <span>{rel(token.lastUsedAt, at)}</span> : <span className="faint">Not used yet</span>;
  }
}

function BlockControl({ token, repository }: { token: PersonToken; repository: string }) {
  return (
    <details className="menu">
      <summary className="btn text">Block on this repo</summary>
      <div className="menu-pop" style={{ minWidth: 320, padding: 12 }}>
        <form action={blockLaptopTokenAction} className="field">
          <input type="hidden" name="token" value={token.id} />
          <input type="hidden" name="repository" value={repository} />
          <p className="muted" style={{ whiteSpace: "normal", textAlign: "left" }}>
            Block laptop token &ldquo;{token.name}&rdquo; on {repository}? It can no longer attest here, and its unexpired attestations stop counting at once. It
            still works on other repos, and a block can&rsquo;t be undone.
          </p>
          <label htmlFor={`note-${token.id}`}>Note (optional)</label>
          <input id={`note-${token.id}`} className="input" name="note" maxLength={200} placeholder="Why, for other admins" />
          <div style={{ marginTop: 8 }}>
            <button type="submit" className="btn amber" aria-label={`Block laptop token "${token.name}"`}>
              Block token
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}

export default async function PeoplePage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const access = await requireRepoAccess(params);
  const { repo } = access;
  const admin = isAdmin(access);
  const people = await peopleOf(database(), repo.id);
  const at = now();
  return (
    <Section
      title="People"
      sub={`Accounts that uploaded runs to ${repo.fullName} in the last ${RETAINED_DAYS} days, with their tokens. Agent labels are self-reported and unverified.`}
    >
      {people.length === 0 ? (
        <EmptyLine>No one has uploaded a run to this repo yet.</EmptyLine>
      ) : (
        <div className="panel">
          {/* No `.tbl-wrap`: its overflow would clip the Block popover. */}
          <table className="tbl people" aria-label="People">
            <thead>
              <tr>
                <th>Account and tokens</th>
                <th className="num">Runs</th>
                <th className="num">Attestations</th>
                <th className="num hide-s">Skips earned</th>
                <th className="num hide-s">Audits</th>
                <th className="num hide-s">Mismatches</th>
                <th className="num">Last active</th>
                <th />
              </tr>
            </thead>
            {people.map((person) => (
              <tbody key={person.account.id} aria-label={accountName(person.account)}>
                <tr className="acct">
                  <td>
                    <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
                      {person.account.id === DELETED_ACCOUNT.id ? null : <Avatar accountId={person.account.id} />}
                      <b style={{ fontWeight: 600 }}>{accountName(person.account)}</b>
                    </span>
                  </td>
                  <td className="num">{n(person.runs)}</td>
                  <td className="num">{n(person.attestations)}</td>
                  <td className="num hide-s">{n(person.skips)}</td>
                  <td className="num hide-s">{n(person.audits)}</td>
                  <td className="num hide-s">{person.mismatches ? <span className="count mm">{person.mismatches}</span> : "0"}</td>
                  <td className="num muted">{person.lastActiveAt ? rel(person.lastActiveAt, at) : ""}</td>
                  <td />
                </tr>
                {person.tokens.map((token) => (
                  <tr className="sub" key={token.id}>
                    <td>
                      {token.kind === "sandbox" ? (
                        <>
                          <span className="mono">{token.name}</span> <span className="muted">sandbox token</span>
                        </>
                      ) : (
                        <>
                          <span className="muted">laptop token</span> <span className="mono">{token.name}</span>
                        </>
                      )}
                      {token.agents.length > 0 ? (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {token.agents.join(", ")} · {token.sessions} {token.sessions === 1 ? "session" : "sessions"} · unverified labels
                        </div>
                      ) : null}
                    </td>
                    <td className="num muted">{n(token.runs)}</td>
                    <td className="num muted">{n(token.attestations)}</td>
                    <td className="num muted hide-s">{n(token.skips)}</td>
                    <td className="num muted hide-s">{n(token.audits)}</td>
                    <td className="num muted hide-s">{token.mismatches ? <span className="count mm">{token.mismatches}</span> : "0"}</td>
                    <td className="num muted">
                      <Standing token={token} at={at} />
                    </td>
                    <td className="num">
                      {admin && token.kind === "laptop" && token.standing.kind === "live" ? <BlockControl token={token} repository={repo.fullName} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </Section>
  );
}
