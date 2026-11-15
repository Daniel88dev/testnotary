"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SearchGroup } from "../../../src/docs/content.ts";
import { ChoicesProvider } from "./choices.tsx";

// The docs frame around every page: the sticky top bar with the search box, the page tree (which
// the search filters by title and heading), and on a phone the "Menu" button that opens the tree
// as a full-screen sheet.

export function DocsChrome({ index, githubUrl, children }: { index: SearchGroup[]; githubUrl: string; children: ReactNode }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // A new page closes the sheet.
  useEffect(() => setOpen(false), [pathname]);

  // "/" focuses the search box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => filterTree(index, query), [index, query]);
  const current = pathname?.replace(/\/$/, "");

  const onSearch = (value: string) => {
    setQuery(value);
    // On a phone the tree is hidden in the menu; show it while searching.
    if (value.trim() && window.matchMedia("(max-width: 880px)").matches) setOpen(true);
  };

  return (
    <ChoicesProvider>
      <header className="top">
        <Link className="logo" href="/" aria-label="Testnotary home">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
          </span>
          <span className="logo-text">testnotary</span>
        </Link>
        <span className="docs-tag">Docs</span>
        <label className="search">
          <span className="sr">Search the docs</span>
          <input
            ref={input}
            type="search"
            placeholder="Search the docs"
            autoComplete="off"
            value={query}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onSearch("");
            }}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <nav className="top-links" aria-label="Site">
          <Link href="/docs/setup">Guide</Link>
          <Link href="/docs/config">Reference</Link>
          <Link href="/dashboard">Dashboard</Link>
          <a href={githubUrl}>GitHub</a>
        </nav>
        <button type="button" className="menu btn-line" aria-expanded={open} aria-controls="docs-tree" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Menu"}
        </button>
      </header>
      <div className="frame">
        <nav className={open ? "side open" : "side"} id="docs-tree" aria-label="Docs" onClick={(event) => (event.target as HTMLElement).closest("a") && setOpen(false)}>
          {groups.length === 0 && <p className="no-match">No page or heading matches “{query.trim()}”.</p>}
          {groups.map((group) => (
            <div className="grp" key={group.group}>
              <h2>{group.group}</h2>
              <ul>
                {group.pages.map((page) => (
                  <li key={page.slug}>
                    <Link href={`/docs/${page.slug}`} aria-current={current === `/docs/${page.slug}` ? "page" : undefined}>
                      {page.title}
                    </Link>
                    {page.headings.length > 0 && (
                      <ul className="hits">
                        {page.headings.map((heading) => (
                          <li key={heading.id}>
                            <Link href={`/docs/${page.slug}#${heading.id}`}>{heading.title}</Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        {children}
      </div>
    </ChoicesProvider>
  );
}

/** The tree with only the pages whose title or a heading contains every word of the query; matching headings are listed under their page. */
function filterTree(index: SearchGroup[], query: string): SearchGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return index.map((group) => ({ ...group, pages: group.pages.map((page) => ({ ...page, headings: [] })) }));
  const matches = (text: string) => {
    const lower = text.toLowerCase();
    return words.every((word) => lower.includes(word));
  };
  return index
    .map((group) => ({
      group: group.group,
      pages: group.pages
        .map((page) => ({ ...page, headings: page.headings.filter((heading) => matches(heading.title)), titleHit: matches(page.title) }))
        .filter((page) => page.titleHit || page.headings.length > 0)
        .map(({ titleHit: _titleHit, ...page }) => page),
    }))
    .filter((group) => group.pages.length > 0);
}
