import { tryGit } from "../../git.ts";
import { CONFIG_FILE } from "../../shared.ts";
import { warn, type RunCheck } from "../context.ts";

/**
 * `local_config_differs`: the working tree's `testnotary.json` isn't the base's. The run uses the
 * base's and ignores this one.
 */
export const localConfigDiffers: RunCheck = {
  name: "local_config_differs",
  async check(context) {
    const same = await tryGit(context.root, ["diff", "--quiet", `refs/remotes/${context.base.ref}`, "--", CONFIG_FILE], context.env);
    if (same !== undefined) return undefined;
    warn(
      context,
      "local_config_differs",
      `${CONFIG_FILE} here differs from ${context.base.ref}'s, which is the one used: the local one is ignored, and a pull request that changes ${CONFIG_FILE} runs CI in full`,
    );
    return undefined;
  },
};
