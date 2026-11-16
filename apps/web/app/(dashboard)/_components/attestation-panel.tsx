import { decodeAttestationPayload } from "@testnotary/protocol";
import { AttestationExplainer } from "./attestation-explainer.tsx";
import { Panel } from "./history.tsx";

/**
 * "The attestation": the canonical payload as stored (never rebuilt from columns), each field
 * explained. The server withholds a deleted account's payload (null): it names the account's
 * GitHub id, so it never reaches the browser.
 */
export function AttestationPanel({ id, payload, title = "The attestation" }: { id: string; payload: string | null; title?: string }) {
  const decoded = payload === null ? undefined : decodeAttestationPayload(payload);
  return (
    <Panel id={id} title={title} side="Point at a field to read what it means">
      <div className="panel-b">
        {payload === null ? (
          <pre className="json" aria-label="Attestation payload">
            (deleted account) The payload is withheld: it names the account&apos;s GitHub id.
          </pre>
        ) : decoded ? (
          <AttestationExplainer payload={decoded as unknown as Record<string, unknown>} />
        ) : (
          <pre className="json">{payload}</pre>
        )}
      </div>
    </Panel>
  );
}
