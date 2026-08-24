#!/usr/bin/env bun
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Copy a Google OAuth client id and secret out of a `credentials.json` into
 * `.env`, without printing either value.
 *
 * Google OAuth clients are reusable across projects: scopes are chosen per
 * authorization, not baked into the client. So the client already sitting in
 * mcp-gsc or mcp-gads works here — only the scopes we request differ.
 *
 *   bun scripts/import-google-credentials.ts ../mcp-gsc/credentials.json
 */

const source = process.argv[2] ?? "../mcp-gsc/credentials.json";
const envPath = resolve(process.argv[3] ?? ".env");
const absolute = resolve(source);

if (!existsSync(absolute)) {
  console.error(`  Not found: ${absolute}`);
  process.exit(1);
}

interface ClientBlock {
  client_id?: string;
  client_secret?: string;
  project_id?: string;
}

const raw = JSON.parse(readFileSync(absolute, "utf-8")) as Record<string, ClientBlock>;
// Google writes the client under "installed" (Desktop app) or "web".
const kind = raw.installed ? "installed" : raw.web ? "web" : null;
const client = kind ? raw[kind] : undefined;

if (!client?.client_id || !client.client_secret) {
  console.error(
    `  ${absolute} has no OAuth client. Expected an "installed" or "web" block ` +
      "with client_id and client_secret.",
  );
  process.exit(1);
}

if (!existsSync(envPath)) {
  console.error(`  Not found: ${envPath}`);
  process.exit(1);
}

const lines = readFileSync(envPath, "utf-8").split("\n");
const set = (key: string, value: string) => {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
};

set("MSADS_CLIENT_ID", client.client_id);
set("MSADS_CLIENT_SECRET", client.client_secret);
set("MSADS_IDENTITY_PROVIDER", "google");
writeFileSync(envPath, lines.join("\n"));
chmodSync(envPath, 0o600);

// Report shape only — neither value is echoed.
console.log(`\n  Imported from ${absolute}`);
console.log(
  `    client type   : ${kind === "installed" ? "Desktop app" : "Web application"}`,
);
console.log(`    project       : ${client.project_id ?? "(none)"}`);
console.log(`    client id     : set, ${client.client_id.length} chars`);
console.log(`    client secret : set, ${client.client_secret.length} chars`);
console.log(`  Written to ${envPath}, with MSADS_IDENTITY_PROVIDER=google.\n`);

if (kind === "installed") {
  console.log(
    "  This is a Desktop app client, which is what you want here: Google accepts\n" +
      "  any loopback port for these without pre-registering it, so no change is\n" +
      "  needed in the Cloud Console.\n\n" +
      "  Note the public-client warning from the Microsoft setup does NOT apply to\n" +
      "  Google. Device-bound refresh tokens are an Entra behaviour; Google refresh\n" +
      "  tokens work from anywhere.\n",
  );
} else {
  console.log(
    `  This is a Web application client, so http://localhost:31544/callback must be\n` +
      "  listed under Authorized redirect URIs in the Google Cloud Console.\n",
  );
}
console.log(
  "  Next: bun run setup — sign in with the Google account that owns the sandbox.\n",
);
