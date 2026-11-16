import type { RunCheck } from "../context.ts";

/** The operating systems v1 attests on. WSL reports `linux`, so it counts as Linux. */
const SUPPORTED_OS = ["darwin", "linux"];

/** `platform_unsupported`: v1 attests on macOS and Linux only; Windows is pointed to WSL. */
export const platformUnsupported: RunCheck = {
  name: "platform_unsupported",
  async check() {
    const platform = process.platform;
    if (SUPPORTED_OS.includes(platform)) return undefined;
    if (platform === "win32" || platform === "cygwin") {
      return {
        refusal: "platform_unsupported",
        lines: ["Windows is not supported in v1: run testnotary inside WSL (Windows Subsystem for Linux), which counts as Linux"],
      };
    }
    return { refusal: "platform_unsupported", lines: [`${platform} is not supported in v1: testnotary attests on macOS and Linux only`] };
  },
};
