import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");

function jobBlock(workflow: string, name: string): string {
  const startMarker = `  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  if (start < 0) throw new Error(`Workflow job is missing: ${name}`);
  const rest = workflow.slice(start + startMarker.length);
  const next = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function runSteps(job: string): string[] {
  const commands: string[] = [];
  for (const line of job.split("\n")) {
    const match = line.match(/^ {6}- run: (.+)$/) ?? line.match(/^ {8}run: (.+)$/);
    if (match) commands.push(match[1]!);
  }
  return commands;
}

function expectCredentiallessCheckouts(workflow: string): void {
  const checkout = /^ {6}- uses: actions\/checkout@v4$/gm;
  const matches = [...workflow.matchAll(checkout)];
  expect(matches.length).toBeGreaterThan(0);
  for (const match of matches) {
    const following = workflow.slice(match.index, match.index + 140);
    expect(following).toMatch(
      /^ {6}- uses: actions\/checkout@v4\n {8}with:\n {10}persist-credentials: false/m,
    );
  }
}

describe("release hygiene", () => {
  test("keeps package and MCP registry versions synchronized", () => {
    const pkg = JSON.parse(read("package.json"));
    const server = JSON.parse(read("server.json"));
    expect(server.version).toBe(pkg.version);
    expect(server.packages.map((entry: { version: string }) => entry.version)).toEqual([
      pkg.version,
    ]);
  });

  test("publishes only intended package roots and no stale logo", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(JSON.stringify(pkg)).not.toContain("logo.svg");
  });

  test("CI grants read-only contents, denies checkout credentials, and orders gates", () => {
    const workflow = read(".github/workflows/ci.yml");
    const header = workflow.slice(0, workflow.indexOf("jobs:\n"));
    expect(header).toMatch(/^permissions:\n {2}contents: read$/m);
    expectCredentiallessCheckouts(workflow);

    const lint = jobBlock(workflow, "workflow-lint");
    expect(lint).toContain("- uses: docker://rhysd/actionlint:1.7.7");

    const commands = runSteps(jobBlock(workflow, "test"));
    expect(commands).toEqual([
      "bun install --frozen-lockfile",
      "bun run scan:secrets",
      "bun run test",
      "bun run typecheck",
      "bun run lint",
      "bun run build:npm",
      "bun run verify:package",
    ]);
  });

  test("release waits for binaries and publishes only the verified tarball", () => {
    const workflow = read(".github/workflows/release.yml");
    const header = workflow.slice(0, workflow.indexOf("jobs:\n"));
    expect(header).toMatch(/push:\n {4}tags:\n {6}- "v\*"/);
    expectCredentiallessCheckouts(workflow);

    const publish = jobBlock(workflow, "publish-npm");
    expect(publish).toMatch(/^ {4}needs: build$/m);
    expect(publish).toMatch(/^ {6}id-token: write$/m);
    expect(runSteps(publish)).toEqual([
      "bun install --frozen-lockfile",
      `bun run version:sync "${"$"}{GITHUB_REF_NAME#v}"`,
      "bun run scan:secrets",
      "bun run test",
      "bun run typecheck",
      "bun run lint",
      "bun run build:npm",
      "bun --no-env-file scripts/verify-package.ts --output-dir release-package",
      `if npm view "mcp-msads@${"$"}{GITHUB_REF_NAME#v}" version >/dev/null 2>&1; then echo "Already on npm; skipping publish."; else npm publish release-package/*.tgz --access public --provenance; fi`,
    ]);

    const githubRelease = jobBlock(workflow, "github-release");
    expect(githubRelease).toMatch(/^ {4}needs: \[build, publish-npm\]$/m);
    expect(githubRelease).toContain("softprops/action-gh-release@v2");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("npm publish --access public");
  });
});
