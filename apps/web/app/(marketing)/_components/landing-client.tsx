"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

// The landing page's moving parts (prototype landing variant C, c.js). Everything here is sample
// data drawn in the browser: nothing is read from the service. Random values are made only after
// mounting, so the server's HTML and the first client render agree.

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function hex(): string {
  return Math.floor(Math.random() * 0xfffffff)
    .toString(16)
    .padStart(7, "0");
}

interface LogRow {
  id: number;
  at: string;
  kind: string;
  tone: "att" | "skip" | "run";
  text: string;
}

const EVENTS: ((tree: string, pr: () => number) => Omit<LogRow, "id" | "at">)[] = [
  (t) => ({ kind: "attest", tone: "att", text: `tree ${t} · unit · passed · shop-agent token` }),
  (t, pr) => ({ kind: "skip", tone: "skip", text: `PR #${pr()} · tree ${t} · attested by @maria-k` }),
  (t) => ({ kind: "attest", tone: "att", text: `tree ${t} · unit · passed · @maria-k laptop` }),
  (_t, pr) => ({ kind: "run", tone: "run", text: `PR #${pr()} · pnpm-lock.yaml is guarded` }),
  (t, pr) => ({ kind: "skip", tone: "skip", text: `PR #${pr()} · tree ${t} · attested by shop-agent token` }),
  (t, pr) => ({ kind: "audit", tone: "run", text: `PR #${pr()} · tree ${t} drawn 1 in 5 · re-running` }),
  (t, pr) => ({ kind: "skip", tone: "skip", text: `PR #${pr()} · tree ${t} · attested by @devon` }),
  (_t, pr) => ({ kind: "run", tone: "run", text: `PR #${pr()} · from a fork` }),
];

/** The event log under the pipeline: a new sample event every 2.2 s, six shown. */
export function EventLog() {
  const [rows, setRows] = useState<LogRow[]>([]);
  // Row ids keep counting across effect re-runs (development mounts effects twice).
  const next = useRef(0);
  useEffect(() => {
    let n = 0;
    setRows([]);
    let pr = 2318;
    let clock = Date.UTC(2026, 10, 15, 9, 12, 4);
    const push = () => {
      clock += 4000 + Math.random() * 9000;
      const event = EVENTS[n % EVENTS.length]!(hex(), () => pr++);
      n++;
      const row = { id: next.current++, at: new Date(clock).toISOString().slice(11, 19), ...event };
      setRows((list) => [...list, row].slice(-6));
    };
    for (let i = 0; i < 5; i++) push();
    if (reducedMotion()) return;
    const timer = setInterval(push, 2200);
    return () => clearInterval(timer);
  }, []);
  return (
    <ol className="log" aria-label="Sample events">
      {rows.map((row) => (
        <li key={row.id}>
          <span>{row.at}</span>
          <span className={`t-${row.tone}`}>{row.kind}</span>
          <span>{row.text}</span>
        </li>
      ))}
    </ol>
  );
}

export interface PayloadField {
  /** The payload key, as the canonical payload spells it. */
  key: string;
  /** The value as drawn in the panel. */
  value: ReactNode;
  title: string;
  text: string;
}

/** The attestation panel: point at, focus or click a field to read what it is for. */
export function AttestationExplainer({ fields }: { fields: PayloadField[] }) {
  const [picked, setPicked] = useState(fields[0]!.key);
  const field = fields.find((f) => f.key === picked) ?? fields[0]!;
  return (
    <div className="anat-grid">
      <pre className="json">
        {"{\n"}
        {fields.map((f, i) => (
          <Fragment key={f.key}>
            {"  "}
            <button
              type="button"
              className={f.key === picked ? "on" : undefined}
              onMouseEnter={() => setPicked(f.key)}
              onFocus={() => setPicked(f.key)}
              onClick={() => setPicked(f.key)}
            >
              <span className="key">&quot;{f.key}&quot;</span>: {f.value}
            </button>
            {i < fields.length - 1 ? ",\n" : "\n"}
          </Fragment>
        ))}
        {"}"}
      </pre>
      <div className="explain" role="status" aria-live="polite">
        <span className="k">{field.key}</span>
        <h3>{field.title}</h3>
        <p>{field.text}</p>
      </div>
    </div>
  );
}

export interface Gate {
  title: string;
  detail: string;
  /** The condition that stops a pull request here. */
  toggle: string;
  verdict: string;
  why: string;
}

