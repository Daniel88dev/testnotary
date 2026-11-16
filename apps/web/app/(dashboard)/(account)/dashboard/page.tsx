import type { Metadata } from "next";
import { appInstallUrl } from "../../../../src/server/config.ts";
import { CopyButton } from "../../_components/client.tsx";
import { RepoTable } from "../../_components/repo-table.tsx";
import { SignIn } from "../../_components/shell.tsx";
import { getReadableRepos, getViewer } from "../../_lib/viewer.ts";

export const metadata: Metadata = { title: "Repositories · Testnotary" };

const LOGIN_COMMAND = "testnotary login";

function SignInLine() {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <span style={{ fontWeight: 500 }}>Sign this machine in</span>
      <div className="code-line" style={{ maxWidth: 420 }}>
        <span>{LOGIN_COMMAND}</span>
        <CopyButton text={LOGIN_COMMAND} />
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Run it with your package manager: <span className="mono">pnpm exec</span>, <span className="mono">npx</span> or{" "}
        <span className="mono">yarn</span>.
      </p>
    </div>
  );
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ signin?: string }> }) {
  const viewer = await getViewer();
  const { signin } = await searchParams;
  const failed = signin === "failed" ? (
    <p className="warn-line" role="alert">
      Signing in with GitHub did not finish. Try again.
    </p>
  ) : null;

  if (!viewer) {
    return (
      <div className="stack" style={{ maxWidth: 560, margin: "72px auto 0" }}>
        {failed}
        <h1>Sign in to see your repositories</h1>
        <p className="muted">Public repos that use Testnotary open without signing in, at their GitHub path: testnotary.dev/owner/repo.</p>
        <SignIn next="/dashboard" large />
      </div>
    );
  }

  const repos = await getReadableRepos();
  const installedByYou = repos.some((repo) => repo.installedByViewer);

  if (installedByYou) {
    return (
      <div className="stack" style={{ gap: 24 }}>
        {failed}
        <div className="title-row">
          <div>
            <h1>Repositories</h1>
            <p className="sub">Every repo you can read that has the Testnotary App installed.</p>
          </div>
          <div className="acts">
            <a className="btn" href={appInstallUrl()}>
              Install on another account
            </a>
          </div>
        </div>
        <RepoTable repos={repos} label="Repositories" />
        <div className="panel">
          <div className="panel-h">
            <h2>Attest from this machine</h2>
            <span className="side">One laptop token per machine, 90 days, renewed on use</span>
          </div>
          <div className="panel-b">
            <SignInLine />
          </div>
        </div>
      </div>
    );
  }

  // Nothing installed on the person's own account: repos others installed come first, then the offer.
  return (
    <div className="stack" style={{ gap: 24, maxWidth: 880 }}>
      {failed}
      <div className="title-row">
        <div>
          <h1>Repositories</h1>
          <p className="sub">
            {repos.length > 0 ? "You haven't installed the Testnotary App yet. These repos you can read have it." : "No repo you can read has Testnotary installed yet."}
          </p>
        </div>
      </div>
      {repos.length > 0 ? <RepoTable repos={repos} label="Installed by others" /> : null}
      <div className="panel">
        <div className="panel-b" style={{ padding: 28 }}>
          <h2 style={{ fontSize: 20, lineHeight: "28px" }}>Install the GitHub App on a repo</h2>
          <p className="muted" style={{ marginTop: 8, maxWidth: "56ch" }}>
            Pick an account and the repos. The App asks for Contents and Metadata read, nothing else. Each repo starts in shadow mode, so no
            test job skips until you switch it to enforce.
          </p>
          <div style={{ marginTop: 20 }}>
            <a className="btn primary lg" href={appInstallUrl()}>
              Install the GitHub App
            </a>
          </div>
          <div style={{ marginTop: 28 }}>
            <SignInLine />
          </div>
          <p style={{ marginTop: 18 }}>
            <a className="link" href="/docs/setup">
              Read the setup guide
            </a>{" "}
            <span className="muted">for testnotary.json, the workflow step and sandbox tokens.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
