import {
  ACTION_REF,
  ATTESTATION_MAX_AGE_MS,
  BASELINE_FIXED,
  BASELINE_OVERRIDABLE,
  CONFIG_SCHEMA_URL,
  FALLBACK_REASONS,
  INITIAL_REPO_SETTINGS,
  REFUSAL_CODES,
  VERIFICATION_RESULTS,
  KILL_SWITCH_VARIABLE,
  LAPTOP_TOKEN_LIFETIME_DAYS,
  PASSED_THROUGH,
  SANDBOX_MARKERS,
} from "@testnotary/core";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { DOCS_PAGES } from "../../../src/docs/nav.ts";
import { PMS, checkLabel, snippet, substitute } from "../../../src/docs/snippets.ts";
import { CodePanel, type Variants } from "./code-panel.tsx";
import { VendorSteps } from "./vendors.tsx";

// The components MDX pages use. Fenced code blocks arrive as <Code text lang file> (src/docs/mdx.ts).

/**
 * A code panel. `snippet` names a panel built in src/docs/snippets.ts; otherwise `text` is the
 * block's text, with {{tokens}} filled per package manager. `lang="check"` draws a pull request's
 * check line; its info string is `<suite> <event>`.
 */
function Code({ text = "", lang = "", file, snippet: name }: { text?: string; lang?: string; file?: string; snippet?: string }) {
  if (lang === "check") {
    const [suite = "unit", event = "pull_request"] = (file ?? "").split(/\s+/).filter(Boolean);
    const label = checkLabel(suite, event);
    const same = { text, label };
    return <CodePanel variants={{ pnpm: same, npm: same, yarn: same }} lang={lang} check />;
  }
  const variants = Object.fromEntries(
    PMS.map((pm) => [pm, { text: name ? snippet(name, pm) : substitute(text, pm), label: substitute(file ?? lang, pm) }]),
  ) as Variants;
  return <CodePanel variants={variants} lang={lang} />;
}

/** One part of a guide: a heading, a line under it, and its numbered steps. */
function Part({ id, title, lede, children }: { id: string; title: string; lede?: string; children: ReactNode }) {
  return (
    <section className="part" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {lede && <p className="part-lede">{lede}</p>}
      <ol className="steps">{children}</ol>
    </section>
  );
}

/** A numbered step; the number (set by src/docs/mdx.ts) continues across parts. */
function Step({ id, title, who, where, number, children }: { id: string; title: string; who: string; where: string; number?: string; children: ReactNode }) {
  return (
    <li className="step" id={id}>
      <span className="num">{number}</span>
      <h3>{title}</h3>
      <p className="who">
        {who} · {where}
      </p>
      <div className="flow">{children}</div>
    </li>
  );
}

function Before({ children }: { children: ReactNode }) {
  return (
    <section className="before" aria-labelledby="before-h">
      <h2 id="before-h">Before you start</h2>
      {children}
    </section>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return <div className="lede">{children}</div>;
}

function Result({ children }: { children: ReactNode }) {
  return (
    <div className="result">
      <b>Result</b>
      <span>{children}</span>
    </div>
  );
}

function Aside({ children }: { children: ReactNode }) {
  return <div className="aside">{children}</div>;
}

/** An amber-ruled note for a limit or a warning the reader must not miss. */
function Limit({ children }: { children: ReactNode }) {
  return <div className="limit">{children}</div>;
}

/** "Where to go next": cards for the named pages, each with the line on what it holds. */
function Next({ pages }: { pages: string }) {
  const slugs = pages.split(/\s+/).filter(Boolean);
  return (
    <section className="next" aria-labelledby="next-h">
      <h2 id="next-h">Where to go next</h2>
      <ul>
        {slugs.map((slug) => {
          const page = DOCS_PAGES.find((p) => p.slug === slug);
          if (!page) throw new Error(`<Next> names an unknown docs page ${JSON.stringify(slug)}`);
          return (
            <li key={slug}>
              <Link href={`/docs/${slug}`}>{page.title}</Link>
              <span>{page.holds}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function A({ href = "", ...props }: ComponentProps<"a">) {
  if (href.startsWith("/") && !href.startsWith("//")) return <Link href={href} {...props} />;
  return <a href={href} {...props} />;
}

function Table(props: ComponentProps<"table">) {
  return (
    <div className="table-wrap">
      <table className="codes" {...props} />
    </div>
  );
}

/** A product default, read from the core package so the docs follow the product. */
const FACTS: Record<string, () => string> = {
  auditRate: () => `1 in ${INITIAL_REPO_SETTINGS.auditOneIn}`,
  sandboxAuditRate: () => `1 in ${INITIAL_REPO_SETTINGS.sandboxAuditOneIn}`,
  attestationAge: () => `${ATTESTATION_MAX_AGE_MS / 3_600_000} hours`,
  laptopTokenLifetime: () => `${LAPTOP_TOKEN_LIFETIME_DAYS} days`,
  killSwitch: () => KILL_SWITCH_VARIABLE,
  actionRef: () => ACTION_REF,
  schemaUrl: () => CONFIG_SCHEMA_URL,
};

function Fact({ name, code }: { name: string; code?: boolean }) {
  const fact = FACTS[name];
  if (!fact) throw new Error(`<Fact> names an unknown fact ${JSON.stringify(name)}`);
  return code ? <code>{fact()}</code> : <>{fact()}</>;
}

const CODE_LISTS: Record<string, readonly string[]> = {
  results: VERIFICATION_RESULTS,
  refusals: REFUSAL_CODES,
  reasons: FALLBACK_REASONS,
};

/** A code list from the core package, inline: `a`, `b` or `c`. */
function CodeList({ of }: { of: string }) {
  const list = CODE_LISTS[of];
  if (!list) throw new Error(`<CodeList> names an unknown list ${JSON.stringify(of)}`);
  return (
    <>
      {list.map((code, i) => (
        <span key={code}>
          {i === 0 ? "" : i === list.length - 1 ? " or " : ", "}
          <code>{code}</code>
        </span>
      ))}
    </>
  );
}

/** The sandbox markers the library ships. */
function SandboxMarkers() {
  return (
    <ul>
      {SANDBOX_MARKERS.map((marker) => (
        <li key={marker.name}>{marker.condition.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}</li>
      ))}
    </ul>
  );
}

/** The stripped environment: what the tests see before `env.pass` and `env.set`. */
function BaselineEnvironment() {
  return (
    <div className="table-wrap">
      <table className="codes">
        <thead>
          <tr>
            <th scope="col">Variable</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {PASSED_THROUGH.map((name) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td>From your shell, when it is set there.</td>
            </tr>
          ))}
          <tr>
            <td>
              <code>HOME</code>
            </td>
            <td>A fresh, empty directory for this run, deleted afterwards.</td>
          </tr>
          {Object.entries(BASELINE_FIXED).map(([name, value]) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td>
                <code>{value}</code>
                {BASELINE_OVERRIDABLE.includes(name) ? ", unless env.set gives another value (the run records the override)." : "."}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const MDX_COMPONENTS = {
  Code,
  Part,
  Step,
  Before,
  Lede,
  Result,
  Aside,
  Limit,
  Next,
  VendorSteps,
  Fact,
  CodeList,
  SandboxMarkers,
  BaselineEnvironment,
  a: A,
  table: Table,
};
