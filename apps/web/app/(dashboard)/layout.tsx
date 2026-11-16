import type { ReactNode } from "react";
import { MenuCloser } from "./_components/client.tsx";
import { Rail } from "./_components/shell.tsx";
import { getViewer } from "./_lib/viewer.ts";
import "./dashboard.css";

// The dashboard shell ("Rail and repo index"): the icon rail here; each child layout adds its
// column (the account column, or a repo's column) and the canvas, as direct grid children.

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  return (
    <div className="dash">
      <Rail viewer={viewer} />
      {children}
      <MenuCloser />
    </div>
  );
}
