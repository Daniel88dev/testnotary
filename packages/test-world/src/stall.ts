import { setTimeout as sleep } from "node:timers/promises";
import { readClockAck, writeClockAck } from "./clock-file.ts";
import type { WorldClock } from "./clock.ts";

// A service that never answers: the world clock moves on in steps until the client hangs up.
//
// A client whose timers follow the clock (the action) reads it from another process, so a step is
// not over until that client has looked: it acknowledges each moment it read, and says when one of
// its deadlines fired (ClockAck). The clock moves again only after the acknowledgement, and after a
// deadline fired it waits for the hang-up. Stepping on a real-time pause instead lets the clock run
// ahead of a client on a busy machine, and the hang-up is then seen a step or two late.

/** Real time a client that follows the clock gets to acknowledge a step. */
const ACK_WAIT_MS = 2_000;
/** Real time a hang-up gets to arrive once the client's deadline fired. */
const HANG_UP_WAIT_MS = 5_000;
/** The real pause between steps for a client that doesn't follow the clock. */
const UNFOLLOWED_STEP_MS = 5;

export interface StallOptions {
  stepMs?: number;
  limitMs?: number;
}

/** Resolves with the world clock's time when the client hung up, or after `limitMs` of world time. */
export async function stall(clock: WorldClock, clockFile: string, request: Request, { stepMs = 1_000, limitMs = 120_000 }: StallOptions = {}): Promise<Date> {
  const start = clock.now().getTime();
  writeClockAck(clockFile, undefined);
  let follows = true;
  let lastFired = start;
  while (!request.signal.aborted && clock.now().getTime() - start < limitMs) {
    clock.advance(stepMs);
    const at = clock.now().getTime();
    if (!follows) {
      await sleep(UNFOLLOWED_STEP_MS);
      continue;
    }
    const ack = await until(() => acknowledged(clockFile, at), request.signal, ACK_WAIT_MS);
    if (request.signal.aborted) break;
    if (!ack) {
      follows = false;
      continue;
    }
    if (ack.firedAt !== undefined && ack.firedAt > lastFired) {
      lastFired = ack.firedAt;
      await until(() => undefined, request.signal, HANG_UP_WAIT_MS);
    }
  }
  return clock.now();
}

function acknowledged(clockFile: string, at: number) {
  const ack = readClockAck(clockFile);
  return ack && ack.seen >= at ? ack : undefined;
}

/** Asks `read` every millisecond until it answers, the signal aborts or `ms` of real time pass. */
async function until<T>(read: () => T | undefined, signal: AbortSignal, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (!signal.aborted && Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(1);
  }
  return undefined;
}
