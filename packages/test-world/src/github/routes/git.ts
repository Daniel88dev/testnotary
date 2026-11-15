import { gitMaybe, readCommit } from "../../git.ts";
import { githubError, json, notFound, route, type RouteContext } from "../router.ts";
import type { FakeRepo } from "../state.ts";
import { installationFor } from "./installation.ts";

// Git database and contents endpoints, answered from the fixture repo's bare origin. The service
// calls them with an installation token (`contents: read`), which reaches only its installation's
// repos. Without a token a public repo still answers, as GitHub's does; a private one is a 404.

/** The repo the request may read, or GitHub's answer when it may not. */
function readableRepo(context: RouteContext): FakeRepo | Response {
  const repo = context.github.state.repo(context.params.owner!, context.params.repo!);
  if (!context.request.headers.has("authorization")) return repo && repo.visibility === "public" ? repo : notFound();
  const installation = installationFor(context);
  if (installation instanceof Response) return installation;
  if (!repo || !installation.repoIds.has(repo.id)) return notFound();
  return repo;
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
