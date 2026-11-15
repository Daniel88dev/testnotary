"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// Page-wide choices: the package manager (remembered in this browser) and the agent vendor
// (for the page only). Every code panel and vendor block follows them.

export const PACKAGE_MANAGER_NAMES = ["pnpm", "npm", "yarn"] as const;
export type Pm = (typeof PACKAGE_MANAGER_NAMES)[number];

const PM_KEY = "tn-pm";

interface Choices {
  pm: Pm;
  setPm(pm: Pm): void;
  vendor: string;
  setVendor(vendor: string): void;
}

const ChoicesContext = createContext<Choices>({ pm: "pnpm", setPm() {}, vendor: "claude", setVendor() {} });

export function ChoicesProvider({ children }: { children: ReactNode }) {
  // The server renders pnpm; the remembered choice replaces it once the page is in the browser.
  const [pm, setPmState] = useState<Pm>("pnpm");
  const [vendor, setVendor] = useState("claude");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(PM_KEY);
    } catch {
      // Storage can be off; pnpm stays.
    }
    if (stored && (PACKAGE_MANAGER_NAMES as readonly string[]).includes(stored)) setPmState(stored as Pm);
  }, []);

  const setPm = useCallback((next: Pm) => {
    setPmState(next);
    try {
      window.localStorage.setItem(PM_KEY, next);
    } catch {
      // Not remembered, still switched.
    }
  }, []);

  return <ChoicesContext.Provider value={{ pm, setPm, vendor, setVendor }}>{children}</ChoicesContext.Provider>;
}

export function useChoices(): Choices {
  return useContext(ChoicesContext);
}

/** A segmented control of tabs. */
export function Tabs<T extends string>({ label, options, current, onSelect }: { label: string; options: readonly { id: T; name: string }[]; current: T; onSelect(id: T): void }) {
  return (
    <span className="tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="tab" aria-selected={option.id === current} onClick={() => onSelect(option.id)}>
          {option.name}
        </button>
      ))}
    </span>
  );
}
