import { describe, expect, test } from "bun:test";
import {
  ErrorCode,
  hintForCode,
  MsAdsAuthError,
  MsAdsError,
  parseApiError,
  parseOAuthError,
  readPartialErrors,
} from "@/utils/errors";

describe("parseApiError", () => {
  test("reads an OperationErrors envelope", () => {
    const err = parseApiError(400, {
      OperationErrors: [
        { Code: 105, ErrorCode: "InvalidCredentials", Message: "Authentication failed." },
      ],
      TrackingId: "abc-123",
    });
    expect(err).toBeInstanceOf(MsAdsError);
    expect(err.message).toBe("InvalidCredentials 105: Authentication failed.");
    expect(err.trackingId).toBe("abc-123");
    expect(err.has(ErrorCode.InvalidCredentials)).toBe(true);
  });

  test("reads an Errors envelope", () => {
    const err = parseApiError(400, {
      Errors: [{ Code: 117, ErrorCode: "CallRateExceeded", Message: "Too many calls." }],
    });
    expect(err.has(ErrorCode.CallRateExceeded)).toBe(true);
  });

  test("reads a bare single fault object", () => {
    const err = parseApiError(401, {
      Code: 109,
      ErrorCode: "AuthenticationTokenExpired",
    });
    expect(err.has(ErrorCode.AuthenticationTokenExpired)).toBe(true);
  });

  test("attaches an actionable hint for a known code", () => {
    const err = parseApiError(400, { Errors: [{ Code: 105 }] });
    expect(err.hint).toContain("environment mismatch");
  });

  test("counts additional errors in the message rather than hiding them", () => {
    const err = parseApiError(400, {
      Errors: [
        { Code: 1, ErrorCode: "A", Message: "first" },
        { Code: 2, ErrorCode: "B", Message: "second" },
      ],
    });
    expect(err.message).toContain("(+1 more)");
    expect(err.codes).toEqual([1, 2]);
  });

  test("survives a plain-text error body", () => {
    const err = parseApiError(502, "<html>Bad Gateway</html>");
    expect(err.status).toBe(502);
    expect(err.message).toContain("Bad Gateway");
  });

  test("survives a null body", () => {
    expect(parseApiError(500, null).message).toContain("HTTP 500");
  });

  test("accepts lowercase field spellings", () => {
    const err = parseApiError(400, { errors: [{ code: 106, message: "nope" }] });
    expect(err.has(ErrorCode.UserIsNotAuthorized)).toBe(true);
  });
});

describe("readPartialErrors", () => {
  test("keeps the request index so callers can map failures back to inputs", () => {
    const errs = readPartialErrors({
      PartialErrors: [
        { Index: 2, Code: 1234, ErrorCode: "CampaignServiceInvalidCampaignName" },
      ],
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.index).toBe(2);
    expect(errs[0]?.errorCode).toBe("CampaignServiceInvalidCampaignName");
  });

  test("preserves parent and child indexes from NestedPartialErrors", () => {
    const errs = readPartialErrors({
      NestedPartialErrors: [
        {
          Index: 4,
          BatchErrors: [
            { Index: 0, Code: 1 },
            { Index: 1, Code: 2 },
          ],
        },
        { Index: 9, BatchErrors: [{ Index: 0, Code: 3 }] },
      ],
    });
    expect(errs.map((e) => [e.parent_index, e.index])).toEqual([
      [4, 0],
      [4, 1],
      [9, 0],
    ]);
  });

  test("keeps a nested group that carries no inner BatchErrors", () => {
    const errs = readPartialErrors({ NestedPartialErrors: [{ Index: 7, Code: 9 }] });
    expect(errs[0]?.index).toBe(7);
  });

  test("returns nothing for a clean response", () => {
    expect(readPartialErrors({ CampaignIds: ["1", "2"] })).toEqual([]);
    expect(readPartialErrors(null)).toEqual([]);
  });
});

describe("parseOAuthError", () => {
  test("explains invalid_grant and flags it as needing re-consent", () => {
    const err = parseOAuthError(400, {
      error: "invalid_grant",
      error_description: "The user could not be authenticated or the grant is expired.",
    });
    expect(err).toBeInstanceOf(MsAdsAuthError);
    expect(err.needsReconsent).toBe(true);
    // The device-binding trap is the most common cause for a server deployment.
    expect(err.message).toContain("PUBLIC client");
  });

  test("does not flag other OAuth failures as needing re-consent", () => {
    const err = parseOAuthError(400, { error: "invalid_client" });
    expect(err.needsReconsent).toBe(false);
  });
});

describe("hintForCode", () => {
  test("explains the sandbox/production token mixup", () => {
    expect(hintForCode(105)).toContain("BBD37VB98");
  });

  test("distinguishes 106 as a permissions problem, not a credentials one", () => {
    expect(hintForCode(106)).toContain("permission");
  });

  test("returns nothing for an unknown code", () => {
    expect(hintForCode(999999)).toBeUndefined();
    expect(hintForCode(undefined)).toBeUndefined();
  });
});

describe("nameForCode", () => {
  test("recovers a symbolic name when the API sends only a number", () => {
    const err = parseApiError(401, { Errors: [{ Code: 109 }] });
    expect(err.message).toContain("AuthenticationTokenExpired");
  });

  test("prefers the API's own symbolic code when it sends one", () => {
    const err = parseApiError(401, { Errors: [{ Code: 109, ErrorCode: "TheirName" }] });
    expect(err.message).toContain("TheirName");
  });
});
