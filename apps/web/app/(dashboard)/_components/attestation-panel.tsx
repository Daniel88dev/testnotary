import { DELETED_ACCOUNT, decodeAttestationPayload } from "@testnotary/protocol";
import { AttestationExplainer } from "./attestation-explainer.tsx";
import { Panel } from "./history.tsx";

/**
 * "The attestation": the canonical payload as stored (never rebuilt from columns), each field
 * explained. A deleted account's GitHub id is withheld, as everywhere its records are shown.
 */
export function AttestationPanel({ id, payload, account, title = "The attestation" }: { id: string; payload: string; account: { id: number }; title?: string }) {
  const decoded = decodeAttestationPayload(payload);
  return (
    <Panel id={id} title={title} side="Point at a field to read what it means">
      <div className="panel-b">
        {decoded ? (
          <AttestationExplainer payload={decoded as unknown as Record<string, unknown>} accountWithheld={account.id === DELETED_ACCOUNT.id} />
        ) : (
          <pre className="json">{account.id === DELETED_ACCOUNT.id ? "(withheld: deleted account)" : payload}</pre>
        )}
      </div>
    </Panel>
  );
}
