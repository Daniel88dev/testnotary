// Writes the published JSON schema for `testnotary.json` from the parser's own schema. The web app
// serves it at CONFIG_SCHEMA_URL. Run with `pnpm schema:write` after changing src/config.ts;
// packages/core/test/config-schema.test.ts fails while the published file is stale.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configJsonSchema } from "../src/index.ts";

const target = fileURLToPath(new URL("../../../apps/web/public/schema/v1.json", import.meta.url));
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
