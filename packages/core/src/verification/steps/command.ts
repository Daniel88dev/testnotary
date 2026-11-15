import type { VerificationStep } from "../context.ts";

/**
 * The attested run's command must equal the suite's command in the config at the built commit's
 * first parent, argument for argument. An attestation whose payload has no readable command never
 * equals it.
 */
export const commandStep: VerificationStep = {
  name: "command",
  async decide(state) {
    const attested = state.attestation!.command;
    const expected = state.suite!.command;
    const same = attested.length === expected.length && attested.every((arg, i) => arg === expected[i]);
    return same ? undefined : "command_changed";
  },
};
