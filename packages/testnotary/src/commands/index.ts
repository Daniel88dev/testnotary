// Every CLI command, one import and one entry each, in alphabetical order. To add a command, write
// `commands/<name>.ts` exporting a `Command` and add one line to each list below.
import type { Command } from "../command.ts";
import { check } from "./check.ts";
import { exec } from "./exec.ts";
import { init } from "./init.ts";
import { login } from "./login.ts";
import { logout } from "./logout.ts";
import { run } from "./run.ts";
import { sandboxKey } from "./sandbox-key.ts";
import { whoami } from "./whoami.ts";

export const commands: readonly Command[] = [
  check,
  exec,
  init,
  login,
  logout,
  run,
  sandboxKey,
  whoami,
];
