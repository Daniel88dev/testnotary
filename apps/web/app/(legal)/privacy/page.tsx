import type { Metadata } from "next";
import { LegalPage, legalTitle } from "../legal-page.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${await legalTitle("privacy")} · Testnotary` };
}

export default function PrivacyPage() {
  return <LegalPage slug="privacy" />;
}
