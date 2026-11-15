// Formatting shared by every dashboard page, ported from the prototype (ui.js `dur`, `day`, `rel`).
// Times are shown in UTC with fixed English month names, as the CLI's `shortDate` does.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** `14:05` (UTC). */
export function clock(at: Date): string {
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/** `15 Nov`. */
export function day(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** `15 Nov 2026`. */
export function date(at: Date): string {
  return `${day(at)} ${at.getUTCFullYear()}`;
}

/** `just now`, `12 min ago`, `Today 14:05`, `Yesterday 09:30`, `13 Nov 16:42`. */
export function rel(at: Date, now: Date = new Date()): string {
  const diff = now.getTime() - at.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  const today = Math.floor(now.getTime() / DAY_MS);
  const then = Math.floor(at.getTime() / DAY_MS);
  if (then === today) return `Today ${clock(at)}`;
  if (then === today - 1) return `Yesterday ${clock(at)}`;
  return `${day(at)} ${clock(at)}`;
}

/** `42 s`, `3 m 05 s`, `1 h 12 m`. */
export function dur(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${pad(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} m`;
}
