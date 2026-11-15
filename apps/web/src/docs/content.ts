import { readFile } from "node:fs/promises";
import path from "node:path";
import { compilePage, type CompiledPage, type TocEntry } from "./mdx.ts";
import { DOCS_NAV, DOCS_PAGES, docsPage, type DocsPage } from "./nav.ts";

// Pages are MDX files in apps/web/content/docs, one per slug in DOCS_NAV.

const CONTENT_DIR = path.join(process.cwd(), "content", "docs");

export type LoadedPage = DocsPage & { group: string } & ({ written: true; compiled: CompiledPage } | { written: false });

async function source(slug: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(CONTENT_DIR, `${slug}.mdx`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadPage(slug: string): Promise<LoadedPage | undefined> {
  const page = docsPage(slug);
  if (!page) return undefined;
  const text = await source(slug);
  if (text === undefined) return { ...page, written: false };
  return { ...page, written: true, compiled: await compilePage(text) };
}

/** What the search box and the page tree filter match against: every page's title and headings. */
export interface SearchGroup {
  group: string;
  pages: { slug: string; title: string; headings: TocEntry[] }[];
}

export async function searchIndex(): Promise<SearchGroup[]> {
  const loaded = new Map<string, LoadedPage | undefined>();
  await Promise.all(DOCS_PAGES.map(async (page) => loaded.set(page.slug, await loadPage(page.slug))));
  return DOCS_NAV.map((group) => ({
    group: group.group,
    pages: group.pages.map((page) => {
      const found = loaded.get(page.slug);
      return { slug: page.slug, title: page.title, headings: found?.written ? found.compiled.toc : [] };
    }),
  }));
}