/** Six gates in the service's order: flip a condition and the first gate it fails runs the tests. */
export function SixGates({ gates, pass }: { gates: Gate[]; pass: string }) {
  const [pressed, setPressed] = useState<boolean[]>(() => gates.map(() => false));
  const stop = pressed.indexOf(true);
  const verdict = stop < 0 ? undefined : gates[stop]!;
  return (
    <div className="dec-grid">
      <div className="toggles" role="group" aria-label="Conditions">
        {gates.map((gate, i) => (
          <button
            key={gate.toggle}
            type="button"
            aria-pressed={pressed[i]}
            onClick={() => setPressed((list) => list.map((value, k) => (k === i ? !value : value)))}
          >
            {gate.toggle}
          </button>
        ))}
      </div>
      <ol className="gates">
        {gates.map((gate, i) => (
          <li key={gate.title} className={i === stop ? "fail" : stop >= 0 && i > stop ? "skipped" : undefined}>
            <span className="g-n">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <b>{gate.title}</b>
              <span>{gate.detail}</span>
            </div>
            <i className="g-s" />
          </li>
        ))}
      </ol>
      <div className={`verdict${verdict ? " run" : ""}`} role="status" aria-live="polite">
        <b>{verdict ? verdict.verdict : "Skips the test job"}</b>
        <p>{verdict ? `Gate ${stop + 1}: ${verdict.why}` : pass}</p>
      </div>
    </div>
  );
}

/** Sample skips arriving, about one in ten drawn for an audit. */
export function AuditStream({ oneIn }: { oneIn: number }) {
  const [{ ticks, skipped, audited }, setStream] = useState({ ticks: [] as { id: number; audited: boolean }[], skipped: 0, audited: 0 });
  const next = useRef(0);
  useEffect(() => {
    setStream({ ticks: [], skipped: 0, audited: 0 });
    const tick = () => {
      const drawn = Math.random() < 1 / oneIn;
      const id = next.current++;
      setStream((s) => ({
        ticks: [...s.ticks, { id, audited: drawn }].slice(-60),
        skipped: s.skipped + (drawn ? 0 : 1),
        audited: s.audited + (drawn ? 1 : 0),
      }));
    };
    for (let i = 0; i < 40; i++) tick();
    if (reducedMotion()) return;
    const timer = setInterval(tick, 900);
    return () => clearInterval(timer);
  }, [oneIn]);
  return (
    <div className="stream">
      <div className="stream-head">
        <span>skips · acme/shop · sample</span>
        <span>
          <i className="sw s" />
          skipped <i className="sw a" />
          audited
        </span>
      </div>
      <div className="ticks" aria-hidden="true">
        {ticks.map((tick) => (
          <i key={tick.id} className={tick.audited ? "a" : undefined} />
        ))}
      </div>
      <dl className="stats">
        <div>
          <dt>skipped</dt>
          <dd>{skipped}</dd>
        </div>
        <div>
          <dt>audited</dt>
          <dd>{audited}</dd>
        </div>
        <div>
          <dt>mismatches</dt>
          <dd>0</dd>
        </div>
      </dl>
    </div>
  );
}

export interface SetupVariant {
  name: string;
  /** Adds the library: `pnpm add -D testnotary`. */
  add: string;
  /** Runs its binary: `pnpm exec`. */
  exec: string;
  workflow: string;
}

/** The three setup steps and the workflow, for the package manager picked in the tabs. */
export function SetupSteps({ variants, installUrl }: { variants: SetupVariant[]; installUrl: string }) {
  const [picked, setPicked] = useState(variants[0]!.name);
  const pm = variants.find((v) => v.name === picked) ?? variants[0]!;
  return (
    <>
      <div className="pm" role="tablist" aria-label="Package manager">
        {variants.map((v) => (
          <button key={v.name} type="button" role="tab" aria-selected={v.name === picked} onClick={() => setPicked(v.name)}>
            {v.name}
          </button>
        ))}
      </div>
      <ol className="set-steps">
        <li>
          <span className="g-n">01</span>
          <h3>Install the GitHub App</h3>
          <p>On one repo to start. It reads commits and file names, never stores your code.</p>
          <a className="btn btn-line" href={installUrl}>
            Install the GitHub App
          </a>
        </li>
        <li>
          <span className="g-n">02</span>
          <h3>Add the library and the config</h3>
          <p>Name your suites in testnotary.json.</p>
          <pre>
            <span className="m">$</span> {pm.add}
            {"\n"}
            <span className="m">$</span> <span className="x">{pm.exec}</span> testnotary init
          </pre>
        </li>
        <li>
          <span className="g-n">03</span>
          <h3>Run and attest</h3>
          <p>From a laptop or an agent sandbox.</p>
          <pre>
            <span className="m">$</span> <span className="x">{pm.exec}</span> testnotary run unit
          </pre>
        </li>
      </ol>
      <div className="workflow">
        <div className="workflow-head">
          <span>.github/workflows/ci.yml</span>
          <span>the action replaces your test step</span>
        </div>
        <pre>{pm.workflow}</pre>
      </div>
    </>
  );
}
