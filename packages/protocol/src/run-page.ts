// Where a run lives on the web (open decision 6): `/<owner>/<repo>/runs/<id>`, under the same
// GitHub-shaped URLs as the rest of the dashboard. The library prints it as `url=`, the PR line
// links it, and the web app serves it. Build it only here.

/** `/<owner>/<repo>/runs/<id>` for a repo's full name (`owner/repo`) and a run id. */
export function runPagePath(repository: string, runId: string): string {
  const [owner, name] = repository.split("/");
  return `/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/runs/${encodeURIComponent(runId)}`;
}

/** A repo's Mismatches page, `/<owner>/<repo>/mismatches`, where an admin explains each one. */
export function mismatchesPageUrl(siteUrl: string, repository: string): string {
  const [owner, name] = repository.split("/");
  return `${siteUrl.replace(/\/+$/, "")}/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/mismatches`;
}

/** The run page on the site the service runs at (`https://testnotary.dev` in production). */
export function runPageUrl(siteUrl: string, repository: string, runId: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${runPagePath(repository, runId)}`;
}
