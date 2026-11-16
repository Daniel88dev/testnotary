import type { ReactNode } from "react";

/**
 * A repo section's title row and body. The sections other than the shell are built by later
 * tickets; until then each shows its empty state here.
 */
export function Section({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="title-row">
        <div>
          <h1>{title}</h1>
          {sub ? <p className="sub">{sub}</p> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="empty-line">{children}</p>;
}
