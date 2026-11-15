import { existsSync } from "node:fs";

// Agent sandbox markers. With any of them a laptop token and `login` are refused, with no
// override: a sandbox uses a sandbox token instead. The list ships with the library.

type Env = Readonly<Record<string, string | undefined>>;

/** The first sandbox marker present, by name, or undefined on an ordinary machine. */
export function sandboxMarker(env: Env, fileExists: (path: string) => boolean = existsSync): string | undefined {
  if (env.CLAUDE_CODE_REMOTE === "true") return "CLAUDE_CODE_REMOTE";
  if (env.CURSOR_AGENT_SOCKET) return "CURSOR_AGENT_SOCKET";
  if (env.GITHUB_ACTIONS === "true") return "GITHUB_ACTIONS";
  if (env.TESTNOTARY_SANDBOX === "1") return "TESTNOTARY_SANDBOX";
  if (env.HOME === "/home/jules" && env.USER === "swebot") return "HOME=/home/jules";
  if (fileExists("/opt/.devin")) return "/opt/.devin";
  return undefined;
}
