// Testnotary's own output. The child's output passes through untouched; everything Testnotary says
// goes to stderr with a `testnotary:` prefix; the last line is the fixed summary line; with `--json`
// stdout carries one object.
import type { Outcome, RefusalCode } from "./shared.ts";

/** How a run ended, as the summary line and the `--json` object report it. */
export interface RunReport {
  outcome: Outcome;
  suite: string;
  refusal: RefusalCode | null;
  /** The command's real exit code; `null` when it never ran. */
  exitCode: number | null;
  attested: boolean;
  attestationUrl: string | null;
  tree: string | null;
  commit: string | null;
  durationMs: number;
  warnings: string[];
}

export const EXIT = { passed: 0, failed: 1, refused: 2, usage: 64 } as const;

/** Writes one of Testnotary's own lines to stderr. */
export function say(line: string): void {
  process.stderr.write(`testnotary: ${line}\n`);
}

/** `outcome= suite= attested= tree= commit= url=`, with empty values left empty. */
export function summaryLine(report: RunReport): string {
  return [
    `outcome=${report.outcome}`,
    `suite=${report.suite}`,
    `attested=${report.attested}`,
    `tree=${report.tree ?? ""}`,
    `commit=${report.commit ?? ""}`,
    `url=${report.attestationUrl ?? ""}`,
  ].join(" ");
}

/** The `--json` object: exactly the spec's fields. */
export function jsonReport(report: RunReport): Record<string, unknown> {
  return {
    outcome: report.outcome,
    refusal: report.refusal,
    exitCode: report.exitCode,
    attested: report.attested,
    attestationUrl: report.attestationUrl,
    tree: report.tree,
    commit: report.commit,
    durationMs: report.durationMs,
    warnings: report.warnings,
  };
}

/** Ends a run: the summary line on stderr, the object on stdout with `--json`; returns the exit code. */
export function finish(report: RunReport, options: { json: boolean }): number {
  process.stderr.write(`${summaryLine(report)}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify(jsonReport(report))}\n`);
  return EXIT[report.outcome];
}
