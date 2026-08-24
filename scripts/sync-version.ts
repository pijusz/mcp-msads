#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_PATH = join(ROOT, "package.json");
const SERVER_PATH = join(ROOT, "server.json");

interface PackageManifest {
  version: string;
  [key: string]: unknown;
}

interface ServerManifest {
  version: string;
  packages: Array<{ version: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function assertVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version "${version}".`);
  }
}

function synchronizedVersions(): { packageVersion: string; serverVersions: string[] } {
  const pkg = readJson<PackageManifest>(PACKAGE_PATH);
  const server = readJson<ServerManifest>(SERVER_PATH);
  return {
    packageVersion: pkg.version,
    serverVersions: [server.version, ...server.packages.map((entry) => entry.version)],
  };
}

function check(): void {
  const { packageVersion, serverVersions } = synchronizedVersions();
  assertVersion(packageVersion);
  if (serverVersions.some((version) => version !== packageVersion)) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, server.json=${serverVersions.join(",")}.`,
    );
  }
  console.log(`Version metadata is synchronized at ${packageVersion}.`);
}

function sync(version: string): void {
  assertVersion(version);
  const pkg = readJson<PackageManifest>(PACKAGE_PATH);
  const server = readJson<ServerManifest>(SERVER_PATH);
  pkg.version = version;
  server.version = version;
  for (const entry of server.packages) entry.version = version;
  writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(SERVER_PATH, `${JSON.stringify(server, null, 2)}\n`);
  check();
}

const argument = process.argv[2];
if (argument === "--check") check();
else if (argument) sync(argument.replace(/^v/, ""));
else throw new Error("Usage: bun scripts/sync-version.ts --check | <version>");
