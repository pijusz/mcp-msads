#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SecretLocation {
  path: string;
  line: number;
  key: string;
}

interface SecretPattern {
  expression: RegExp;
  key(match: RegExpExecArray): string;
}

const PATTERNS: SecretPattern[] = [
  {
    expression: /"(access_token|refresh_token|client_secret)"\s*:\s*"([^"\r\n]{16,})"/gi,
    key: (match) => match[1] ?? "oauth-json-field",
  },
  {
    expression: /\b1\/\/[A-Za-z0-9._~-]{20,}\b/g,
    key: () => "google-refresh-token",
  },
  {
    expression: /\bM\.[A-Za-z0-9._~+/-]{20,}={0,2}\b/g,
    key: () => "microsoft-refresh-token",
  },
];

function trackedFiles(root: string): string[] {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("Could not enumerate tracked files with git ls-files");
  }
  return result.stdout.split("\0").filter(Boolean);
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function scanTrackedFiles(root = process.cwd()): SecretLocation[] {
  const absoluteRoot = resolve(root);
  const findings: SecretLocation[] = [];

  for (const path of trackedFiles(absoluteRoot)) {
    const bytes = readFileSync(join(absoluteRoot, path));
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const pattern of PATTERNS) {
      pattern.expression.lastIndex = 0;
      for (
        let match = pattern.expression.exec(text);
        match;
        match = pattern.expression.exec(text)
      ) {
        findings.push({ path, line: lineAt(text, match.index), key: pattern.key(match) });
      }
    }
  }

  return findings;
}

function main(): number {
  const findings = scanTrackedFiles();
  if (findings.length === 0) {
    console.log("Secret scan passed: no token-shaped content in tracked files.");
    return 0;
  }

  console.error("Secret scan failed. Suspect tracked locations:");
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}:${finding.key}`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
