import Link from "next/link";
import type { Viewer } from "../../../src/server/sessions.ts";
import { Avatar } from "./avatar.tsx";
import { RailLinks, SectionSelect } from "./client.tsx";
import { BookIcon, KeyIcon, Mark, ReposIcon } from "./icons.tsx";

// The dashboard shell's server parts: the icon rail, the account menu, sign-in, the phone top bar.

/** The line under every *Sign in with GitHub* (spec Legal). T-817 writes the pages it links. */
export function LegalLine() {
  return (
    <p className="legal-line">
      By signing in you agree to the <a href="/terms">Terms</a> and accept the <a href="/privacy">Privacy policy</a>.
    </p>
  );
}

/**
 * *Sign in with GitHub*: a plain form post (no JavaScript needed) to `/api/session/sign-in`, which
 * sends the browser to GitHub and back to `next`.
 */
export function SignIn({ next, large = false, legal = true }: { next: string; large?: boolean; legal?: boolean }) {
  return (
    <div className="signin">
      <form method="post" action="/api/session/sign-in">
        <input type="hidden" name="next" value={next} />
        <button type="submit" className={`btn primary${large ? " lg" : ""}`}>
          Sign in with GitHub
        </button>
      </form>
      {legal ? <LegalLine /> : null}
    </div>
  );
}

/** The account menu: Tokens, *Delete account*, Terms, Privacy and Sign out (spec Dashboard). */
export function AccountMenuItems({ viewer }: { viewer: Viewer }) {
  return (
    <div className="menu-pop" role="menu">
      <div className="hd">Signed in as @{viewer.account.login}</div>
      <Link href="/settings/tokens" role="menuitem">
        Tokens
      </Link>
      <Link href="/settings/account" role="menuitem">
        Delete account
      </Link>
      <div className="sep" />
      <a href="/terms" role="menuitem">
        Terms
      </a>
      <a href="/privacy" role="menuitem">
        Privacy
      </a>
      <div className="sep" />
      <form method="post" action="/api/session/sign-out">
        <button type="submit" role="menuitem">
          Sign out
        </button>
      </form>
    </div>
  );
}

export function Rail({ viewer }: { viewer: Viewer | undefined }) {
  return (
    <nav className="dash-rail" aria-label="Testnotary">
      <Link className="home" href="/dashboard" aria-label="Testnotary home">
        <Mark />
      </Link>
      <RailLinks repos={<ReposIcon />} tokens={<KeyIcon />} />
      <span className="grow" />
      <a href="/docs" title="Docs" aria-label="Docs">
        <BookIcon />
      </a>
      {viewer ? (
        <details className="menu">
          <summary aria-label="Account menu" title={`@${viewer.account.login}`}>
            <Avatar accountId={viewer.account.id} size={28} />
          </summary>
          <AccountMenuItems viewer={viewer} />
        </details>
      ) : (
        <Link href="/dashboard" title="Sign in" aria-label="Sign in">
          <span className="avatar">?</span>
        </Link>
      )}
    </nav>
  );
}

/**
 * The 52px top bar under 1100px, where the rail and column are hidden: the mark, the place's name,
 * and a section picker (in a repo) or the account menu.
 */
export function MobileBar({
  title,
  repo,
  viewer,
}: {
  title: string;
  /** In a repo: its name and the sections to pick from. */
  repo?: { fullName: string; sections: { href: string; label: string }[] };
  viewer: Viewer | undefined;
}) {
  return (
    <div className="dash-mob">
      <Link className="brand" href="/dashboard">
        <Mark />
        {title}
      </Link>
      {repo ? <SectionSelect options={repo.sections} fullName={repo.fullName} /> : null}
      {!repo && viewer ? (
        <details className="menu acts">
          <summary className="btn" aria-label="Account menu">
            <Avatar accountId={viewer.account.id} size={20} />@{viewer.account.login}
          </summary>
          <AccountMenuItems viewer={viewer} />
        </details>
      ) : null}
    </div>
  );
}
