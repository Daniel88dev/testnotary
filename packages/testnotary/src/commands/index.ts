// Every `testnotary <command>`: one file per command, one line each here, alphabetical.
import type { Command } from "./command.ts";
import { login } from "./login.ts";
import { logout } from "./logout.ts";
import { whoami } from "./whoami.ts";

export type { Command } from "./command.ts";

export const commands: Record<string, Command> = {
  login,
  logout,
  whoami,
};
