import { compile, run } from "@mdx-js/mdx";
import GithubSlugger from "github-slugger";
import type { ComponentType } from "react";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";

// Compiles one docs page from MDX. Two remark steps of our own:
// - every fenced code block becomes a <Code> panel (the info string after the language is the
//   panel's label: ```sh terminal), so panels get the package-manager tabs and the copy button;
// - h2/h3 headings get ids, and they, every <Part id title> and every <Step id title> make the
//   page's "On this page" list and its search entries.

export interface TocEntry {
  id: string;
  title: string;
  level: 2 | 3;
}

export interface CompiledPage {
  Content: ComponentType<{ components?: Record<string, unknown> }>;
  /** The page's h1 when it differs from its title in the tree (`export const heading = "…"`). */
  heading: string | undefined;
  toc: TocEntry[];
}

// The few mdast shapes the steps touch.
interface Node {
  type: string;
  children?: Node[];
  value?: string;
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  name?: string | null;
  attributes?: { type: string; name?: string; value?: unknown }[];
  data?: { hProperties?: Record<string, unknown> };
}

function textOf(node: Node): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function attribute(node: Node, name: string): string | undefined {
  const found = node.attributes?.find((a) => a.type === "mdxJsxAttribute" && a.name === name);
  return typeof found?.value === "string" ? found.value : undefined;
}

function remarkDocs() {
  return (tree: Node, file: { data: Record<string, unknown> }) => {
    const toc: TocEntry[] = [];
    const slugger = new GithubSlugger();
    let steps = 0;
    const visit = (node: Node, parent: Node | undefined, index: number) => {
      if (node.type === "code" && parent?.children) {
        const attributes = [{ type: "mdxJsxAttribute", name: "text", value: node.value ?? "" }];
        if (node.lang) attributes.push({ type: "mdxJsxAttribute", name: "lang", value: node.lang });
        if (node.meta) attributes.push({ type: "mdxJsxAttribute", name: "file", value: node.meta.trim() });
        parent.children[index] = { type: "mdxJsxFlowElement", name: "Code", attributes, children: [] };
        return;
      }
      if (node.type === "heading" && (node.depth === 2 || node.depth === 3)) {
        const title = textOf(node);
        const id = slugger.slug(title);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
        toc.push({ id, title, level: node.depth });
      }
      if (node.type === "mdxJsxFlowElement" && (node.name === "Part" || node.name === "Step")) {
        const id = attribute(node, "id");
        const title = attribute(node, "title");
        if (id && title) toc.push({ id, title, level: node.name === "Part" ? 2 : 3 });
        // Steps are numbered through the whole page, across parts.
        if (node.name === "Step") node.attributes?.push({ type: "mdxJsxAttribute", name: "number", value: String(++steps) });
      }
      node.children?.forEach((child, i) => visit(child, node, i));
    };
    visit(tree, undefined, 0);
    file.data.toc = toc;
  };
}

const cache = new Map<string, Promise<CompiledPage>>();

/** The page's component and its "On this page" entries; compiled once per source text. */
export function compilePage(source: string): Promise<CompiledPage> {
  let compiled = cache.get(source);
  if (!compiled) {
    compiled = (async () => {
      const file = await compile(source, { outputFormat: "function-body", remarkPlugins: [remarkGfm, remarkDocs] });
      const module = await run(String(file), { ...runtime, baseUrl: import.meta.url });
      return {
        Content: module.default as CompiledPage["Content"],
        heading: typeof module.heading === "string" ? module.heading : undefined,
        toc: (file.data.toc as TocEntry[] | undefined) ?? [],
      };
    })();
    cache.set(source, compiled);
  }
  return compiled;
}
