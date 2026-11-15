"use client";

import type { ReactNode } from "react";
import { Tabs, useChoices } from "./choices.tsx";

// Where each agent vendor keeps a sandbox token, as the setup guide approved it. The choice is
// page-wide: the setup guide and "Agents and sandbox tokens" show the same steps. The vendors' menu
// names are a pre-launch check (spec): keep these words, don't invent others.

const VENDORS: { id: string; name: string; steps: ReactNode[] }[] = [
  {
    id: "claude",
    name: "Claude Code",
    steps: [
      <>
        Open the cloud environment the sessions use and add <b>network access</b> for <code>testnotary.dev</code>.
      </>,
      <>
        Add a <b>network secret</b>: host <code>testnotary.dev</code>, header <code>Authorization</code>, prefix <code>Bearer</code>, value the token.
      </>,
      <>
        Don’t set <code>TESTNOTARY_TOKEN</code>. The session never sees the token; the proxy adds it to requests to <code>testnotary.dev</code>.
      </>,
    ],
  },
  {
    id: "codex",
    name: "Codex",
    steps: [
      <>
        In the environment’s settings, add a secret <code>TESTNOTARY_TOKEN</code> with the token.
      </>,
      <>
        Allow <code>testnotary.dev</code> in internet access, with <code>POST</code> allowed. Codex allows only reads by default.
      </>,
      <>
        Set the variable <code>TESTNOTARY_SANDBOX=1</code>. Codex has no marker Testnotary can detect, and this tells it the run is in a sandbox.
      </>,
    ],
  },
  {
    id: "copilot",
    name: "Copilot coding agent",
    steps: [
      <>
        In the repo’s settings, add an <b>Agents</b> secret <code>TESTNOTARY_TOKEN</code> with the token.
      </>,
      <>
        Add <code>testnotary.dev</code> to the agent’s firewall allowlist.
      </>,
      <>Copilot’s pull requests still wait for someone to approve the workflow run. Once approved, the skip names you as the token’s creator.</>,
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    steps: [
      <>
        Add a runtime secret <code>TESTNOTARY_TOKEN</code> with the token to the background agent’s environment.
      </>,
    ],
  },
  {
    id: "other",
    name: "Other sandboxes",
    steps: [
      <>
        Set <code>TESTNOTARY_TOKEN</code> to the token in the sandbox’s environment.
      </>,
      <>
        Set <code>TESTNOTARY_SANDBOX=1</code> as well, so a laptop token is never used there.
      </>,
      <>
        Let the sandbox reach <code>https://testnotary.dev</code> with <code>GET</code> and <code>POST</code>.
      </>,
    ],
  },
];

export function VendorSteps() {
  const { vendor, setVendor } = useChoices();
  const current = VENDORS.find((v) => v.id === vendor) ?? VENDORS[0]!;
  return (
    <div className="vendor">
      <div className="vendor-head">
        <Tabs label="Agent" options={VENDORS} current={current.id} onSelect={setVendor} />
      </div>
      <ol className="vsteps" aria-label={`${current.name} steps`}>
        {current.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
