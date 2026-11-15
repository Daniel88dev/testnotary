import type { Metadata } from "next";
import { SignIn } from "../../../_components/shell.tsx";
import { getViewer } from "../../../_lib/viewer.ts";

export const metadata: Metadata = { title: "Account · Testnotary" };

// The account menu's *Delete account* lands here. T-817 adds the deletion itself (one confirmation,
// tokens revoked, the name shown as *deleted account* on records).

export default async function AccountPage() {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <div className="stack" style={{ maxWidth: 560, margin: "72px auto 0" }}>
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
        <div className="panel-b">
          <p className="muted">
            Deleting your account revokes your tokens and shows your name as <em>deleted account</em> on the records it left.
          </p>
        </div>
      </div>
    </div>
  );
}
