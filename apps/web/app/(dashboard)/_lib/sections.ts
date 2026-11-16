// The six sections of a repo, in the repo column's order. `path` is relative to `/<owner>/<repo>`.

export interface Section {
  path: string;
  label: string;
  /** Hidden (and 404) when signed out. */
  signedInOnly?: boolean;
}

export const SECTIONS: readonly Section[] = [
  { path: "", label: "Overview" },
  { path: "verifications", label: "Verifications" },
  { path: "runs", label: "Runs" },
  { path: "mismatches", label: "Mismatches" },
  { path: "people", label: "People" },
  { path: "settings", label: "Settings", signedInOnly: true },
];

export function repoHref(fullName: string, path = ""): string {
  return path ? `/${fullName}/${path}` : `/${fullName}`;
}

/** The section a pathname under the repo belongs to: commit pages count as Verifications, run pages as Runs. */
export function sectionOf(pathname: string, fullName: string): string {
  const rest = pathname.slice(fullName.length + 2).split("/")[0] ?? "";
  if (rest === "commit") return "verifications";
  if (rest === "run" || rest === "runs") return "runs";
  return SECTIONS.some((section) => section.path === rest) ? rest : "";
}
