import { readClockFile, writeClockFile } from "./clock-file.ts";

/**
 * The service's clock in a world. It runs with real time until a test sets or advances it; from
 * then on it stands still at that moment until the next `set`, `advance` or `reset`, so expiry
 * arithmetic in a test is exact. Only the in-process service follows it (a `next dev` world keeps
 * real time). Tests that move it reset it in a `finally`, since the world is shared by a file.
 *
 * What it moves: token renewal and expiry, run receipt times, attestation age at verification,
 * and every other time the service decides with, and the fake GitHub's OIDC issuer (`iat`, `nbf`,
 * `exp` of the tokens a job gets), so a job after `advance` still sends a fresh token. It does not
 * move Postgres's own `now()` or the rest of the fake GitHub (installation tokens, App JWTs).
 *
 * **The action's waits** (`runAction`) follow it too, while it stands still: the action's deadlines
 * (`AbortSignal.timeout`, its 10 s budget) fire once the clock reaches them, and its pauses
 * (`setTimeout` of `node:timers/promises`, the 1 s before a retry) move the clock forward instead
 * of sleeping. So a service override that advances the clock is a slow service, and nothing waits
 * in real time. While the clock runs with real time, the action's timers are real ones.
 */
export interface WorldClock {
  now(): Date;
  /** Stops the clock at this moment. */
  set(at: Date): void;
  /** Moves the clock forward from where it is now (real time if it was running) and stops it. */
  advance(ms: number): void;
  /** Back to real time. */
  reset(): void;
}

/**
 * A clock whose state lives in `file` (see clock-file.ts), so the processes the world starts can
 * read it and move it; without a file, in memory.
 */
export function createClock(file?: string): WorldClock {
  let memory: number | undefined;
  const read = () => (file ? readClockFile(file) : memory);
  const write = (fixed: number | undefined) => {
    if (file) writeClockFile(file, fixed);
    else memory = fixed;
  };
  write(undefined);
  return {
    now: () => new Date(read() ?? Date.now()),
    set(at) {
      write(at.getTime());
    },
    advance(ms) {
      write((read() ?? Date.now()) + ms);
    },
    reset() {
      write(undefined);
    },
  };
}
