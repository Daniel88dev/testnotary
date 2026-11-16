"use client";

import { useActionState, useEffect, useRef } from "react";
import { changeModeAction, changeRatesAction, explainMismatchAction, type FormState } from "../_lib/settings-actions.ts";
import { CAUSE_LABELS } from "../_lib/words.ts";

// The admin's controls in Settings and on Mismatches. The pages render them only for an admin;
// every action checks again with GitHub.

/**
 * The enforce toggle. Switching on asks first when there is something to warn about (fewer than
 * 20 agreeing comparisons), then switches: a warning, never a block. An open mismatch does block
 * it, and the page says so beside the switch. Switching off needs no confirmation.
 */
export function ModeSwitch({ repository, mode, warnings, blocked }: { repository: string; mode: "shadow" | "enforce"; warnings: string[]; blocked: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(changeModeAction, {});
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const enforcing = mode === "enforce";
  useEffect(() => {
    if (state.done) dialog.current?.close();
  }, [state.done]);
  return (
    <>
      <form ref={form} action={action}>
        <input type="hidden" name="repository" value={repository} />
        <input type="hidden" name="mode" value={enforcing ? "shadow" : "enforce"} />
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={enforcing}
          aria-label="Enforce"
          disabled={pending || (!enforcing && blocked)}
          onClick={() => (!enforcing && warnings.length > 0 ? dialog.current?.showModal() : form.current?.requestSubmit())}
        />
      </form>
      {state.problem ? (
        <p className="warn-line" role="alert">
          {state.problem}
        </p>
      ) : null}
      <dialog ref={dialog} className="dlg" aria-labelledby="enforce-title">
        <form action={action}>
          <input type="hidden" name="repository" value={repository} />
          <input type="hidden" name="mode" value="enforce" />
          <h2 id="enforce-title">Switch to enforce?</h2>
          {warnings.map((warning) => (
            <p key={warning} className="warn-line">
              {warning}
            </p>
          ))}
          <p className="muted">
            In enforce mode a test job skips when an attestation matches its tree, and audits re-run a random share of those skips in CI. A mismatch
            sends the repo back to shadow mode at once.
          </p>
          <div className="row-even" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={pending}>
              Switch to enforce
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/** The two audit rates. Only rates at or above the defaults are offered; the service refuses anything else. */
export function RatesForm({
  repository,
  auditOneIn,
  sandboxAuditOneIn,
  sandboxFollowsRepo,
  laptopChoices,
  sandboxChoices,
}: {
  repository: string;
  auditOneIn: number;
  sandboxAuditOneIn: number;
  sandboxFollowsRepo: boolean;
  laptopChoices: number[];
  sandboxChoices: number[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(changeRatesAction, {});
  const oneIn = (n: number) => (n === 1 ? "Every attested job (1 in 1)" : `1 in ${n}`);
  return (
    <form action={action} key={`${auditOneIn} ${sandboxAuditOneIn}`} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <input type="hidden" name="repository" value={repository} />
      <div className="field">
        <label htmlFor="audit-rate">Laptop tokens</label>
        <select id="audit-rate" className="sel" name="auditOneIn" defaultValue={auditOneIn}>
          {laptopChoices.map((n) => (
            <option key={n} value={n}>
              {oneIn(n)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="sandbox-rate">Sandbox tokens</label>
        <select id="sandbox-rate" className="sel" name="sandboxAuditOneIn" defaultValue={sandboxFollowsRepo ? "default" : sandboxAuditOneIn}>
          <option value="default">Twice the laptop rate</option>
          {sandboxChoices.map((n) => (
            <option key={n} value={n}>
              {oneIn(n)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 12, alignItems: "center" }}>
        <button type="submit" className="btn" disabled={pending}>
          Save rates
        </button>
        {state.problem ? (
          <p className="warn-line" role="alert">
            {state.problem}
          </p>
        ) : state.done ? (
          <span className="muted" role="status">
            Saved.
          </span>
        ) : null}
      </div>
    </form>
  );
}

const CAUSES = [
  { value: "flaky_test", label: CAUSE_LABELS.flaky_test, hint: "The test fails now and then, whatever the code." },
  { value: "environment_difference", label: CAUSE_LABELS.environment_difference, hint: "The laptop or sandbox and CI's runner differ in a way the tests notice." },
  { value: "false_attestation", label: CAUSE_LABELS.false_attestation, hint: "The attested run should not have passed." },
  { value: "other", label: CAUSE_LABELS.other, hint: "Say what happened in the note." },
];

/** *Explain mismatch* and its dialog: one of four causes and a note, recorded once. */
export function ExplainMismatch({ repository, mismatch, commit }: { repository: string; mismatch: string; commit: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(explainMismatchAction, {});
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (state.done) dialog.current?.close();
  }, [state.done]);
  const title = `explain-${mismatch}`;
  return (
    <>
      <button type="button" className="btn amber" onClick={() => dialog.current?.showModal()}>
        Explain mismatch
      </button>
      <dialog ref={dialog} className="dlg" aria-labelledby={title}>
        <form action={action}>
          <input type="hidden" name="repository" value={repository} />
          <input type="hidden" name="mismatch" value={mismatch} />
          <h2 id={title}>Explain the mismatch on {commit}</h2>
          <fieldset className="radios" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ marginBottom: 6 }}>
              Cause
            </legend>
            {CAUSES.map((cause) => (
              <label key={cause.value}>
                <input type="radio" name="cause" value={cause.value} required />
                <span>
                  {cause.label} <span className="faint">{cause.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor={`${title}-note`}>Note</label>
            <textarea id={`${title}-note`} className="input" name="note" rows={3} maxLength={2000} />
          </div>
          <p className="muted">
            The explanation is part of the record, and it stays. It does not switch enforce back on: an admin does that in Settings once no mismatch is
            open.
          </p>
          {state.problem ? (
            <p className="warn-line" role="alert">
              {state.problem}
            </p>
          ) : null}
          <div className="row-even" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="btn amber" disabled={pending}>
              Record explanation
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
