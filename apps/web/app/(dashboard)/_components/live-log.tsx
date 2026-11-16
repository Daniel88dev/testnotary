"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { LogLine } from "../../../src/server/overview.ts";
import { clock } from "../_lib/format.ts";
import { repoHref } from "../_lib/sections.ts";

// The Overview's "Live verifications" (prototype `eventLog`): the newest verifications in Plex Mono,
// kept current by polling `/api/live/<owner>/<repo>` while the tab is visible, so a new one shows
// up without a reload. Each line opens its commit page.

const POLL_MS = 4_000;

export function LiveLog({ fullName, initial }: { fullName: string; initial: LogLine[] }) {
  const [lines, setLines] = useState(initial);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/api/live/${fullName}`, { cache: "no-store" });
          if (!response.ok) throw new Error(String(response.status));
          const body = (await response.json()) as { lines: LogLine[] };
          if (!stopped) {
            setLines(body.lines);
            setPaused(false);
          }
        } catch {
          if (!stopped) setPaused(true);
        }
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [fullName]);

  return (
    <aside className="panel live" aria-labelledby="live-title">
      <div className="panel-h">
        <h2 id="live-title">Live verifications</h2>
        <span className="side">
          <span className={`dot ${paused ? "run" : "skip"}`} aria-hidden="true" /> {paused ? "paused" : "live"}
        </span>
      </div>
      <div className="panel-b">
        <div role="log" aria-label="Live verifications">
          <ul className="log">
            {lines.map((line) => (
              <li key={line.id}>
                <span>{clock(new Date(line.at))}</span>
                <span className={line.kind.includes("skip") ? "c-skip" : "c-run"}>{line.kind}</span>
                <span>
                  <Link href={repoHref(fullName, `commit/${line.commit}`)}>{line.commit.slice(0, 7)}</Link> {line.suite ?? "—"}
                  {line.note ? ` · ${line.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <Link className="link" style={{ display: "inline-block", marginTop: 10, fontSize: 13 }} href={repoHref(fullName, "verifications")}>
          All verifications
        </Link>
      </div>
    </aside>
  );
}
