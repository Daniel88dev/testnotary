"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { repoHref, sectionOf } from "../_lib/sections.ts";

// The dashboard's few client parts: links that know they are current, closing open menus, the
// phone section picker and a copy button. Everything else renders on the server.

/**
 * A link marked `aria-current="page"` when the current path is `href` (`exact`) or below it.
 * `also` lists more path prefixes that count as current (e.g. a repo for the Repositories icon).
 */
export function NavLink({
  href,
  exact = false,
  also = [],
  className,
  title,
  label,
  children,
}: {
  href: string;
  exact?: boolean;
  also?: string[];
  className?: string;
  title?: string;
  label?: string;
  children: ReactNode;
}) {
  const pathname = usePathname().toLowerCase();
  const matches = (target: string) => {
    const lower = target.toLowerCase();
    return exact ? pathname === lower : pathname === lower || pathname.startsWith(`${lower}/`);
  };
  const current = matches(href) || also.some((prefix) => prefix && pathname.startsWith(prefix.toLowerCase()));
  return (
    <Link href={href} className={className} title={title} aria-label={label} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}

/** The rail's two places: Tokens under `/settings`, Repositories everywhere else (home and every repo). */
export function RailLinks({ repos, tokens }: { repos: ReactNode; tokens: ReactNode }) {
  const inSettings = usePathname().startsWith("/settings");
  return (
    <>
      <Link href="/dashboard" title="Repositories" aria-label="Repositories" aria-current={inSettings ? undefined : "page"}>
        {repos}
      </Link>
      <Link href="/settings/tokens" title="Tokens" aria-label="Tokens" aria-current={inSettings ? "page" : undefined}>
        {tokens}
      </Link>
    </>
  );
}

/** Closes any open `details.menu` on a click outside it or on Escape (the menus work without it). */
export function MenuCloser() {
  const pathname = usePathname();
  useEffect(() => {
    const closeAll = (except?: EventTarget | null) => {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
        if (!(except instanceof Node) || !menu.contains(except)) menu.open = false;
      }
    };
    const onClick = (event: MouseEvent) => closeAll(event.target);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    closeAll();
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pathname]);
  return null;
}

/** The phone and tablet section picker: a `<select>` that navigates. */
export function SectionSelect({ options, fullName }: { options: { href: string; label: string }[]; fullName: string }) {
  const router = useRouter();
  const current = repoHref(fullName, sectionOf(usePathname(), fullName));
  return (
    <select className="sel" aria-label="Section" value={current} onChange={(event) => router.push(event.target.value)}>
      {options.map((option) => (
        <option key={option.href} value={option.href}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A "Copy" button for a command line. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn text"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
