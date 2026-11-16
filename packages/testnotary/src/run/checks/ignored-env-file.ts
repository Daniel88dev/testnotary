import { basename } from "node:path";
import { tryGit } from "../../git.ts";
import { warn, type RunCheck } from "../context.ts";

const SHOWN = 3;

/**
 * `ignored_env_file`: an ignored `.env` or `.env.*` (other than `.env.example`) exists. The stripped
 * environment leaves it out, but test code that loads it (dotenv) still reads it. A warning only;
 * the file names are printed here and never uploaded. Files inside an ignored directory (such as
 * `node_modules/`) are not looked at.
 */
export const ignoredEnvFile: RunCheck = {
  name: "ignored_env_file",
  async check(context) {
    const ignored = await tryGit(context.root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], context.env);
    const files = (ignored ?? "").split("\0").filter((path) => path.length > 0 && !path.endsWith("/") && isEnvFile(basename(path)));
    if (files.length === 0) return undefined;
    const shown = files.slice(0, SHOWN).join(", ") + (files.length > SHOWN ? `, … and ${files.length - SHOWN} more` : "");
    warn(
      context,
      "ignored_env_file",
      `an ignored .env file exists (${shown}): the stripped environment leaves it out, but test code that loads it (dotenv) still reads it, so local values may shape the result`,
    );
    return undefined;
  },
};

function isEnvFile(name: string): boolean {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}
