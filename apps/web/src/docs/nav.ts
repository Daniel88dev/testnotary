// The docs tree: every page, in order, by group. A page's text lives in
// `content/docs/<slug>.mdx`; a page without that file renders as a stub saying what it will hold,
// so links to it resolve before it is written.
//
// To add a page: add an entry here and write `content/docs/<slug>.mdx` (see content/docs/README.md).
// Slugs are part of the public URLs (the CLI links /docs/agents and /docs/limits#github-enterprise,
// the dashboard links /docs/setup#<step>); never rename one.

export interface DocsPage {
  slug: string;
  title: string;
  /** One line on what the page covers: the stub's text, and the "Where to go next" cards'. */
  holds: string;
}

export interface DocsGroup {
  group: string;
  pages: DocsPage[];
}

export const DOCS_NAV: DocsGroup[] = [
  {
    group: "Start here",
    pages: [
      {
        slug: "intro",
        title: "What Testnotary does",
        holds: "A passing run on a laptop or in a sandbox lets CI skip its test step when the tree matches, and the limit, in the trust model’s words.",
      },
      { slug: "setup", title: "Setup guide", holds: "From a repo with nothing installed to its first skipped test job, in nine steps." },
      {
        slug: "how",
        title: "How a skip is decided",
        holds: "The order of checks at verification, from the kill switch to the repo’s mode.",
      },
    ],
  },
  {
    group: "Guides",
    pages: [
      {
        slug: "agents",
        title: "Agents and sandbox tokens",
        holds: "Sandbox markers, how the library finds a token, per-vendor steps, session labels and why they read unverified.",
      },
      { slug: "shadow", title: "Shadow mode and enforce", holds: "What shadow mode records, the toggle and its warnings, the kill switch." },
      {
        slug: "audits",
        title: "Audits and mismatches",
        holds: "Audit rates, what a mismatch does to the repo, explaining one, re-running the commits it casts doubt on.",
      },
      { slug: "forks", title: "Forks, Dependabot and Copilot", holds: "Who never skips and why; the approval wait on Copilot pull requests." },
    ],
  },
  {
    group: "Workflow recipes",
    pages: [
      {
        slug: "gate",
        title: "Gate job",
        holds: "A mode: verify job with outputs skip and verification, for test jobs with expensive setup.",
      },
      { slug: "matrix", title: "Matrix jobs", holds: "The inline shape in every leg; why a job-level skip breaks matrix check names." },
      { slug: "queue", title: "Merge queues and up-to-date branches", holds: "merge_group, strict mode, and why a branch behind main never skips." },
      { slug: "coverage", title: "Coverage and test reports", holds: "Guarding upload steps with steps.testnotary.outputs.ran; required coverage checks." },
    ],
  },
  {
    group: "Test command recipes",
    pages: [
      { slug: "build", title: "Build before the tests", holds: "The command builds what the tests import, because a run tests the working tree as it is." },
      { slug: "services", title: "Postgres and other services", holds: "The command starts them, the URL goes in env.pass, the compose file can be guarded." },
      { slug: "caches", title: "Playwright and other caches", holds: "The scratch HOME, and PLAYWRIGHT_BROWSERS_PATH through env.pass." },
      { slug: "shell", title: "Shell features and .env files", holds: "A package.json script for pipes; dotenv and the ignored_env_file warning." },
      { slug: "docker", title: "Run the suite in Docker", holds: "A declared command that runs the tests in a container, since v1 has no container mode." },
      { slug: "hook", title: "A pre-push hook", holds: "testnotary run --require-attestation before every push." },
    ],
  },
  {
    group: "Reference",
    pages: [
      { slug: "config", title: "testnotary.json", holds: "Every key, the schema, what is refused, and the baseline environment." },
      { slug: "cli", title: "CLI commands", holds: "init, login, logout, whoami, run, check, exec, sandbox-key, and their flags." },
      { slug: "output", title: "Exit codes and output", holds: "Exit codes 0, 1, 2, 3, 64 and 130; the summary line; the --json objects; the warning codes." },
      { slug: "refusals", title: "Refusal codes", holds: "All 20 refusal codes, each with its cause and fix." },
      { slug: "inputs", title: "Action inputs and outputs", holds: "suite, mode, verification, github-token; result, reason, ran, skip, verification." },
      { slug: "reasons", title: "Fallback reason codes", holds: "All 20 fallback reason codes, each with its cause and fix, and the versioning rule." },
      {
        slug: "pr",
        title: "What the pull request shows",
        holds: "The job summary and the Testnotary / <suite> check for a skip, a fallback, an audit and a mismatch.",
      },
      { slug: "guarded", title: "Guarded files", holds: "The product defaults and how a repo adds its own." },
    ],
  },
  {
    group: "Trust",
    pages: [
      { slug: "limit", title: "What Testnotary can’t prove", holds: "The trust model in plain words, and the adversaries it is built for." },
      { slug: "data", title: "What leaves your machine", holds: "What a run sends, and what it never sends." },
      {
        slug: "limits",
        title: "Limits in v1",
        holds: "macOS and Linux; npm, pnpm and Yarn; GitHub.com only; hand edits in node_modules go unnoticed.",
      },
      { slug: "security", title: "Security", holds: "Pinning the action to a commit, signature mode, and the limits we accept." },
      { slug: "licensing", title: "Licensing", holds: "MIT for every part, and what that means for the files init writes." },
    ],
  },
];

export const DOCS_PAGES: (DocsPage & { group: string })[] = DOCS_NAV.flatMap((g) => g.pages.map((page) => ({ ...page, group: g.group })));

export function docsPage(slug: string): (DocsPage & { group: string }) | undefined {
  return DOCS_PAGES.find((page) => page.slug === slug);
}
