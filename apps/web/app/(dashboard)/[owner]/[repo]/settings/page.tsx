import Link from "next/link";
import { notFound } from "next/navigation";
import { accountName } from "@testnotary/protocol";
import { database } from "../../../../../src/db/client.ts";
import { hasWriteAccess, isAdmin } from "../../../../../src/server/access.ts";
import { blockedLaptopTokens } from "../../../../../src/server/revocations.ts";
import { guardedFilesOf, RATE_CHOICES, settingsOf, type SettingsShown } from "../../../../../src/server/settings.ts";
import { sandboxTokens } from "../../../../../src/server/tokens.ts";
import { SandboxTokenForm } from "../../../_components/sandbox-token-form.tsx";
import { SandboxTokenTable } from "../../../_components/sandbox-token-table.tsx";
import { Section } from "../../../_components/section.tsx";
import { ModeSwitch, RatesForm } from "../../../_components/settings-controls.tsx";
import { day } from "../../../_lib/format.ts";
import { repoHref } from "../../../_lib/sections.ts";
import { getViewer, requireRepoAccess } from "../../../_lib/viewer.ts";

// Settings, hidden (and not found) when signed out. Every signed-in reader sees the settings in
// effect and the evidence beside the toggle; only admins (`isAdmin(access)`, asked of GitHub live,
// and again inside every action) change the mode and the rates, each change a new setting-change
// row. Sandbox tokens are for write access: a writer sees and revokes their own, an admin every
// one. Blocked laptop tokens are listed for every signed-in reader; admins block them from People,
// and nothing unblocks one. The guarded files are read-only: they are edited in testnotary.json.

