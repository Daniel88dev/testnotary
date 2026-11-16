// Loaded with `node --import` into a CLI process that `runCli` starts with `system`: the process
// then reports another Node release, LTS line, OS or architecture (`process.version`,
// `process.versions.node`, `process.release.lts`, `process.platform`, `process.arch`), as if it
// ran on that machine. Nothing is installed. The library itself has no hook for this.
import type { SystemOptions } from "./processes.ts";

const fake = JSON.parse(process.env.TESTNOTARY_WORLD_SYSTEM ?? "{}") as SystemOptions;
delete process.env.TESTNOTARY_WORLD_SYSTEM;

function replace(key: "version" | "versions" | "release" | "platform" | "arch", value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, enumerable: true, writable: false });
}

if (fake.node !== undefined) {
  replace("version", fake.node);
  replace("versions", { ...process.versions, node: fake.node.replace(/^v/, "") });
}
if (fake.lts !== undefined) {
  const release: Record<string, unknown> = { ...process.release };
  if (fake.lts === false) delete release.lts;
  else release.lts = fake.lts;
  replace("release", release);
}
if (fake.platform !== undefined) replace("platform", fake.platform);
if (fake.arch !== undefined) replace("arch", fake.arch);
