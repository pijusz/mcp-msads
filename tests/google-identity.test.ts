import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authorizeUrlBase, resetAuthForTesting, scopeFor, tokenUrl } from "@/auth/oauth";
import { buildAuthorizeUrl } from "@/auth/setup";
import { isGoogleIdentity, resetEnvForTesting } from "@/config/env";
import { buildHeaders } from "@/services/msads-api";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";

/**
 * Microsoft Advertising accounts can be created with a Google sign-in — which
 * is the only route when a Microsoft account would need an outlook.com address.
 * Such a user cannot be authenticated with an Entra token at all.
 */
let mock: MockFetch;

beforeEach(() => {
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
  mock.always("oauth2.googleapis.com", tokenResponse());
});
afterEach(() => {
  mock.restore();
  setTestEnv();
  resetEnvForTesting();
});

const useGoogle = () => {
  setTestEnv({
    MSADS_IDENTITY_PROVIDER: "google",
    MSADS_CLIENT_ID: "g-client.apps.googleusercontent.com",
  });
  resetEnvForTesting();
  resetAuthForTesting();
};
const useMicrosoft = () => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
};

describe("identity provider selection", () => {
  test("defaults to Microsoft", () => {
    useMicrosoft();
    expect(isGoogleIdentity()).toBe(false);
    expect(tokenUrl()).toContain("login.microsoftonline.com");
  });

  test("switches every endpoint when set to google", () => {
    useGoogle();
    expect(isGoogleIdentity()).toBe(true);
    expect(authorizeUrlBase()).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(tokenUrl()).toBe("https://oauth2.googleapis.com/token");
  });

  test("requests the right scope for each provider", () => {
    useMicrosoft();
    expect(scopeFor()).toContain("msads.manage");
    useGoogle();
    // Google federation only establishes identity; Ads permissions come from
    // the user's role on the account.
    expect(scopeFor()).toBe("profile email");
  });
});

describe("IdentityProvider header", () => {
  test("is absent for Microsoft identity", async () => {
    useMicrosoft();
    const h = await buildHeaders("CustomerManagement");
    expect(h.IdentityProvider).toBeUndefined();
  });

  test("is sent for Google identity", async () => {
    // Without it Microsoft tries to validate a Google token as one of its own
    // and every call fails with error 105.
    useGoogle();
    const h = await buildHeaders("CustomerManagement");
    expect(h.IdentityProvider).toBe("Google");
    expect(h.Authorization).toStartWith("Bearer ");
    // Everything else is unchanged — federation only affects authentication.
    expect(h.DeveloperToken).toBeTruthy();
  });

  test("still applies on account-scoped services", async () => {
    useGoogle();
    const h = await buildHeaders("CampaignManagement", {
      accountId: "1",
      customerId: "2",
    });
    expect(h.IdentityProvider).toBe("Google");
    expect(h.CustomerAccountId).toBe("1");
  });
});

describe("authorize URL", () => {
  const base = {
    clientId: "cid",
    redirectUri: "http://localhost:31544/callback",
    challenge: "chal",
    state: "st",
  };

  test("Microsoft form requests msads.manage and forces the account picker", () => {
    useMicrosoft();
    const u = new URL(buildAuthorizeUrl(base));
    expect(u.origin + u.pathname).toContain("login.microsoftonline.com");
    expect(u.searchParams.get("scope")).toContain("msads.manage");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });

  test("Google form asks for offline access, or no refresh token comes back", () => {
    useGoogle();
    const u = new URL(buildAuthorizeUrl({ ...base, google: true }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe("profile email");
    // Both are required: without them Google returns an access token that
    // expires in an hour and cannot be renewed.
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("select_account consent");
  });

  test("both forms use PKCE", () => {
    useMicrosoft();
    expect(
      new URL(buildAuthorizeUrl(base)).searchParams.get("code_challenge_method"),
    ).toBe("S256");
    useGoogle();
    expect(
      new URL(buildAuthorizeUrl({ ...base, google: true })).searchParams.get(
        "code_challenge_method",
      ),
    ).toBe("S256");
  });

  test("Google form omits response_mode, which is Entra-specific", () => {
    useGoogle();
    expect(
      new URL(buildAuthorizeUrl({ ...base, google: true })).searchParams.get(
        "response_mode",
      ),
    ).toBeNull();
  });
});
