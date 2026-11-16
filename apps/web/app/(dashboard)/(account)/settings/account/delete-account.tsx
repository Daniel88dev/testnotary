"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { deleteMyAccount } from "./actions.ts";

function Confirm() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn amber" disabled={pending}>
      Delete my account
    </button>
  );
}

/** *Delete account* and its one confirmation, in the dashboard's dialog. */
export function DeleteAccount({ login }: { login: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="btn amber" onClick={() => dialog.current?.showModal()}>
        Delete account…
      </button>
      <dialog ref={dialog} className="dlg" aria-labelledby="delete-account-title">
        <form action={deleteMyAccount}>
          <h2 id="delete-account-title">Delete your account?</h2>
          <p className="muted">
            Your laptop tokens and every sandbox token you created are revoked at once, and you are signed out. Runs, attestations and
            mismatches you left stay, under <em>deleted account</em> instead of @{login}. This cannot be undone.
          </p>
          <div className="row-even" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <Confirm />
          </div>
        </form>
      </dialog>
    </>
  );
}
