import { CONFIG_FILE } from "../../shared.ts";
import { warn, type RunCheck } from "../context.ts";

/** `base_fetch_skipped`: origin couldn't be fetched (offline), so the last fetched base was used. */
export const baseFetchSkipped: RunCheck = {
  name: "base_fetch_skipped",
  async check(context) {
    if (context.base.fetched) return undefined;
    warn(
      context,
      "base_fetch_skipped",
      `couldn't fetch ${context.base.ref} (offline?): using the last fetched ${context.base.ref}, so its ${CONFIG_FILE} and the branch-behind check may be out of date`,
    );
    return undefined;
  },
};
