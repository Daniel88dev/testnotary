import Link from "next/link";
import type { ReactNode } from "react";
import type { SetupState } from "../../../src/server/overview.ts";
import { date } from "../_lib/format.ts";
import { Panel } from "./history.tsx";

// The setup checklist a repo with no verification yet shows instead of the Overview (prototype
// `P.setup`, reworked onto the setup guide's steps at `/docs/setup#<step id>`). The service ticks
// what it can see: the install, `testnotary.json` on the default branch, a run from a laptop, a
// sandbox token, the mode. A first verification is what is missing by definition.

type State = "done" | "missing" | "optional" | "later" | "unknown";

const STATE_LABEL: Record<State, string> = { done: "Done", missing: "Missing", optional: "Optional", later: "Later", unknown: "Unknown" };
const STATE_CHIP: Record<State, string> = { done: "chip skip", missing: "chip run", optional: "chip ghost", later: "chip ghost", unknown: "chip ghost" };

const step = (id: string) => `/docs/setup#${id}`;

interface Item {
  title: string;
  state: State;
  /** Counted in "n of 5 done". */
  required: boolean;
  text: ReactNode;
  guide: { id: string; label: string };
}

function items(setup: SetupState, fullName: string): Item[] {
  const config: State = setup.config === "config" ? "done" : setup.config === "unavailable" ? "unknown" : "missing";
  return [
    {
      title: "App installed",
      state: setup.installedAt ? "done" : "missing",
      required: true,
      text: setup.installedAt ? `On ${fullName} since ${date(setup.installedAt)}, with Contents and Metadata read.` : `Not installed on ${fullName}.`,
      guide: { id: "install-app", label: "Install the App" },
    },
    {
      title: "testnotary.json on the default branch",
      state: config,
      required: true,
      text:
        setup.config === "config" ? (
          <>
            Found, naming the suites. Node and the package manager should be <Link className="link" href={step("pin")}>pinned</Link> too.
          </>
        ) : setup.config === "invalid" ? (
          "Found, but it is not a valid config."
        ) : setup.config === "no_config" ? (
          <>
            Not found. <span className="mono">testnotary init</span> writes it and the workflow step; <Link className="link" href={step("pin")}>pin Node and the package manager</Link> first.
          </>
        ) : (
          "GitHub could not be asked just now."
        ),
      guide: { id: "library", label: "Add the library" },
    },
    {
      title: "A first run from a laptop",
      state: setup.laptopRun ? "done" : "missing",
      required: true,
      text: setup.laptopRun ? "A run reached Testnotary from a signed-in laptop." : (
        <>
          No run yet. Sign in with <span className="mono">testnotary login</span>, then <span className="mono">testnotary run</span> attests a passing suite.
        </>
      ),
      guide: { id: "login", label: "Sign in on your laptop" },
    },
    {
      title: "Sandbox tokens for agents",
      state: setup.sandboxTokens > 0 ? "done" : "optional",
      required: false,
      text: setup.sandboxTokens > 0 ? `${setup.sandboxTokens} created for this repo.` : "For coding agents that run the tests in their own sandbox. Created on Settings.",
      guide: { id: "agents", label: "Give agents a token" },
    },
    {
      title: "A first verification from CI",
      state: "missing",
      required: true,
      text: (
        <>
          No CI job has asked Testnotary yet. <Link className="link" href={step("action")}>Add the action</Link> to the test job,{" "}
          <Link className="link" href={step("merge")}>merge the setup pull request</Link>, then <Link className="link" href={step("first-pr")}>open a pull request</Link>: its check reads
          “would have skipped” or “would have fallen back”.
        </>
      ),
      guide: { id: "first-pr", label: "Open a pull request" },
    },
    {
      title: "Enforce",
      state: setup.mode === "enforce" ? "done" : "later",
      required: true,
      text: setup.mode === "enforce" ? "The repo is enforcing." : "Switch on Settings after the first “would have skipped”.",
      guide: { id: "enforce", label: "Switch to enforce" },
    },
  ];
}

export function SetupChecklist({ setup, fullName }: { setup: SetupState; fullName: string }) {
  const list = items(setup, fullName);
  const required = list.filter((item) => item.required);
  const done = required.filter((item) => item.state === "done").length;
  return (
    <Panel id="setup" title="Set up" side={<span className="num">{`${done} of ${required.length} done`}</span>}>
      <div className="panel-b">
        <div className="progress" style={{ margin: "4px 0 8px" }} aria-hidden="true">
          <i style={{ width: `${(100 * done) / required.length}%` }} />
        </div>
        <ol className="checklist" aria-label="Setup checklist">
          {list.map((item) => (
            <li key={item.title} className={item.state}>
              <span className="box" aria-hidden="true" />
              <div>
                <b style={{ fontWeight: 500 }}>{item.title}</b> <span className={STATE_CHIP[item.state]}>{STATE_LABEL[item.state]}</span>
                <p>{item.text}</p>
              </div>
              {item.guide.id === "first-pr" ? (
                <span />
              ) : (
                <Link className="btn" href={step(item.guide.id)}>
                  {item.guide.label}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
