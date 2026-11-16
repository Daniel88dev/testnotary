"use client";

import { useState, type ReactNode } from "react";

// The attestation's canonical payload, laid out with each field a button: point at one (hover,
// focus or click) to read what it means (prototype `attestationJson` + app.js's field explainer).
// The explanations are keyed by the payload's real field names (protocol attestation.ts, v1).

const FIELDS: Record<string, [string, string]> = {
  format: ["Format", "The payload's version. A new field makes a new format; a v1 payload never changes shape."],
  repository: ["Repository", "GitHub's numeric id of the repo, which survives renames and transfers."],
  suite: ["Suite", "The named test command from testnotary.json. Each suite has its own attestations, so one can skip while another runs."],
  command: ["Command", "The argv from testnotary.json on the base branch. Verification checks it again against the base CI merges into."],
  tree: ["Tree", "The git tree the tests ran on. CI skips only when the tree it builds equals this one, whatever the commit."],
  commit: ["Commit", "The commit the run had checked out, kept beside the tree for reference. A merge commit CI builds can match by tree."],
  outcome: ["Outcome", "Only a passed run yields an attestation. Failed and refused runs are recorded too."],
  attester: ["Attester", "The GitHub account (for a sandbox token, the person who created it) and the token the run uploaded with."],
  endedAt: ["Ended", "When the run ended. An attestation counts for 24 hours from here, or from when the service received it if that was earlier."],
};

export function AttestationExplainer({ payload }: { payload: Record<string, unknown> }) {
  const [field, setField] = useState("tree");
  const key = (name: string) => (
    <button
      type="button"
      className={field === name ? "on" : undefined}
      onMouseEnter={() => setField(name)}
      onFocus={() => setField(name)}
      onClick={() => setField(name)}
      aria-pressed={field === name}
    >
      &quot;{name}&quot;
    </button>
  );
  const lines: ReactNode[] = [];
  const entries = Object.entries(payload);
  entries.forEach(([name, value], index) => {
    const comma = index < entries.length - 1 ? "," : "";
    lines.push(
      <span key={name}>
        {"  "}
        {key(name)}: <Value value={value} />
        {comma}
        {"\n"}
      </span>,
    );
  });
  const [title, text] = FIELDS[field] ?? [field, ""];
  return (
    <div className="json-grid">
      <pre className="json" aria-label="Attestation payload">
        {"{\n"}
        {lines}
        {"}"}
      </pre>
      <div className="explain" aria-live="polite">
        <span className="k">{field}</span>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Value({ value }: { value: unknown }): ReactNode {
  if (typeof value === "string") return <span className="s">{JSON.stringify(value)}</span>;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return <span className="n2">{String(value)}</span>;
  if (Array.isArray(value)) {
    return (
      <>
        [
        {value.map((item, index) => (
          <span key={index}>
            {index > 0 ? ", " : ""}
            <Value value={item} />
          </span>
        ))}
        ]
      </>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      <>
        {"{ "}
        {entries.map(([name, item], index) => (
          <span key={name}>
            {index > 0 ? ", " : ""}
            {JSON.stringify(name)}: <Value value={item} />
          </span>
        ))}
        {" }"}
      </>
    );
  }
  return null;
}
