import { readFile } from "node:fs/promises";
import path from "node:path";
import { compile, run } from "@mdx-js/mdx";
import GithubSlugger from "github-slugger";
import type { ComponentType } from "react";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";
import { serviceConfig } from "../server/config.ts";

// The terms and the privacy policy: Markdown files with a small front matter (title, effective
// date, version), in `content/legal` unless the config names another directory. Git history is
// their change log. A version above 1 is a material change: the dashboard shows a line about it for
// 30 days from its effective date.

export const LEGAL_SLUGS = ["terms", "privacy"] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/** How long the dashboard shows a material change, counted from its effective date. */
export const CHANGE_NOTICE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface LegalDocument {
  slug: LegalSlug;
  title: string;
  /** The effective date, at midnight UTC. */
  effective: Date;
  /** 1 for the first text; raised for each material change. */
  version: number;
  Content: ComponentType<{ components?: Record<string, unknown> }>;
}

export function legalDir(): string {
  return serviceConfig().legalDir ?? path.join(process.cwd(), "content", "legal");
}

/** Splits `---` front matter (`key: value` lines, `#` comments) from the Markdown body. */
function frontMatter(source: string): { fields: Map<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error("a legal page needs front matter with title, effective and version");
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!field) throw new Error(`front matter: cannot read "${line}"`);
    fields.set(field[1]!, field[2]!.trim());
  }
  return { fields, body: source.slice(match[0].length) };
}

interface Node {
  type: string;
  depth?: number;
  value?: string;
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
}

/** h2 and h3 get GitHub-style ids, so sections can be linked (`/privacy#cookies`). */
function remarkHeadingIds() {
  return (tree: Node) => {
    const slugger = new GithubSlugger();
    const text = (node: Node): string => node.value ?? (node.children ?? []).map(text).join("");
    const visit = (node: Node) => {
      if (node.type === "heading" && (node.depth === 2 || node.depth === 3)) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slugger.slug(text(node)) } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const compiled = new Map<string, Promise<LegalDocument["Content"]>>();

function compileMarkdown(body: string): Promise<LegalDocument["Content"]> {
  let content = compiled.get(body);
  if (!content) {
    content = (async () => {
      const file = await compile(body, { format: "md", outputFormat: "function-body", remarkPlugins: [remarkGfm, remarkHeadingIds] });
      const module = await run(String(file), { ...runtime, baseUrl: import.meta.url });
      return module.default as LegalDocument["Content"];
    })();
    compiled.set(body, content);
  }
  return content;
}

/** Reads one page's front matter and Markdown, read afresh on every call. */
export async function loadLegal(slug: LegalSlug): Promise<LegalDocument> {
  const source = await readFile(path.join(legalDir(), `${slug}.md`), "utf8");
  const { fields, body } = frontMatter(source.replace(/\r\n/g, "\n"));
  const title = fields.get("title");
  const effective = fields.get("effective");
  const version = Number(fields.get("version"));
  if (!title) throw new Error(`${slug}.md: no title`);
  if (!effective || !/^\d{4}-\d{2}-\d{2}$/.test(effective)) throw new Error(`${slug}.md: effective must be YYYY-MM-DD`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`${slug}.md: version must be a whole number from 1`);
  return { slug, title, effective: new Date(`${effective}T00:00:00Z`), version, Content: await compileMarkdown(body) };
}

/**
 * The pages whose material change the dashboard announces now: a version above 1 whose effective
 * date is less than 30 days ago (or still ahead).
 */
export async function recentLegalChanges(now: Date): Promise<LegalDocument[]> {
  const documents = await Promise.all(LEGAL_SLUGS.map((slug) => loadLegal(slug)));
  return documents.filter((document) => document.version > 1 && now.getTime() < document.effective.getTime() + CHANGE_NOTICE_DAYS * DAY_MS);
}
