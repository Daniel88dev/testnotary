import Link from "next/link";
import type { RepoMode } from "@testnotary/core";
import type { ReadableRepo } from "../../../src/server/access.ts";

/** A repo's mode as a chip: enforcing is cyan (tests skip), shadow is an outlined amber chip. */
export function ModeChip({ mode }: { mode: RepoMode }) {
  return mode === "enforce" ? <span className="chip skip">Enforcing</span> : <span className="chip ghost run">Shadow</span>;
}

/** Repos with mode, open mismatches and last verification (prototype `P.home`). */
export function RepoTable({ repos, label }: { repos: ReadableRepo[]; label: string }) {
  return (
    <div className="panel">
      <div className="tbl-wrap">
        <table className="tbl" aria-label={label}>
          <thead>
            <tr>
              <th>Repository</th>
              <th>Mode</th>
              <th className="num">Open mismatches</th>
              <th className="num">Last verification</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={repo.id}>
                <td>
                  <Link className="ink-link" href={`/${repo.fullName}`}>
                    <b style={{ fontWeight: 600 }}>{repo.fullName}</b>
                  </Link>{" "}
                  <span className="tag">{repo.visibility}</span>
                </td>
                <td>
                  <ModeChip mode={repo.mode} />
                </td>
                {/* Mismatches and verifications arrive with their tickets; none exist yet. */}
                <td className="num">0</td>
                <td className="num muted">
                  <span className="faint">None yet</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
