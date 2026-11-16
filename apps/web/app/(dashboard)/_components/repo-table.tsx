import Link from "next/link";
import type { RepoMode } from "@testnotary/core";
import { database } from "../../../src/db/client.ts";
import type { ReadableRepo } from "../../../src/server/access.ts";
import { now } from "../../../src/server/config.ts";
import { lastVerifications } from "../../../src/server/history.ts";
import { openMismatchCounts } from "../../../src/server/settings.ts";
import { rel } from "../_lib/format.ts";

/** A repo's mode as a chip: enforcing is cyan (tests skip), shadow is an outlined amber chip. */
export function ModeChip({ mode }: { mode: RepoMode }) {
  return mode === "enforce" ? <span className="chip skip">Enforcing</span> : <span className="chip ghost run">Shadow</span>;
}

/** Repos with mode, open mismatches and last verification (prototype `P.home`). */
export async function RepoTable({ repos, label }: { repos: ReadableRepo[]; label: string }) {
  const ids = repos.map((repo) => repo.id);
  const [last, open] = await Promise.all([lastVerifications(database(), ids), openMismatchCounts(database(), ids)]);
  const at = now();
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
                <td className="num">
                  {open.has(repo.id) ? (
                    <span className="count mm" aria-label={`${open.get(repo.id)} open`}>
                      {open.get(repo.id)}
                    </span>
                  ) : (
                    "0"
                  )}
                </td>
                <td className="num muted">{last.has(repo.id) ? rel(last.get(repo.id)!, at) : <span className="faint">None yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
