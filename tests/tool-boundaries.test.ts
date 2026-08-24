import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import { createServer } from "@/server";
import { cacheClear } from "@/services/cache";
import { assertAllowedRawRead, canonicalRawPath } from "@/tools/raw";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";

let mock: MockFetch;

beforeEach(() => {
  setTestEnv({ MSADS_ACCOUNT_ID: "123", MSADS_CUSTOMER_ID: "456" });
  resetEnvForTesting();
  resetAuthForTesting();
  cacheClear();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});

afterEach(() => mock.restore());

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "boundary-test", version: "1.0.0" });
  const server: McpServer = createServer();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function toolPayload(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  return JSON.parse(text);
}

function resourcePayload(result: Awaited<ReturnType<Client["readResource"]>>): unknown {
  return JSON.parse((result.contents[0] as { text: string }).text);
}

describe("raw operation boundary", () => {
  test("canonicalizes one leading slash and rejects alternate path syntax", () => {
    expect(canonicalRawPath(" /Campaigns/QueryByAccountId ")).toBe(
      "Campaigns/QueryByAccountId",
    );
    for (const path of [
      "Campaigns//QueryByIds",
      "Campaigns/../UetTagAuthKey/Query",
      "Campaigns/Query?x=1",
      "Campaigns/Query#x",
      "Campaigns/%2e%2e/Query",
      "Campaigns/Campaigns/Query",
    ]) {
      expect(() => canonicalRawPath(path), path).toThrow();
    }
  });

  test("keeps asynchronous job submissions off the idempotent raw-read surface", () => {
    for (const [service, path] of [
      ["Reporting", "GenerateReport/Submit"],
      ["Bulk", "Campaigns/DownloadByAccountIds"],
      ["Bulk", "Campaigns/DownloadByCampaignIds"],
    ] as const) {
      expect(() => assertAllowedRawRead(service, path)).toThrow(/not allowlisted/);
    }
    expect(() => assertAllowedRawRead("Reporting", "GenerateReport/Poll")).not.toThrow();
  });

  test("rejects an unknown raw read before any fetch", async () => {
    const result = await withClient((client) =>
      client.callTool({
        name: "msads_raw_read",
        arguments: {
          service: "CampaignManagement",
          path: "Campaigns/DefinitelyRead",
          body: {},
        },
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(toolPayload(result))).toMatch(/not allowlisted/i);
    expect(mock.calls).toHaveLength(0);
  });

  test("calls an exact allowlisted pair as a retry-safe POST", async () => {
    mock.queue("Campaigns/QueryByAccountId", { json: { Campaigns: [{ Id: "9" }] } });
    const result = await withClient((client) =>
      client.callTool({
        name: "msads_raw_read",
        arguments: {
          service: "CampaignManagement",
          path: "/Campaigns/QueryByAccountId",
          body: { AccountId: "123" },
          account_id: "123",
          customer_id: "456",
        },
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(toolPayload(result)).toEqual({
      discovered: 1,
      showing: 1,
      truncated: false,
      Campaigns: [{ Id: "9" }],
    });
    const call = mock.callsTo("Campaigns/QueryByAccountId")[0];
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ AccountId: "123" });
  });

  test("fails closed when an explicit raw account scope is invalid", async () => {
    const result = await withClient((client) =>
      client.callTool({
        name: "msads_raw_mutation",
        arguments: {
          service: "CampaignManagement",
          path: "Campaigns",
          method: "DELETE",
          body: { CampaignIds: ["9"] },
          // An account NUMBER, not an id — the shape the guard must reject.
          account_id: "X00000X0",
        },
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(toolPayload(result))).toMatch(/account \*number\*/i);
    expect(mock.calls).toHaveLength(0);
  });

  test("allows genuinely unscoped raw reads without account arguments", async () => {
    mock.queue("User/Query", { json: { User: { Id: "7" } } });
    const result = await withClient((client) =>
      client.callTool({
        name: "msads_raw_read",
        arguments: {
          service: "CustomerManagement",
          path: "User/Query",
          body: {},
        },
      }),
    );
    expect(result.isError).toBeFalsy();
    const call = mock.callsTo("User/Query")[0];
    expect(call?.headers.customeraccountid).toBeUndefined();
    expect(call?.headers.customerid).toBeUndefined();
  });

  test("denies the credential-returning path across both raw tools pre-fetch", async () => {
    await withClient(async (client) => {
      for (const request of [
        {
          name: "msads_raw_read",
          arguments: {
            service: "CampaignManagement",
            path: "UetTagAuthKey/Query",
            body: { UetTagId: "1" },
          },
        },
        {
          name: "msads_raw_mutation",
          arguments: {
            service: "CampaignManagement",
            path: "UetTagAuthKey/Query",
            method: "POST",
            body: { UetTagId: "1" },
          },
        },
        {
          name: "msads_raw_mutation",
          arguments: {
            service: "CampaignManagement",
            path: "uettagauthkey/query",
            method: "POST",
            body: { UetTagId: "1" },
          },
        },
      ]) {
        const result = await client.callTool(request);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(toolPayload(result))).toMatch(/reusable credential/i);
      }
    });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("conditional mutation tools", () => {
  test("customer-list tools send fixed actions with no caller-selectable mode", async () => {
    mock.queue("CustomerListUserData/Apply", { json: {} }, { json: {} }, { json: {} });
    await withClient(async (client) => {
      for (const name of [
        "add_customer_list_members",
        "remove_customer_list_members",
        "replace_customer_list_members",
      ]) {
        const result = await client.callTool({
          name,
          arguments: { account_id: "123", audience_id: "77", emails: ["a@example.com"] },
        });
        expect(result.isError, name).toBeFalsy();
      }
    });
    const actions = mock
      .callsTo("CustomerListUserData/Apply")
      .map(
        (call) =>
          (
            (call.body as Record<string, any>).CustomerListUserData as Record<
              string,
              unknown
            >
          ).ActionType,
      );
    expect(actions).toEqual(["Add", "Remove", "Replace"]);
  });

  test("ordinary imports default paused without deletion mirroring", async () => {
    mock.queue(
      "/ImportJobs",
      { json: { ImportJobIds: ["1"] } },
      { json: { ImportJobIds: ["2"] } },
    );
    await withClient(async (client) => {
      const args = {
        account_id: "123",
        name: "Import",
        credential_id: "credential-1",
        google_account_id: "999",
      };
      expect(
        (await client.callTool({ name: "create_google_import", arguments: args }))
          .isError,
      ).toBeFalsy();
      expect(
        (
          await client.callTool({
            name: "create_google_import_with_deletion_mirroring",
            arguments: args,
          })
        ).isError,
      ).toBeFalsy();
    });

    const options = mock.callsTo("/ImportJobs").map((call) => {
      const jobs = (call.body as Record<string, any>).ImportJobs as Array<
        Record<string, any>
      >;
      return jobs[0]?.ImportOption;
    });
    expect(options).toEqual([
      {
        NewPausedCampaignsAndChildEntities: true,
        DeleteRemovedEntities: false,
        Type: "GoogleImportOption",
      },
      {
        NewPausedCampaignsAndChildEntities: true,
        DeleteRemovedEntities: true,
        Type: "GoogleImportOption",
      },
    ]);
  });

  test("ordinary imports reject attempts to smuggle deletion mirroring", async () => {
    const result = await withClient((client) =>
      client.callTool({
        name: "create_google_import",
        arguments: {
          account_id: "123",
          name: "Import",
          credential_id: "credential-1",
          google_account_id: "999",
          import_option: { DeleteRemovedEntities: true },
        },
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(toolPayload(result))).toMatch(/controlled by the selected/i);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("internal CAPI credential", () => {
  const SECRET = "secret-capi-key-never-public";
  const event = {
    event_type: "custom",
    event_name: "purchase",
    msclkid: "click-1",
  };

  test("authorizes the account, fetches the key internally, and omits it from output", async () => {
    mock.queue("UetTagAuthKey/Query", { json: { UetTagAuthKey: SECRET } });
    mock.queue("capi.uet.microsoft.com", {
      json: { errors: [{ isWarning: true, message: `provider echoed ${SECRET}` }] },
    });

    const result = await withClient((client) =>
      client.callTool({
        name: "send_conversion_events",
        arguments: { account_id: "123", tag_id: "88", events: [event] },
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).toContain("[redacted]");

    const keyCall = mock.callsTo("UetTagAuthKey/Query")[0];
    expect(keyCall?.body).toEqual({ UetTagId: "88" });
    expect(keyCall?.headers.customeraccountid).toBe("123");
    const capiCall = mock.callsTo("capi.uet.microsoft.com")[0];
    expect(capiCall?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(capiCall?.body)).not.toContain(SECRET);
  });

  test("redacts an echoed key from public errors", async () => {
    mock.queue("UetTagAuthKey/Query", { json: { UetTagAuthKey: SECRET } });
    mock.queue("capi.uet.microsoft.com", {
      status: 400,
      json: { errors: [{ message: `invalid ${SECRET}` }] },
    });
    const result = await withClient((client) =>
      client.callTool({
        name: "send_conversion_events",
        arguments: { account_id: "123", tag_id: "88", events: [event] },
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).toContain("[redacted]");
  });
});

describe("strict resource validation", () => {
  test("rejects unknown params, URI conflicts, invalid scalars/enums/ranges, and missing fields pre-fetch", async () => {
    const cases: Array<[string, RegExp]> = [
      ["msads://accounts?unknown=1", /unknown resource query parameter/i],
      [
        "msads://account/123/campaigns?account_id=456",
        /conflicts with the value in the URI path/i,
      ],
      ["msads://customer/456/accounts?only_parent_accounts=yes", /invalid input/i],
      ["msads://accounts?limit=0", /too small|greater than or equal to 1/i],
      ["msads://account/123/campaigns?campaign_type=NotAType", /invalid option/i],
      ["msads://account/123/spend", /year|month/i],
      ["msads://accounts?limit=1&limit=2", /may only appear once/i],
    ];

    await withClient(async (client) => {
      for (const [uri, expected] of cases) {
        const payload = resourcePayload(await client.readResource({ uri }));
        expect(payload, uri).toHaveProperty("error");
        expect(JSON.stringify(payload), uri).toMatch(expected);
      }
    });
    expect(mock.calls).toHaveLength(0);
  });

  test("tool schemas reject unknown arguments too", async () => {
    const result = await withClient((client) =>
      client.callTool({ name: "msads_api_info", arguments: { extra: true } }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/unrecognized key|invalid arguments/i);
    expect(mock.calls).toHaveLength(0);
  });
});
