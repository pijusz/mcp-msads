#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROMPT_NAMES, RESOURCE_TEMPLATES, TOOL_NAMES } from "../tests/expected-manifest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NETWORK_DENY = join(ROOT, "scripts", "network-deny.mjs");
const EXPECTED_FILES = ["LICENSE", "README.md", "dist/index.js", "package.json"];

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

interface PackageManifest {
  version: string;
  bin?: Record<string, string>;
}

function credentialDenyEnv(cwd: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith("MSADS_") &&
        entry[0] !== "NODE_OPTIONS" &&
        entry[1] !== undefined,
    ),
  );
  return {
    ...env,
    HOME: cwd,
    USERPROFILE: cwd,
    XDG_CONFIG_HOME: cwd,
    NODE_OPTIONS: `--import=${pathToFileURL(NETWORK_DENY).href}`,
    MSADS_ENV_FILE: join(cwd, "missing.env"),
    MSADS_LOG_LEVEL: "error",
    MSADS_RUN_LIVE_TESTS: "false",
    MSADS_VALIDATE_AT_STARTUP: "false",
    MSADS_DEVELOPER_TOKEN: "",
    MSADS_CLIENT_ID: "",
    MSADS_CLIENT_SECRET: "",
    MSADS_REFRESH_TOKEN: "",
    MSADS_TOKEN_FILE: "",
    MSADS_ACCOUNT_ID: "",
    MSADS_CUSTOMER_ID: "",
  };
}

function verifyVersions(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8")) as {
    version: string;
    packages: Array<{ version: string }>;
  };
  const versions = [server.version, ...server.packages.map((entry) => entry.version)];
  if (versions.some((version) => version !== pkg.version)) {
    throw new Error(
      `Version mismatch: package.json=${pkg.version}, server.json=${versions.join(",")}.`,
    );
  }
  return pkg.version;
}

function outputDirectory(tempRoot: string): { path: string; retained: boolean } {
  const args = process.argv.slice(2);
  if (args.length === 0) return { path: join(tempRoot, "packed"), retained: false };
  if (args.length !== 2 || args[0] !== "--output-dir" || !args[1]) {
    throw new Error("Usage: verify-package.ts [--output-dir <empty-directory>]");
  }
  const path = resolve(args[1]);
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`Package output directory must be empty: ${path}`);
  }
  return { path, retained: true };
}

function createTarball(outputDir: string): { tarball: string; files: string[] } {
  mkdirSync(outputDir, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = Bun.spawnSync(
    [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", outputDir],
    {
      cwd: ROOT,
      env: credentialDenyEnv(outputDir),
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  if (packed.exitCode !== 0) {
    throw new Error(`npm pack failed: ${packed.stderr.toString().trim()}`);
  }
  const result = (JSON.parse(packed.stdout.toString()) as PackResult[])[0];
  if (!result?.filename) throw new Error("npm pack did not report a tarball filename.");
  const files = (result.files ?? []).map((file) => file.path).sort();
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_FILES)) {
    throw new Error(
      `Unexpected npm package contents. Expected ${EXPECTED_FILES.join(", ")}; got ${files.join(", ")}.`,
    );
  }
  const tarball = join(outputDir, result.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}.`);
  return { tarball, files };
}

function extractTarball(tarball: string, tempRoot: string): string {
  const extractRoot = join(tempRoot, "extracted");
  mkdirSync(extractRoot);
  const extracted = Bun.spawnSync(["tar", "-xzf", tarball, "-C", extractRoot], {
    cwd: tempRoot,
    env: credentialDenyEnv(tempRoot),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (extracted.exitCode !== 0) {
    throw new Error(
      `Could not extract npm tarball: ${extracted.stderr.toString().trim()}`,
    );
  }
  return join(extractRoot, "package");
}

function declaredBin(packageRoot: string, version: string): string {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  if (manifest.version !== version) {
    throw new Error(
      `Packed version mismatch: expected ${version}, got ${manifest.version}.`,
    );
  }
  const relativeBin = manifest.bin?.["mcp-msads"];
  if (!relativeBin) throw new Error("Packed package does not declare the mcp-msads bin.");
  const bin = resolve(packageRoot, relativeBin);
  if (!bin.startsWith(`${resolve(packageRoot)}${sep}`) || !existsSync(bin)) {
    throw new Error(
      `Packed mcp-msads bin is missing or escapes the package: ${relativeBin}`,
    );
  }
  return bin;
}

async function verifyStartup(version: string, entrypoint: string): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-msads-package-run-"));
  const env = credentialDenyEnv(cwd);
  try {
    const versionRun = Bun.spawnSync(["node", entrypoint, "--version"], {
      cwd,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    if (versionRun.exitCode !== 0) {
      throw new Error(
        `Packed bin --version failed: ${versionRun.stderr.toString().trim()}`,
      );
    }
    const stdout = versionRun.stdout.toString();
    if (stdout !== `mcp-msads v${version}\n`) {
      throw new Error(
        `Packed bin --version wrote unexpected stdout: ${JSON.stringify(stdout)}`,
      );
    }

    const transport = new StdioClientTransport({
      command: "node",
      args: [entrypoint],
      cwd,
      env,
    });
    const client = new Client({ name: "package-verifier", version: "1.0.0" });
    try {
      await client.connect(transport);
      const [tools, resources, prompts] = await Promise.all([
        client.listTools(),
        client.listResourceTemplates(),
        client.listPrompts(),
      ]);
      const toolNames = tools.tools.map((tool) => tool.name).sort();
      const resourceTemplates = resources.resourceTemplates
        .map((resource) => resource.uriTemplate)
        .sort();
      const promptNames = prompts.prompts.map((prompt) => prompt.name).sort();
      if (JSON.stringify(toolNames) !== JSON.stringify(TOOL_NAMES)) {
        throw new Error(`Packed tool manifest differs: ${toolNames.join(", ")}.`);
      }
      if (JSON.stringify(resourceTemplates) !== JSON.stringify(RESOURCE_TEMPLATES)) {
        throw new Error(
          `Packed resource manifest differs: ${resourceTemplates.join(", ")}.`,
        );
      }
      if (JSON.stringify(promptNames) !== JSON.stringify(PROMPT_NAMES)) {
        throw new Error(`Packed prompt manifest differs: ${promptNames.join(", ")}.`);
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const version = verifyVersions();
const tempRoot = mkdtempSync(join(tmpdir(), "mcp-msads-package-verify-"));
const output = outputDirectory(tempRoot);
let tarball = "";
try {
  const packed = createTarball(output.path);
  tarball = packed.tarball;
  const packageRoot = extractTarball(tarball, tempRoot);
  await verifyStartup(version, declaredBin(packageRoot, version));
  console.log(
    `Package verified at ${version}: ${packed.files.length} files and exact manifests for ${TOOL_NAMES.length} tools, ${RESOURCE_TEMPLATES.length} resources, and ${PROMPT_NAMES.length} prompts${output.retained ? `; tarball ${tarball}` : ""}.`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
