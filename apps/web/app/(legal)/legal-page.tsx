import Link from "next/link";
import type { AnchorHTMLAttributes } from "react";
import { loadLegal, type LegalSlug } from "../../src/legal/legal.ts";

// One legal page from its Markdown, with its effective date. Internal links go through next/link.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `15 November 2026` (UTC). */
export function longDate(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

function Anchor({ href = "", ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return href.startsWith("/") ? <Link href={href} {...props} /> : <a href={href} {...props} />;
}

export async function legalTitle(slug: LegalSlug): Promise<string> {
  return (await loadLegal(slug)).title;
}

export async function LegalPage({ slug }: { slug: LegalSlug }) {
  const { title, effective, Content } = await loadLegal(slug);
  return (
    <main className="legal-article">
      <header>
        <h1>{title}</h1>
        <p className="effective">
          Effective <time dateTime={effective.toISOString().slice(0, 10)}>{longDate(effective)}</time>
        </p>
      </header>
      <div className="prose">
        <Content components={{ a: Anchor }} />
      </div>
    </main>
  );
}
