// Writes the published JSON schema for `testnotary.json` from the parser's own schema. The web app
// serves it at CONFIG_SCHEMA_URL. Run with `pnpm schema:write` after changing src/config.ts. With
// `--check` (`pnpm schema:check`, part of `pnpm lint`) it writes nothing and fails while the
// published file is stale.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configJsonSchema } from "../src/index.ts";

const target = fileURLToPath(new URL("../../../apps/web/public/schema/v1.json", import.meta.url));
const text = `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const published = await readFile(target, "utf8").catch(() => "");
  if (published !== text) {
    process.stderr.write(`${target} is not the parser's schema: run \`pnpm schema:write\`\n`);
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  process.stdout.write(`wrote ${target}\n`);
}
