// Agent detection: which coding agent's session a run comes from, read from the environment with
// this table (no dependency). The labels are uploaded with every run, on laptops too, and are
// always shown *unverified*: any process can set these variables. The table ships with the
// library and updates with its releases; the docs render the same entries.

type Env = Readonly<Record<string, string | undefined>>;

/** What a run uploads about its agent session. */
export interface SessionLabels {
  vendor: string;
  id: string | null;
  url: string | null;
}

export interface SessionAgent {
  vendor: string;
  /** Where the labels come from, as the docs write it; backticks mark code. */
  readFrom: string;
  /** Whether the environment is this agent's. */
  detect(env: Env): boolean;
  id(env: Env): string | undefined;
  url(env: Env): string | undefined;
}

const set = (value: string | undefined): string | undefined => (value?.trim() ? value.trim() : undefined);

/** In table order: the first agent that matches names the session. */
export const SESSION_AGENTS: readonly SessionAgent[] = [
  {
    vendor: "Claude Code",
    readFrom:
      "`CLAUDECODE` set, or `CLAUDE_CODE_REMOTE=true`; the session from `CLAUDE_CODE_REMOTE_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`, and a session URL for a session on the web",
    detect: (env) => !!set(env.CLAUDECODE) || env.CLAUDE_CODE_REMOTE === "true",
    id: (env) => set(env.CLAUDE_CODE_REMOTE_SESSION_ID) ?? set(env.CLAUDE_CODE_SESSION_ID),
    // A session on the web has a page; the id of a local session has none.
    url: (env) => {
      const remote = set(env.CLAUDE_CODE_REMOTE_SESSION_ID);
      return remote ? `https://claude.ai/code/${encodeURIComponent(remote)}` : undefined;
    },
  },
  {
    vendor: "Codex",
    readFrom: "`CODEX_CI`, `CODEX_THREAD_ID` or `CODEX_SESSION_ID` set; the session from `CODEX_THREAD_ID`, else `CODEX_SESSION_ID`",
    detect: (env) => !!(set(env.CODEX_CI) ?? set(env.CODEX_THREAD_ID) ?? set(env.CODEX_SESSION_ID)),
    id: (env) => set(env.CODEX_THREAD_ID) ?? set(env.CODEX_SESSION_ID),
    url: () => undefined,
  },
  {
    vendor: "Copilot",
    readFrom: "`COPILOT_AGENT_SESSION_ID` set, with `GITHUB_ACTIONS=true`; the session is that id",
    detect: (env) => env.GITHUB_ACTIONS === "true" && !!set(env.COPILOT_AGENT_SESSION_ID),
    id: (env) => set(env.COPILOT_AGENT_SESSION_ID),
    url: () => undefined,
  },
  {
    vendor: "Cursor",
    readFrom: "`CURSOR_AGENT` or `CURSOR_AGENT_SOCKET` set; no session id",
    detect: (env) => !!(set(env.CURSOR_AGENT) ?? set(env.CURSOR_AGENT_SOCKET)),
    id: () => undefined,
    url: () => undefined,
  },
  {
    vendor: "Gemini CLI",
    readFrom: "`GEMINI_CLI` set; no session id",
    detect: (env) => !!set(env.GEMINI_CLI),
    id: () => undefined,
    url: () => undefined,
  },
];

/** The upload's limits on each label (protocol `sessionLabels`). */
const MAX = { vendor: 100, id: 200, url: 500 };

/**
 * The session labels for this environment, or null when no agent is named. `TESTNOTARY_SESSION_VENDOR`,
 * `TESTNOTARY_SESSION_ID` and `TESTNOTARY_SESSION_URL` each override their own value; `AI_AGENT`
 * names any agent the table doesn't know.
 */
export function detectSession(env: Env): SessionLabels | null {
  const agent = SESSION_AGENTS.find((candidate) => candidate.detect(env));
  const id = set(env.TESTNOTARY_SESSION_ID) ?? agent?.id(env);
  const url = set(env.TESTNOTARY_SESSION_URL) ?? agent?.url(env);
  let vendor = set(env.TESTNOTARY_SESSION_VENDOR) ?? agent?.vendor ?? set(env.AI_AGENT);
  if (!vendor && !id && !url) return null;
  // An id or URL given without any vendor still reaches the record.
  vendor ??= "unknown";
  return { vendor: vendor.slice(0, MAX.vendor), id: id?.slice(0, MAX.id) ?? null, url: url?.slice(0, MAX.url) ?? null };
}
