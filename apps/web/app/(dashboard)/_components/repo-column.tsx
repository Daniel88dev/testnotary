import Link from "next/link";
import type { ReadableRepo, RepoAccess } from "../../../src/server/access.ts";
import type { Viewer } from "../../../src/server/sessions.ts";
import { repoHref, SECTIONS } from "../_lib/sections.ts";
import { NavLink } from "./client.tsx";
import { ChevronIcon } from "./icons.tsx";
import { ModeChip } from "./repo-table.tsx";

/** The sections this person sees: Settings is hidden when signed out. */
export function visibleSections(fullName: string, viewer: Viewer | undefined) {
  return SECTIONS.filter((section) => viewer || !section.signedInOnly).map((section) => ({
    path: section.path,
    href: repoHref(fullName, section.path),
    label: section.label,
  }));
}

/**
 * The repo column (prototype `renderB`): the switcher, the mode, the six sections with the open
 * mismatches counted in amber, the suites with their last result, and the settings in effect.
 */
export function RepoColumn({
  access,
  viewer,
  repos,
  suites,
}: {
  access: RepoAccess;
  viewer: Viewer | undefined;
  repos: ReadableRepo[];
  /** Each suite's latest verification: cyan when it skipped or would have, amber when the tests ran. */
  suites: { name: string; lastResult: "skip" | "run"; at: string }[];
}) {
  const { repo } = access;
  // Open mismatches arrive with T-828 (an explanation closes one); until then none are counted.
  const openMismatches = 0;
  return (
    <div className="dash-nav">
      <details className="menu">
        <summary className="switch-repo" aria-label={`Repository ${repo.fullName}, switch`}>
          <span>{repo.fullName}</span>
          <ChevronIcon />
        </summary>
        <div className="menu-pop">
          {viewer ? (
            <>
              <div className="hd">Your repositories</div>
              {repos.map((other) => (
                <Link key={other.id} href={repoHref(other.fullName)}>
                  <span>{other.fullName}</span>
                  <span className="faint">{other.mode === "enforce" ? "enforcing" : "shadow"}</span>
                </Link>
              ))}
              <div className="sep" />
              <Link href="/dashboard">All repositories</Link>
            </>
          ) : (
            <Link href="/dashboard">Sign in to see your repositories</Link>
          )}
        </div>
      </details>
      <div className="modeline">
        <ModeChip mode={repo.mode} />
        <span>{repo.visibility}</span>
      </div>

      <div className="grp">Repository</div>
      <nav aria-label="Repository">
        {visibleSections(repo.fullName, viewer).map((section) => (
          <NavLink
            key={section.path}
            href={section.href}
            exact={section.path === ""}
            also={
              section.path === "verifications" ? [repoHref(repo.fullName, "commit/")] : section.path === "runs" ? [repoHref(repo.fullName, "runs/")] : []
            }
          >
            <span className="l">{section.label}</span>
            {section.path === "mismatches" && openMismatches > 0 ? (
              <span className="count mm" aria-label={`${openMismatches} open`}>
                {openMismatches}
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      <div className="grp">Suites</div>
      {suites.length === 0 ? <p className="note">No verifications yet.</p> : null}
      {suites.map((suite) => (
        <Link key={suite.name} className="suite" href={`${repoHref(repo.fullName, "verifications")}?suite=${encodeURIComponent(suite.name)}`}>
          <span className={`dot ${suite.lastResult}`} />
          <b>{suite.name}</b>
          <span className="num">{suite.at}</span>
        </Link>
      ))}

      <div className="grp">Settings in effect</div>
      <p className="note">
        Audits 1 in {repo.auditOneIn}, sandbox 1 in {repo.sandboxAuditOneIn}.
      </p>
    </div>
  );
}
