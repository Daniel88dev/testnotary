// Loaded with `node --import` into every action process `runAction` starts: the action's timers
// follow the world clock (clock.ts), whose state is in the file `TESTNOTARY_WORLD_CLOCK`. While
// the world clock runs with real time, nothing changes. While it stands still:
//
// - `AbortSignal.timeout(ms)` (the action's budget, its GitHub calls' deadlines) aborts once the
//   world clock reaches its moment, which happens when a test or a service override advances it.
// - `setTimeout(ms)` from `node:timers/promises` (the action's pause before a retry) moves the
//   world clock forward by `ms` and resolves at once. When a deadline signal passed to it would
//   fire first, the clock moves only to that deadline, and the pause rejects as aborted.
//
// So a test of the budget and the retry runs in milliseconds, and the action itself has no hook
// for any of this.
import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { readClockFile, writeClockFile } from "./clock-file.ts";

const file = process.env.TESTNOTARY_WORLD_CLOCK;

if (file) {
  const fixed = () => readClockFile(file);
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const realSleep = timersPromises.setTimeout;

  /** Pending deadlines, by the moment on the world clock they fire at. */
  const deadlines = new Map<AbortController, number>();
  const moments = new WeakMap<AbortSignal, number>();
  let poller: NodeJS.Timeout | undefined;

  const fire = () => {
    const now = fixed() ?? Date.now();
    for (const [controller, at] of deadlines) {
      if (now < at) continue;
      deadlines.delete(controller);
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }
    if (deadlines.size === 0 && poller) {
      clearInterval(poller);
      poller = undefined;
    }
  };

  AbortSignal.timeout = (ms: number): AbortSignal => {
    const start = fixed();
    if (start === undefined) return realTimeout(ms);
    const controller = new AbortController();
    deadlines.set(controller, start + ms);
    moments.set(controller.signal, start + ms);
    // Like a real timeout signal, a pending deadline never keeps the process alive.
    poller ??= setInterval(fire, 5).unref();
    return controller.signal;
  };

  const virtualSleep = (async <T>(ms?: number, value?: T, options?: { signal?: AbortSignal; ref?: boolean }): Promise<T> => {
    const start = fixed();
    if (start === undefined) return realSleep(ms, value, options) as Promise<T>;
    const signal = options?.signal;
    const aborted = () => new DOMException("The operation was aborted", "AbortError");
    if (signal?.aborted) throw aborted();
    const until = start + (ms ?? 0);
    const deadline = signal ? moments.get(signal) : undefined;
    if (deadline !== undefined && deadline <= until) {
      writeClockFile(file, Math.max(start, deadline));
      fire();
      throw aborted();
    }
    writeClockFile(file, until);
    await new Promise((resolve) => setImmediate(resolve));
    return value as T;
  }) as typeof timersPromises.setTimeout;

  timersPromises.setTimeout = virtualSleep;
  syncBuiltinESMExports();
}
