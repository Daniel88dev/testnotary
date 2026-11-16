import type { Metadata } from "next";
import Link from "next/link";
import { SignIn } from "../../../_components/shell.tsx";
import { getViewer } from "../../../_lib/viewer.ts";
import { DeleteAccount } from "./delete-account.tsx";

export const metadata: Metadata = { title: "Account · Testnotary" };

// The account menu's *Delete account* lands here: one confirmation, then the deletion takes effect
// at once (tokens revoked, sessions ended, records shown as *deleted account*).

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const viewer = await getViewer();
  const { deleted } = await searchParams;
  if (!viewer) {
    return (
      <div className="stack" style={{ maxWidth: 560, margin: "72px auto 0" }}>
        {deleted ? (
          <p className="warn-line" role="status">
            Your account is deleted. Your tokens are revoked, and your records show deleted account.
          </p>
        ) : null}
        <h1>Account</h1>
        <SignIn next="/settings/account" large />
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 20, maxWidth: 720 }}>
      <div className="title-row">
        <div>
          <h1>Account</h1>
          <p className="sub">Signed in as @{viewer.account.login} through GitHub.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h">
          <h2>Delete account</h2>
        </div>
        <div className="panel-b stack" style={{ gap: 14 }}>
          <p className="muted">
            Deleting your account revokes your tokens and signs you out at once. Your runs, attestations and mismatches stay in the repos
            they belong to and show <em>deleted account</em> instead of your name. See the <Link href="/privacy">Privacy policy</Link>.
          </p>
          <div>
            <DeleteAccount login={viewer.account.login} />
          </div>
        </div>
      </div>
    </div>
  );
}