export default async function SettingsPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const access = await requireRepoAccess(params);
  const viewer = await getViewer();
  if (!viewer) notFound();
  const { repo } = access;
  const admin = isAdmin(access);
  const canCreate = hasWriteAccess(access);
  const db = database();
  const [settings, tokens, blocked, guarded] = await Promise.all([
    settingsOf(db, repo.id),
    admin
      ? sandboxTokens(db, { repoId: repo.id })
      : canCreate
        ? sandboxTokens(db, { repoId: repo.id, createdBy: viewer.account.id })
        : Promise.resolve([]),
    blockedLaptopTokens(db, repo.id),
    guardedFilesOf(repo),
  ]);
  const enforcing = settings.mode === "enforce";
  return (
    <Section
      title="Settings"
      sub={admin ? "Admins change the mode and the audit rates; anyone with write access creates a sandbox token." : "Only an admin of the repository changes these."}
    >
      <section className="set-row" aria-labelledby="mode-title">
        <div className="lab">
          <h2 id="mode-title">Mode</h2>
          <p>
            Enforce lets a test job skip when an attestation matches its tree. Shadow mode only records what would have skipped, while CI runs every test
            job. To turn Testnotary off in CI at once, set the repo variable <span className="mono">TESTNOTARY_DISABLED</span>.
          </p>
        </div>
        <div className="panel">
          <div className="panel-b" style={{ paddingTop: 18, display: "grid", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
              <div>
                <b style={{ fontWeight: 500 }}>Enforce</b>{" "}
                {enforcing ? (
                  <span className="chip skip" style={{ marginLeft: 8 }}>
                    Enforcing
                  </span>
                ) : (
                  <span className="chip ghost run" style={{ marginLeft: 8 }}>
                    Shadow mode
                  </span>
                )}
                <LastChange settings={settings} />
              </div>
              {admin ? (
                <ModeSwitch repository={repo.fullName} mode={settings.mode} warnings={settings.warnings} blocked={settings.openMismatches > 0} />
              ) : (
                <button type="button" className="switch" role="switch" aria-checked={enforcing} aria-label="Enforce" disabled />
              )}
            </div>
            <dl className="kv" aria-label="Shadow record">
              <dt>Last 90 days</dt>
              <dd className="num">
                {settings.record.compared} compared, {settings.record.agreed} agreed, {settings.record.mismatches}{" "}
                {settings.record.mismatches === 1 ? "mismatch" : "mismatches"}
              </dd>
              {settings.sinceLastMismatch ? (
                <>
                  <dt>Since the last mismatch, {day(settings.sinceLastMismatch.at)}</dt>
                  <dd className="num">
                    {settings.sinceLastMismatch.compared} compared, {settings.sinceLastMismatch.agreed} agreed
                  </dd>
                </>
              ) : null}
            </dl>
            <p className="muted" style={{ fontSize: 13 }}>
              A comparison is an audit or a shadow <em>would have skipped</em> whose CI test job reported; it agrees when the tests passed in CI too.
            </p>
            {settings.openMismatches > 0 ? (
              <p className="warn-line">
                <span>
                  {settings.openMismatches === 1 ? "One unexplained mismatch" : `${settings.openMismatches} unexplained mismatches`}. Enforce stays off until an
                  admin explains {settings.openMismatches === 1 ? "it" : "each"} on{" "}
                  <Link className="link" href={repoHref(repo.fullName, "mismatches")}>
                    Mismatches
                  </Link>
                  .
                </span>
              </p>
            ) : null}
            {(settings.openMismatches > 0 ? [] : settings.warnings).map((warning) => (
              <p key={warning} className="warn-line">
                {warning} Switching is allowed; it is a warning, not a block.
              </p>
            ))}
          </div>
        </div>
      </section>
      <section className="set-row" aria-labelledby="rates-title">
        <div className="lab">
          <h2 id="rates-title">Audit rate</h2>
          <p>
            In enforce mode CI runs the tests anyway on a random share of the jobs an attestation would skip. Raise the rate to buy more confidence with CI
            minutes; it never goes below 1 in 10, or 1 in 5 for sandbox tokens. The sandbox rate defaults to twice the laptop rate.
          </p>
        </div>
        <div className="panel">
          <div className="panel-b" style={{ paddingTop: 18 }}>
            {admin ? (
              <RatesForm
                repository={repo.fullName}
                auditOneIn={settings.auditOneIn}
                sandboxAuditOneIn={settings.sandboxAuditOneIn}
                sandboxFollowsRepo={settings.sandboxFollowsRepo}
                laptopChoices={RATE_CHOICES.laptop}
                sandboxChoices={RATE_CHOICES.sandbox}
              />
            ) : (
              <dl className="kv">
                <dt>Laptop tokens</dt>
                <dd className="num">1 in {settings.auditOneIn}</dd>
                <dt>Sandbox tokens</dt>
                <dd className="num">
                  1 in {settings.sandboxAuditOneIn}
                  {settings.sandboxFollowsRepo ? <span className="muted"> (twice the laptop rate)</span> : null}
                </dd>
              </dl>
            )}
          </div>
        </div>
      </section>
      <section className="set-row" aria-labelledby="sandbox-title">
        <div className="lab">
          <h2 id="sandbox-title">Sandbox tokens</h2>
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
      <section className="set-row" aria-labelledby="blocked-title">
        <div className="lab">
          <h2 id="blocked-title">Blocked laptop tokens</h2>
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
      <section className="set-row" aria-labelledby="guarded-title">
        <div className="lab">
          <h2 id="guarded-title">Guarded files</h2>
          <p>
            A pull request that changes one of these runs its tests whatever attestation exists. Read from <span className="mono">testnotary.json</span> on
            the default branch; edit them there. A pull request is checked against its base branch&apos;s config.
          </p>
        </div>
        <div className="panel">
          <div className="panel-b" style={{ paddingTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div>
              <h3 className="muted" id="guarded-defaults" style={{ fontWeight: 500 }}>
                Product defaults
              </h3>
              <GlobList labelledBy="guarded-defaults" globs={guarded.defaults} />
            </div>
            <div>
              <h3 className="muted" id="guarded-added" style={{ fontWeight: 500 }}>
                Added by this repo
              </h3>
              {guarded.added.length > 0 ? (
                <GlobList labelledBy="guarded-added" globs={guarded.added} />
              ) : (
                <p className="empty-line" style={{ marginTop: 8 }}>
                  {guarded.source === "unavailable"
                    ? "GitHub could not be asked for testnotary.json just now."
                    : guarded.source === "invalid"
                      ? "testnotary.json on the default branch does not parse."
                      : guarded.source === "no_config"
                        ? "No testnotary.json on the default branch yet."
                        : "None."}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </Section>
  );
}

function GlobList({ globs, labelledBy }: { globs: readonly string[]; labelledBy: string }) {
  return (
    <ul className="mono" aria-labelledby={labelledBy} style={{ listStyle: "none", padding: 0, margin: "8px 0 0", lineHeight: "26px" }}>
      {globs.map((glob) => (
        <li key={glob}>{glob}</li>
      ))}
    </ul>
  );
}

/** The latest setting change: when, and who or what made it. */
function LastChange({ settings }: { settings: SettingsShown }) {
  const change = settings.lastChange;
  if (!change) return null;
  const why =
    change.by !== null
      ? ` by ${accountName(change.by)}`
      : change.reason === "mismatch"
        ? ", when a mismatch sent the repo back to shadow mode"
        : change.reason === "installed"
          ? ", when the App was installed: new repos start in shadow mode"
          : change.reason === "reinstalled"
            ? ", when the App was installed again: a reinstalled repo starts in shadow mode"
            : "";
  return (
    <p className="muted" style={{ marginTop: 4 }}>
      Last changed {day(change.at)}
      {why}.
    </p>
  );
}
