import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

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

/**
 * What a process whose timers follow the clock (the action, through action-clock-preload.ts) last
 * did with it, kept beside the clock's file: the moment it last read, and the latest moment at
 * which one of its deadlines fired. A stalled service waits for it before moving the clock again
 * (stall.ts), so the clock never runs ahead of a client that hasn't looked yet.
 */
export interface ClockAck {
  seen: number;
  firedAt?: number;
}

const ackFile = (file: string) => `${file}.ack`;

export function readClockAck(file: string): ClockAck | undefined {
  try {
    const { seen, firedAt } = JSON.parse(readFileSync(ackFile(file), "utf8")) as { seen?: unknown; firedAt?: unknown };
    if (typeof seen !== "number") return undefined;
    return typeof firedAt === "number" ? { seen, firedAt } : { seen };
  } catch {
    return undefined;
  }
}

/** Writes the acknowledgement whole, as the clock's file is written; undefined removes it. */
export function writeClockAck(file: string, ack: ClockAck | undefined): void {
  if (!ack) return rmSync(ackFile(file), { force: true });
  const next = `${ackFile(file)}.${process.pid}.next`;
  writeFileSync(next, JSON.stringify(ack));
  renameSync(next, ackFile(file));
}
