import type { ReactNode } from "react";
import { NavLink } from "../_components/client.tsx";
import { MobileBar } from "../_components/shell.tsx";
import { getViewer } from "../_lib/viewer.ts";

// Pages that belong to the person, not to a repo: home (Repositories) and the account's Tokens.

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  return (
    <>
      <div className="dash-nav">
        <div className="grp first">Testnotary</div>
        <nav aria-label="Account">
          <NavLink href="/dashboard" exact>
            <span className="l">Repositories</span>
          </NavLink>
          <NavLink href="/settings/tokens">
            <span className="l">Tokens</span>
          </NavLink>
        </nav>
      </div>
      <main className="dash-main">
        <MobileBar title="Testnotary" viewer={viewer} />
        {children}
      </main>
    </>
  );
}
