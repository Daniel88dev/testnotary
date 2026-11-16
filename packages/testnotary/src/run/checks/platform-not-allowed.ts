import type { RunCheck } from "../context.ts";

/**
 * `platform_not_allowed`: the base config's `platforms` (Node's spelling, `linux/x64`; a bare OS
 * allows any architecture) doesn't include this machine.
 */
export const platformNotAllowed: RunCheck = {
  name: "platform_not_allowed",
  async check(context) {
    const allowed = context.config.platforms;
    if (!allowed || allowed.length === 0) return undefined;
    const here = `${process.platform}/${process.arch}`;
    if (allowed.some((platform) => platform === process.platform || platform === here)) return undefined;
    return {
      refusal: "platform_not_allowed",
      lines: [
        `this machine is ${here}, and testnotary.json on ${context.base.ref} allows attestations only from ${allowed.join(", ")}`,
        "run the suite on one of those, or change platforms on the base branch",
      ],
    };
  },
};
