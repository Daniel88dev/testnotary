import {
  ACTION_REF,
  ATTESTATION_MAX_AGE_MS,
  BASELINE_FIXED,
  BASELINE_OVERRIDABLE,
  CONFIG_SCHEMA_URL,
  configJsonSchema,
  FALLBACK_REASONS,
  GUARDED_DEFAULTS,
  INITIAL_REPO_SETTINGS,
  REFUSAL_CODES,
  VERIFICATION_RESULTS,
  KILL_SWITCH_VARIABLE,
  LAPTOP_TOKEN_LIFETIME_DAYS,
  PASSED_THROUGH,
  SANDBOX_MARKERS,
  WARNING_CODES,
} from "@testnotary/core";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { DOCS_PAGES } from "../../../src/docs/nav.ts";
import { REASON_HELP, REFUSAL_HELP, WARNING_HELP, type CodeHelp } from "../../../src/docs/reference.ts";
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

/** Text from src/docs/reference.ts: `backticks` are code, [words](/docs/…) a link. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link)
          return (
            <A key={i} href={link[2]}>
              {link[1]}
            </A>
          );
        return part;
      })}
    </>
  );
}

const CODE_TABLES: Record<string, { label: string; codes: readonly string[]; help: Record<string, CodeHelp> }> = {
  refusals: { label: "Refusal codes", codes: REFUSAL_CODES, help: REFUSAL_HELP },
  reasons: { label: "Fallback reason codes", codes: FALLBACK_REASONS, help: REASON_HELP },
  warnings: { label: "Warning codes", codes: WARNING_CODES, help: WARNING_HELP },
};

/**
 * Every code of a list from the core package, in its order, with its cause and fix from
 * src/docs/reference.ts. Each row is the code's anchor (`/docs/refusals#dirty_tree`).
 */
function CodeTable({ of }: { of: string }) {
  const table = CODE_TABLES[of];
  if (!table) throw new Error(`<CodeTable> names an unknown list ${JSON.stringify(of)}`);
  return (
    <div className="table-wrap">
      <table className="codes" aria-label={table.label}>
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Cause</th>
            <th scope="col">Fix</th>
          </tr>
        </thead>
        <tbody>
          {table.codes.map((code) => {
            const help = table.help[code];
            if (!help) throw new Error(`${table.label}: ${code} has no cause and fix in src/docs/reference.ts`);
            return (
              <tr key={code} id={code}>
                <td>
                  <code>{code}</code>
                </td>
                <td>
                  <Rich text={help.cause} />
                </td>
                <td>
                  <Rich text={help.fix} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface SchemaNode {
  type?: string;
  const?: unknown;
  description?: string;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
  required?: string[];
}

interface ConfigKey {
  path: string;
  type: string;
  required: boolean;
  description: string;
}

function schemaType(node: SchemaNode): string {
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.type === "array") return `array of ${node.items?.type ?? "values"}s`;
  if (node.type === "object" && !node.properties && typeof node.additionalProperties === "object") {
    const entry = node.additionalProperties;
    return entry.properties ? "object of named entries" : `object of ${entry.type ?? "value"}s`;
  }
  return node.type ?? "any";
}

/** Every key the schema allows, depth first: `env`, `env.pass`, and `suites.<name>.command` for a map's entries. */
function configKeys(node: SchemaNode, prefix = ""): ConfigKey[] {
  const keys: ConfigKey[] = [];
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    keys.push({ path: `${prefix}${name}`, type: schemaType(child), required: node.required?.includes(name) ?? false, description: child.description ?? "" });
    keys.push(...configKeys(child, `${prefix}${name}.`));
  }
  const entry = node.additionalProperties;
  if (entry && typeof entry === "object" && entry.properties) keys.push(...configKeys(entry, `${prefix}<name>.`));
  return keys;
}

/** The keys of `testnotary.json`, read from the schema the library parses with (and publishes). */
function ConfigKeys() {
  const keys = configKeys(configJsonSchema() as SchemaNode);
  return (
    <div className="table-wrap">
      <table className="codes" aria-label="testnotary.json keys">
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Type</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            if (!key.description) throw new Error(`testnotary.json key ${key.path} has no description in the schema`);
            return (
              <tr key={key.path}>
                <td>
                  <code>{key.path}</code>
                </td>
                <td>{key.type}</td>
                <td>
                  {key.description}
                  {key.required ? " Required." : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The product-default guarded globs, from the core package: the list verification uses. */
function GuardedDefaults() {
  return (
    <ul className="guarded-defaults">
      {GUARDED_DEFAULTS.map((glob) => (
        <li key={glob}>
          <code>{glob}</code>
        </li>
      ))}
    </ul>
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
  CodeTable,
  ConfigKeys,
  GuardedDefaults,
  SandboxMarkers,
  BaselineEnvironment,
  a: A,
  table: Table,
};
