import { gitMaybe, readCommit } from "../../git.ts";
import { githubError, json, notFound, route, type RouteContext } from "../router.ts";
import type { FakeRepo } from "../state.ts";
import { installationFor } from "./installation.ts";

// Git database and contents endpoints, answered from the fixture repo's bare origin. The service
// calls them with an installation token (`contents: read`), which reaches only its installation's
// repos; the action's signature check with the job's `GITHUB_TOKEN` (`contents: read` in the
// snippet), which reaches only its own repo. Without a token a public repo still answers, as
// GitHub's does; a private one is a 404.

/** The repo the request may read, or GitHub's answer when it may not. */
function readableRepo(context: RouteContext): FakeRepo | Response {
  const repo = context.github.state.repo(context.params.owner!, context.params.repo!);
  if (!context.request.headers.has("authorization")) return repo && repo.visibility === "public" ? repo : notFound();
  const job = context.github.state.jobTokens.get(/^(?:Bearer|token) (\S+)$/i.exec(context.request.headers.get("authorization") ?? "")?.[1] ?? "");
  if (job) return repo && repo.id === job.repoId ? repo : notFound();
  const installation = installationFor(context);
  if (installation instanceof Response) return installation;
  if (!repo || !installation.repoIds.has(repo.id)) return notFound();
  return repo;
}

/** GitHub's compare lists at most this many changed files for a whole comparison. */
const COMPARE_FILE_CAP = 300;

const STATUSES: Record<string, string> = { A: "added", M: "modified", D: "removed", R: "renamed", C: "copied", T: "changed" };

/** `git diff --name-status -z` as GitHub's file entries: status, path, and the old path of a rename. */
function parseNameStatus(output: string): { filename: string; status: string; previousFilename?: string }[] {
  const fields = output.split("\0");
  const files: { filename: string; status: string; previousFilename?: string }[] = [];
  for (let i = 0; i < fields.length - 1; ) {
    const code = fields[i++]!;
    const letter = code[0]!;
    if (letter === "R" || letter === "C") {
      const previous = fields[i++]!;
      const filename = fields[i++]!;
      files.push({ filename, status: STATUSES[letter]!, ...(letter === "R" ? { previousFilename: previous } : {}) });
    } else {
      files.push({ filename: fields[i++]!, status: STATUSES[letter] ?? "changed" });
    }
  }
  return files;
}

