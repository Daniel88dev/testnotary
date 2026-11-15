import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadPage } from "../../../src/docs/content.ts";
import { DOCS_PAGES } from "../../../src/docs/nav.ts";
import { MDX_COMPONENTS } from "../_components/mdx-components.tsx";
import { Toc } from "../_components/toc.tsx";

// One docs page, from content/docs/<slug>.mdx; a page in the tree without a file is a stub.

export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS_PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = await loadPage((await params).slug);
  return { title: page ? `${page.title} · Testnotary docs` : "Testnotary docs", description: page?.holds };
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string }> }) {
  const page = await loadPage((await params).slug);
  if (!page) notFound();

  if (!page.written) {
    return (
      <>
        <main className="article">
          <header className="a-head">
            <p className="crumb">{page.group}</p>
            <h1>{page.title}</h1>
          </header>
          <div className="stub">
            <p>Not written yet. This page will hold:</p>
            <p className="holds">{page.holds}</p>
            <Link className="btn-line" href="/docs/setup">
              Back to the setup guide
            </Link>
          </div>
        </main>
        <Toc entries={[]} />
      </>
    );
  }

  const { Content, heading, toc } = page.compiled;
  return (
    <>
      <main className="article">
        <header className="a-head">
          <p className="crumb">{page.group}</p>
          <h1>{heading ?? page.title}</h1>
        </header>
        <div className="prose">
          <Content components={MDX_COMPONENTS} />
        </div>
      </main>
      <Toc entries={toc} />
    </>
  );
}
