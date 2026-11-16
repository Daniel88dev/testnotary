// Agent sandbox markers. With any of them a laptop token and `login` are refused, with no
// override: a sandbox uses a sandbox token instead. The list ships with the library and updates
// with its releases; the docs list the same entries.

type Env = Readonly<Record<string, string | undefined>>;

export interface SandboxMarker {
  /** How the library names the marker it found. */
  name: string;
  /** The condition as the docs write it; backticks mark code. */
  condition: string;
  present(env: Env, fileExists: (path: string) => boolean): boolean;
}

export const SANDBOX_MARKERS: readonly SandboxMarker[] = [
  { name: "CLAUDE_CODE_REMOTE", condition: "`CLAUDE_CODE_REMOTE=true`", present: (env) => env.CLAUDE_CODE_REMOTE === "true" },
  { name: "CURSOR_AGENT_SOCKET", condition: "`CURSOR_AGENT_SOCKET` is set", present: (env) => !!env.CURSOR_AGENT_SOCKET },
  { name: "GITHUB_ACTIONS", condition: "`GITHUB_ACTIONS=true`", present: (env) => env.GITHUB_ACTIONS === "true" },
  { name: "TESTNOTARY_SANDBOX", condition: "`TESTNOTARY_SANDBOX=1`", present: (env) => env.TESTNOTARY_SANDBOX === "1" },
  {
    name: "HOME=/home/jules",
    condition: "`HOME=/home/jules` with `USER=swebot`",
    present: (env) => env.HOME === "/home/jules" && env.USER === "swebot",
  },
  { name: "/opt/.devin", condition: "the file `/opt/.devin` exists", present: (_env, fileExists) => fileExists("/opt/.devin") },
];
