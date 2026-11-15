import { readFileSync, renameSync, writeFileSync } from "node:fs";

// The world clock's state on disk, so processes the world starts (the action) keep the same time
// as the service: `{"fixed": <ms since the epoch> | null}`, null while the clock runs with real
// time. Read on every `now()`; written whole and renamed into place, so a reader never sees half.

export function readClockFile(file: string): number | undefined {
  try {
    const { fixed } = JSON.parse(readFileSync(file, "utf8")) as { fixed?: unknown };
    return typeof fixed === "number" ? fixed : undefined;
  } catch {
    return undefined;
  }
}

export function writeClockFile(file: string, fixed: number | undefined): void {
  const next = `${file}.${process.pid}.next`;
  writeFileSync(next, JSON.stringify({ fixed: fixed ?? null }));
  renameSync(next, file);
}
