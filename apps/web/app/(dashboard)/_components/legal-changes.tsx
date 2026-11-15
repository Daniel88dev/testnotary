import Link from "next/link";
import { now } from "../../../src/server/config.ts";
import { recentLegalChanges } from "../../../src/legal/legal.ts";
import { date } from "../_lib/format.ts";

/**
 * The dashboard's line about a material change to the terms or the privacy policy: shown for 30
 * days from the changed file's effective date (spec Legal, "Changes").
 */
export async function LegalChanges() {
  const at = now();
  const changes = await recentLegalChanges(at);
  if (changes.length === 0) return null;
  return (
    <div className="legal-changes">
      {changes.map((change) => (
        <p key={change.slug} className="warn-line" role="status">
          <span>
            The {change.title} {change.effective.getTime() > at.getTime() ? "changes" : "changed"} on {date(change.effective)}.{" "}
            <Link href={`/${change.slug}`}>Read the {change.title}</Link>
          </span>
        </p>
      ))}
    </div>
  );
}
