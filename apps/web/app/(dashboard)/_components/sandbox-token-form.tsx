"use client";

import { useActionState } from "react";
import { createSandboxToken, type CreateSandboxTokenState } from "../_lib/sandbox-token-actions.ts";
import { CopyButton } from "./client.tsx";

// Creating a sandbox token: a name, the repo (fixed in a repo's Settings, chosen on the Tokens
// page) and how long it lasts. After a creation the value is shown here once; it lives only in
// this component's state, so a reload or another page never shows it again.

const LIFETIMES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
  { days: 365, label: "1 year" },
];

/**
 * `repository`: the one repo (a repo's Settings); `repositories`: the repos to choose from (the
 * Tokens page: those the person can write to).
 */
export function SandboxTokenForm(props: { repository: string } | { repositories: string[] }) {
  const [state, action, pending] = useActionState<CreateSandboxTokenState, FormData>(createSandboxToken, { kind: "idle" });
  const fixed = "repository" in props ? props.repository : undefined;
  const repositories = "repositories" in props ? props.repositories : [];
  return (
    <div className="stack" style={{ gap: 14 }}>
      {state.kind === "created" ? (
        <div className="stack" style={{ gap: 8 }} role="status">
          <p>
            Sandbox token <b style={{ fontWeight: 500 }}>{state.name}</b> for <span className="mono">{state.repository}</span>. Copy it now: it is shown only this
            once.
          </p>
          <div className="code-line">
            <code aria-label="New sandbox token value" style={{ overflowWrap: "anywhere" }}>
              {state.value}
            </code>
            <CopyButton text={state.value} />
          </div>
          <p className="muted">
            Store it as the agent&apos;s <span className="mono">TESTNOTARY_TOKEN</span> secret, or as a network secret on the service&apos;s host. Setup for each
            agent:{" "}
            <a className="link" href="/docs/agents">
              Agents and sandbox tokens
            </a>
            .
          </p>
        </div>
      ) : null}
      <details className="disclose">
        <summary className="btn">Create sandbox token</summary>
        <form action={action} className="stack" style={{ gap: 12, marginTop: 14 }}>
          {fixed ? (
            <input type="hidden" name="repository" value={fixed} />
          ) : (
            <div className="field">
              <label htmlFor="sandbox-repository">Repository</label>
              <select id="sandbox-repository" className="sel" name="repository" required>
                {repositories.map((repository) => (
                  <option key={repository} value={repository}>
                    {repository}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="sandbox-name">Name</label>
            <input id="sandbox-name" className="input" name="name" required maxLength={100} placeholder="codex-cloud" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="sandbox-days">Expires after</label>
            <select id="sandbox-days" className="sel" name="days" defaultValue="90">
              {LIFETIMES.map((lifetime) => (
                <option key={lifetime.days} value={lifetime.days}>
                  {lifetime.label}
                </option>
              ))}
            </select>
          </div>
          <p className="muted">One repo, upload only, never renewed. Its attestations name the token and you, never the agent.</p>
          {state.kind === "error" ? <p className="warn-line">{state.message}</p> : null}
          <div>
            <button type="submit" className="btn primary" disabled={pending}>
              Create token
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
