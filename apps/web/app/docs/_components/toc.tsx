"use client";

import { useEffect, useState } from "react";
import type { TocEntry } from "../../../src/docs/mdx.ts";

// "On this page": the page's parts and headings, with the one in view marked as you scroll.

export function Toc({ entries }: { entries: TocEntry[] }) {
  const [active, setActive] = useState<string | undefined>();

  useEffect(() => {
    const targets = entries.map((entry) => document.getElementById(entry.id)).filter((el): el is HTMLElement => !!el);
    if (targets.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (seen) => {
        // The innermost entry crossing the reading line wins: a step over the part around it.
        const hits = seen.filter((entry) => entry.isIntersecting).map((entry) => entry.target.id);
        if (hits.length > 0) setActive(hits[hits.length - 1]);
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [entries]);

  if (entries.length === 0) return <aside className="toc" aria-label="On this page" hidden />;

  // Nest each level-3 entry under the level-2 entry before it.
  const tree: { entry: TocEntry; children: TocEntry[] }[] = [];
  for (const entry of entries) {
    const parent = tree[tree.length - 1];
    if (entry.level === 3 && parent) parent.children.push(entry);
    else tree.push({ entry, children: [] });
  }
  const activeParent = tree.find((node) => node.children.some((child) => child.id === active))?.entry.id;

  return (
    <aside className="toc" aria-label="On this page">
      <p className="toc-h">On this page</p>
      <ul>
        {tree.map(({ entry, children }) => (
          <li key={entry.id}>
            <a href={`#${entry.id}`} className={entry.id === active || entry.id === activeParent ? "on" : undefined}>
              {entry.title}
            </a>
            {children.length > 0 && (
              <ul>
                {children.map((child) => (
                  <li key={child.id}>
                    <a href={`#${child.id}`} className={child.id === active ? "on" : undefined}>
                      {child.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
