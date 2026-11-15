"use client";

import { useState, type ReactNode } from "react";
import { PACKAGE_MANAGER_NAMES, Tabs, useChoices, type Pm } from "./choices.tsx";

// A code panel: its label, the package-manager tabs when the text depends on the choice, and a
// copy button. Highlighting is two-colour, as in the landing page: strings and values cyan, keys
// bright, comments and prompts muted.

export type Variants = Record<Pm, { text: string; label: string }>;

const PM_OPTIONS = PACKAGE_MANAGER_NAMES.map((id) => ({ id, name: id }));

export function CodePanel({ variants, lang, check }: { variants: Variants; lang: string; check?: boolean }) {
  const { pm, setPm } = useChoices();
  const [copied, setCopied] = useState(false);
  const { text, label } = variants[pm];
  const dependsOnPm = PACKAGE_MANAGER_NAMES.some((other) => variants[other].text !== variants.pnpm.text || variants[other].label !== variants.pnpm.label);

  const copy = () => {
    void navigator.clipboard?.writeText(copyText(text, lang)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <figure className={check ? "code check" : "code"} data-pm-dependent={dependsOnPm || undefined}>
      <figcaption className="code-head">
        <span className="name">{label}</span>
        {dependsOnPm && <Tabs label="Package manager" options={PM_OPTIONS} current={pm} onSelect={setPm} />}
        {!check && (
          <button type="button" className="copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </figcaption>
      <pre>
        <code>{highlight(text, lang)}</code>
      </pre>
    </figure>
  );
}

/** A terminal panel copies its commands only, without the prompt; any other panel copies as is. */
function copyText(text: string, lang: string): string {
  const lines = text.split("\n");
  if (lang === "sh" && lines.some((line) => line.startsWith("$ "))) {
    return lines.filter((line) => line.startsWith("$ ")).map((line) => line.slice(2)).join("\n");
  }
  return text;
}

const STR = "t-str";
const KEY = "t-key";
const COM = "t-com";

function span(className: string, text: string, key: number): ReactNode {
  return (
    <span key={key} className={className}>
      {text}
    </span>
  );
}

function highlight(text: string, lang: string): ReactNode {
  if (lang === "json") return byPattern(text, /("[^"\n]*")(\s*:)?/g, (m, i) => (m[2] ? [span(KEY, m[1]!, i), m[2]] : [span(STR, m[1]!, i)]));
  if (lang === "yaml" || lang === "yml") return lines(text, yamlLine);
  if (lang === "sh") return lines(text, shLine);
  if (lang === "md") return lines(text, (line, i) => (line.startsWith("#") ? span(KEY, line, i) : line));
  return text;
}

function lines(text: string, each: (line: string, i: number) => ReactNode): ReactNode {
  const out: ReactNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push("\n");
    out.push(<span key={i}>{each(line, i)}</span>);
  });
  return out;
}

function byPattern(text: string, pattern: RegExp, render: (match: RegExpExecArray, key: number) => ReactNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    out.push(text.slice(last, match.index));
    out.push(...render(match, key++));
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function yamlLine(line: string): ReactNode {
  let body = line;
  let comment: ReactNode = null;
  const hash = line.search(/(^|\s)#/);
  if (hash >= 0) {
    comment = span(COM, line.slice(hash), 0);
    body = line.slice(0, hash);
  }
  const key = /^(\s*-?\s*)([\w$-]+)(:)(.*)$/.exec(body);
  const value = (rest: string) => byPattern(rest, /(\$\{\{[^}]*\}\}|"[^"]*"|'[^']*')/g, (m, i) => [span(STR, m[1]!, i + 10)]);
  return (
    <>
      {key ? (
        <>
          {key[1]}
          {span(KEY, key[2]!, 1)}
          {key[3]}
          {value(key[4]!)}
        </>
      ) : (
        value(body)
      )}
      {comment}
    </>
  );
}

function shLine(line: string): ReactNode {
  if (line.startsWith("$ ")) {
    return (
      <>
        {span(COM, "$", 0)} {line.slice(2)}
      </>
    );
  }
  if (line.startsWith("testnotary:") || line.startsWith("#")) return span(COM, line, 0);
  if (line.startsWith("outcome=")) {
    return byPattern(line, /(\w+=)(\S*)/g, (m, i) => [span(COM, m[1]!, i * 2), span(STR, m[2]!, i * 2 + 1)]);
  }
  return line;
}
