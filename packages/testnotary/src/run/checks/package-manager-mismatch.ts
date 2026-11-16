import { satisfies } from "../../shared.ts";
import type { Refusal, RunCheck, RunContext } from "../context.ts";
import { installAdvice, isSupported, packageManagerUse, throughPackageManager, versionInUse, type SupportedPackageManager, type VersionInUse } from "../floor/package-manager.ts";
import { project } from "../floor/project.ts";

/**
 * `package_manager_mismatch`: the package manager a command here would get isn't the one
 * `package.json` pins: `packageManager`'s exact version (its `+sha…` ignored), else
 * `devEngines.packageManager`'s range. Neither: *package manager not pinned*. The version is read
 * without running the tool (see `versionInUse`); the run's record carries it.
 */
export const packageManagerMismatch: RunCheck = {
  name: "package_manager_mismatch",
  async check(context) {
    const use = await packageManagerUse(context);
    const { manifest, lockfiles } = await project(context);
    const { pin } = use;
    if (pin && pin.name === undefined) {
      return { refusal: "package_manager_mismatch", lines: [`packageManager in package.json is "${pin.text}", not <name>@<version> such as pnpm@10.34.9`] };
    }
    if (use.name === undefined) {
      if (manifest) context.notes.notPinned.push("package_manager");
      return undefined;
    }
    // Anything else was refused as package_manager_unsupported already.
    if (!isSupported(use.name)) return undefined;
    const name = use.name;

    if (pin?.source === "packageManager") {
      const found = await versionInUse(context, name, pin.version);
      record(context, name, found);
      if (found.kind === "found" && found.version === pin.version) return undefined;
      return refuse(name, `packageManager in package.json pins ${name}@${pin.version}`, pin.version, found);
    }
    if (pin?.source === "devEngines.packageManager" && pin.range !== undefined) {
      const found = await versionInUse(context, name, undefined);
      record(context, name, found);
      if (found.kind === "found" && satisfies(found.version, pin.range) === true) return undefined;
      return refuse(name, `devEngines.packageManager in package.json asks for ${name} ${pin.range}`, pin.range, found);
    }
    if (manifest || lockfiles.length > 0) {
      context.notes.notPinned.push("package_manager");
      record(context, name, await versionInUse(context, name, undefined));
    }
    return undefined;
  },
};

function record(context: RunContext, name: string, found: VersionInUse): void {
  context.notes.packageManager = found.kind === "found" ? { name, version: found.version } : null;
}

function refuse(name: SupportedPackageManager, wants: string, version: string, found: VersionInUse): Refusal {
  const advice = installAdvice(name, version);
  switch (found.kind) {
    case "found":
      return { refusal: "package_manager_mismatch", lines: [`${wants}, but this run would use ${name} ${found.version} (${found.how})`, advice] };
    case "not_on_path":
      return { refusal: "package_manager_mismatch", lines: [`${wants}, but ${name} is not on PATH`, advice] };
    case "unknown":
      return {
        refusal: "package_manager_mismatch",
        lines: [
          `${wants}, but the version of ${found.path} can't be read without running it, and testnotary never runs a package manager`,
          `run testnotary through ${name} (\`${throughPackageManager(name)}\`), which tells it the version, or ${advice}`,
        ],
      };
  }
}
