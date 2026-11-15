import type { Metadata } from "next";
import { LegalPage, legalTitle } from "../legal-page.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${await legalTitle("terms")} · Testnotary` };
}

export default function TermsPage() {
  return <LegalPage slug="terms" />;
}
