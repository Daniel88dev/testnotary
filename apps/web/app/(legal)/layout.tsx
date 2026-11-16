import { ACTION_REF } from "@testnotary/core";
import Link from "next/link";
import type { ReactNode } from "react";
import "./legal.css";

// The frame of `/terms` and `/privacy`: the wordmark, the page, and the same links as the docs footer.

const GITHUB_URL = `https://github.com/${ACTION_REF.split("@")[0]}`;

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="legal">
      <header className="legal-top">
        <Link className="logo" href="/" aria-label="Testnotary home">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
          </span>
          testnotary
        </Link>
        <nav aria-label="Site">
          <Link href="/docs">Docs</Link>
          <Link href="/dashboard">Dashboard</Link>
        </nav>
      </header>
      {children}
      <footer className="legal-foot">
        <span>Testnotary is MIT-licensed.</span>
        <nav aria-label="Legal">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/docs/data">What leaves your machine</Link>
          <a href={GITHUB_URL}>GitHub</a>
        </nav>
      </footer>
    </div>
  );
}
