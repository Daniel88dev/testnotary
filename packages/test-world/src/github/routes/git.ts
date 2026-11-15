import { readCommit } from "../../git.ts";
import { json, notFound, route } from "../router.ts";

// Git database endpoints, answered from the fixture repo's bare origin.

export const gitRoutes = [
  // https://docs.github.com/rest/git/commits#get-a-commit-object
  // The service resolves the OIDC `sha` claim through this to get the tree CI is building.
  route("GET", "/repos/:owner/:repo/git/commits/:sha", async ({ params, github }) => {
    const repo = github.state.repo(params.owner!, params.repo!);
    if (!repo) return notFound();
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
];
