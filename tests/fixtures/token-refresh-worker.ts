import { refreshAccessToken, resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";

const [tokenPath, workerId, delayText] = process.argv.slice(2);
if (!tokenPath || !workerId) throw new Error("token path and worker id are required");

for (const key of Object.keys(process.env)) {
  if (key.startsWith("MSADS_")) delete process.env[key];
}
Object.assign(process.env, {
  MSADS_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  MSADS_TOKEN_FILE: tokenPath,
  MSADS_ENV_FILE: "/nonexistent-so-dotenv-is-skipped",
  MSADS_REQUEST_TIMEOUT_MS: "2000",
});
resetEnvForTesting();
resetAuthForTesting();

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const form = new URLSearchParams(String(init?.body ?? ""));
  const refreshToken = form.get("refresh_token");
  if (!refreshToken) throw new Error("refresh token missing from request");
  await Bun.sleep(Number(delayText ?? "0"));
  return Response.json({
    access_token: `synthetic-access-${workerId}`,
    refresh_token: `${refreshToken}-${workerId}`,
    expires_in: 3600,
    scope: "https://ads.microsoft.com/msads.manage",
  });
}) as typeof fetch;

await refreshAccessToken();
