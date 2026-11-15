import { describe, expect, test } from "vitest";
import { useWorld } from "@testnotary/test-world/vitest";

const world = useWorld();

/** A suite whose command is `node -e <script>`: the script stands in for a test runner. */
function nodeSuite(script: string) {
  return { command: ["node", "-e", script] };
}

function lastLine(text: string): string {
  return text.trimEnd().split("\n").at(-1) ?? "";
}

describe("testnotary exec", () => {
  test("a passing suite exits 0 and ends with the summary line", async () => {
    const repo = await world.fixtureRepo({ config: { suites: { unit: nodeSuite("console.log('tests ok')") } } });
    const commit = await repo.revParse("HEAD");
    const tree = await repo.tree();

    const result = await world.runCli(["exec", "unit"], { cwd: repo.dir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("tests ok\n");
    expect(lastLine(result.stderr)).toBe(`outcome=passed suite=unit attested=false tree=${tree} commit=${commit} url=`);
  });
});