export const gitRoutes = [
  // https://docs.github.com/rest/git/commits#get-a-commit-object (github-behaviours §4)
  // The service resolves the OIDC `sha` claim through this to get the tree CI is building.
  route("GET", "/repos/:owner/:repo/git/commits/:sha", async (context) => {
    const { params, github } = context;
    const repo = readableRepo(context);
    if (repo instanceof Response) return repo;
    const commit = await readCommit(repo.gitDir, params.sha!);
    if (!commit) return notFound();
    const api = `${github.url}/repos/${repo.fullName}/git`;
    return json(200, {
      sha: commit.sha,
      node_id: `C_${commit.sha.slice(0, 12)}`,
      url: `${api}/commits/${commit.sha}`,
      html_url: `https://github.com/${repo.fullName}/commit/${commit.sha}`,
      author: commit.author,
      committer: commit.committer,
      tree: { sha: commit.tree, url: `${api}/trees/${commit.tree}` },
      message: commit.message.replace(/\n$/, ""),
      parents: commit.parents.map((sha) => ({
        sha,
        url: `${api}/commits/${sha}`,
        html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
      })),
      verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
    });
  }),

  // https://docs.github.com/rest/commits/commits#get-a-commit
  // The commit page reads who wrote a commit through this. GitHub links the author to an account
  // by email; here a no-reply address (`<id>+<login>@users.noreply.github.com`) of a known user
  // links, and any other address (the fixtures' `author@fixture.test`) leaves `author` null.
  route("GET", "/repos/:owner/:repo/commits/:ref", async (context) => {
    const { params, github } = context;
    const repo = readableRepo(context);
    if (repo instanceof Response) return repo;
    const commit = await readCommit(repo.gitDir, params.ref!);
    if (!commit) return githubError(422, `No commit found for SHA: ${params.ref}`);
    const noReply = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/.exec(commit.author.email);
    const account = noReply ? github.state.accountById(Number(noReply[1])) : undefined;
    return json(200, {
      sha: commit.sha,
      url: `${github.url}/repos/${repo.fullName}/commits/${commit.sha}`,
      html_url: `https://github.com/${repo.fullName}/commit/${commit.sha}`,
      commit: { author: commit.author, committer: commit.committer, message: commit.message.replace(/\n$/, ""), tree: { sha: commit.tree } },
      author: account ? { login: account.login, id: account.id, type: account.type } : null,
      committer: null,
      parents: commit.parents.map((sha) => ({ sha, url: `${github.url}/repos/${repo.fullName}/commits/${sha}`, html_url: `https://github.com/${repo.fullName}/commit/${sha}` })),
    });
  }),

  // https://docs.github.com/rest/commits/commits#compare-two-commits (github-behaviours §5)
  // `{base}...{head}`: the changes from their merge base to `head`, as GitHub lists them. From a
  // pull request's merge commit to its first parent that is the PR's own files, never the
  // base-only ones. Renames come with `previous_filename`. Like GitHub, at most 300 files for the
  // whole comparison, sorted by path.
  route("GET", "/repos/:owner/:repo/compare/:basehead", async (context) => {
    const { params, github } = context;
    const repo = readableRepo(context);
    if (repo instanceof Response) return repo;
    const match = /^(.+?)\.\.\.(.+)$/.exec(params.basehead!);
    if (!match) return notFound();
    const [, baseRef, headRef] = match;
    const base = await readCommit(repo.gitDir, baseRef!);
    const head = await readCommit(repo.gitDir, headRef!);
    if (!base || !head) return notFound();
    const mergeBase = (await gitMaybe(repo.gitDir, ["merge-base", base.sha, head.sha]))?.trim();
    if (!mergeBase) return githubError(404, `No common ancestor between ${baseRef} and ${headRef}.`);
    const ahead = (await gitMaybe(repo.gitDir, ["rev-list", "--reverse", `${mergeBase}..${head.sha}`]))?.split("\n").filter(Boolean) ?? [];
    const behind = Number((await gitMaybe(repo.gitDir, ["rev-list", "--count", `${mergeBase}..${base.sha}`]))?.trim() ?? 0);
    const diff = (await gitMaybe(repo.gitDir, ["diff", "--name-status", "-z", "--find-renames", mergeBase, head.sha])) ?? "";
    const files = parseNameStatus(diff)
      .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
      .slice(0, COMPARE_FILE_CAP)
      .map((file) => ({
        sha: null,
        filename: file.filename,
        status: file.status,
        additions: 0,
        deletions: 0,
        changes: 0,
        blob_url: `https://github.com/${repo.fullName}/blob/${head.sha}/${file.filename}`,
        raw_url: `https://github.com/${repo.fullName}/raw/${head.sha}/${file.filename}`,
        contents_url: `${github.url}/repos/${repo.fullName}/contents/${file.filename}?ref=${head.sha}`,
        ...(file.previousFilename ? { previous_filename: file.previousFilename } : {}),
      }));
    const status = ahead.length === 0 ? (behind === 0 ? "identical" : "behind") : behind === 0 ? "ahead" : "diverged";
    return json(200, {
      url: `${github.url}/repos/${repo.fullName}/compare/${params.basehead}`,
      html_url: `https://github.com/${repo.fullName}/compare/${params.basehead}`,
      base_commit: { sha: base.sha },
      merge_base_commit: { sha: mergeBase },
      status,
      ahead_by: ahead.length,
      behind_by: behind,
      total_commits: ahead.length,
      commits: ahead.slice(0, 250).map((sha) => ({ sha, url: `${github.url}/repos/${repo.fullName}/commits/${sha}` })),
      files,
    });
  }),

  // https://docs.github.com/rest/repos/contents#get-repository-content (github-behaviours §6)
  // One file at `?ref=` (default: the default branch), base64. The service reads `testnotary.json`
  // at the built commit's first parent through this. Paths of one segment only; add a route for
  // deeper paths (`.testnotary/allowed_signers`) when a ticket needs one.
  route("GET", "/repos/:owner/:repo/contents/:path", async (context) => {
    const { params, url, github } = context;
    const repo = readableRepo(context);
    if (repo instanceof Response) return repo;
    const ref = url.searchParams.get("ref") || repo.defaultBranch;
    const commit = await gitMaybe(repo.gitDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!commit) return githubError(404, `No commit found for the ref ${ref}`);
    const path = params.path!;
    const blob = await gitMaybe(repo.gitDir, ["rev-parse", "--verify", "--quiet", `${commit.trim()}:${path}`]);
    const type = blob ? await gitMaybe(repo.gitDir, ["cat-file", "-t", blob.trim()]) : undefined;
    if (!blob || type?.trim() !== "blob") return notFound();
    const content = await gitMaybe(repo.gitDir, ["cat-file", "blob", blob.trim()]);
    const sha = blob.trim();
    const base64 = Buffer.from(content ?? "", "utf8").toString("base64");
    return json(200, {
      type: "file",
      encoding: "base64",
      size: Buffer.byteLength(content ?? ""),
      name: path,
      path,
      sha,
      // GitHub wraps the base64 at 60 characters with newlines.
      content: `${base64.replace(/.{60}/g, "$&\n")}\n`,
      url: `${github.url}/repos/${repo.fullName}/contents/${path}?ref=${ref}`,
    });
  }),
];
