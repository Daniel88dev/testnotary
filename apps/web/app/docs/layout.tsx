import { ACTION_REF } from "@testnotary/core";
import Link from "next/link";
import type { ReactNode } from "react";
import { searchIndex } from "../../src/docs/content.ts";
import { DocsChrome } from "./_components/chrome.tsx";
import "./docs.css";

// The docs: a sticky top bar, the page tree, the page, "On this page", and a footer with the
// legal pages. Every page under /docs shares it.

const GITHUB_URL = `https://github.com/${ACTION_REF.split("@")[0]}`;

export default async function DocsLayout({ children }: { children: ReactNode }) {
  const index = await searchIndex();
  return (
    <div className="docs">
      <DocsChrome index={index} githubUrl={GITHUB_URL}>
        {children}
      </DocsChrome>
      <footer className="docs-foot">
        <span>Testnotary is MIT-licensed.</span>
        <nav aria-label="Legal">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/docs/licensing">Licensing</Link>
          <a href={GITHUB_URL}>GitHub</a>
        </nav>
      </footer>
    </div>
  );
}
