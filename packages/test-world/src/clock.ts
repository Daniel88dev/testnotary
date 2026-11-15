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

export function createClock(): WorldClock {
  let fixed: number | undefined;
  return {
    now: () => new Date(fixed ?? Date.now()),
    set(at) {
      fixed = at.getTime();
    },
    advance(ms) {
      fixed = (fixed ?? Date.now()) + ms;
    },
    reset() {
      fixed = undefined;
    },
  };
}
