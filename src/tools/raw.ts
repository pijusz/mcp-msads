import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEnv } from "@/config/env";
import { resolveAccount } from "@/services/accounts";
import {
  isAccountScoped,
  msadsFetch,
  SERVICE_NAMES,
  type ServiceName,
  serviceBaseUrl,
} from "@/services/msads-api";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
} from "@/utils/collection";
import { readPartialErrors } from "@/utils/errors";
import { destructiveTool, readTool } from "@/utils/register-tool";
import { run } from "@/utils/tool-response";

/**
 * Escape hatch for reviewed API operations that do not have dedicated tools.
 * Raw reads are a literal allowlist because Microsoft uses POST for both reads
 * and writes; a verb or path suffix cannot establish safety.
 */

const PATH_GUIDE = `Path is everything after the /v13/ segment, e.g. "Campaigns/QueryByAccountId".

REST naming: Add is POST to the bare resource ("Campaigns"), Update is PUT to it, Delete is DELETE to it, and reads are usually POST to a verb suffix ("Campaigns/QueryByAccountId", "Accounts/Search", "AccountsOrCustomersInfo/Find"). Reads are POST with a JSON body, never GET.

Two things that catch people out:
- 64-bit ids are JSON strings, not numbers: {"AccountId": "123"}.
- Derived types carry a "Type" discriminator: {"Type": "MaxConversionsBiddingScheme"}.

Customer Management and Customer Billing must not receive account headers; this tool omits them for those services automatically.`;

const RAW_READ_PAIRS = [
  ["CustomerManagement", "User/Query"],
  ["CustomerManagement", "AccountsInfo/Query"],
  ["CustomerManagement", "Accounts/Search"],
  ["CustomerManagement", "AccountsOrCustomersInfo/Find"],
  ["CustomerManagement", "CustomersInfo/Query"],
  ["CustomerManagement", "Account/Query"],
  ["CampaignManagement", "Campaigns/QueryByAccountId"],
  ["CampaignManagement", "Campaigns/QueryByIds"],
  ["CampaignManagement", "AdGroups/QueryByCampaignId"],
  ["CampaignManagement", "AdGroups/QueryByIds"],
  ["CampaignManagement", "Ads/QueryByAdGroupId"],
  ["CampaignManagement", "Keywords/QueryByAdGroupId"],
  ["CampaignManagement", "Budgets/QueryByIds"],
  ["CampaignManagement", "CampaignCriterions/QueryByIds"],
  ["CampaignManagement", "AdGroupCriterions/QueryByIds"],
  ["CampaignManagement", "ProfileDataFileUrl/Query"],
  ["CampaignManagement", "Companies/Search"],
  ["CampaignManagement", "GeoLocationsFileUrl/Query"],
  ["CampaignManagement", "Audiences/QueryByIds"],
  ["CampaignManagement", "AdExtensions/QueryByIds"],
  ["CampaignManagement", "AdExtensionIds/QueryByAccountId"],
  ["CampaignManagement", "AdExtensionsAssociations/Query"],
  ["CampaignManagement", "NegativeKeywords/QueryByEntityIds"],
  ["CampaignManagement", "SharedEntities/QueryByAccountId"],
  ["CampaignManagement", "Labels/QueryByIds"],
  ["CampaignManagement", "LabelAssociations/QueryByEntityIds"],
  ["CampaignManagement", "UetTags/QueryByIds"],
  ["CampaignManagement", "ConversionGoals/QueryByIds"],
  ["CampaignManagement", "ConversionGoals/QueryByTagIds"],
  ["CampaignManagement", "ImportJobs/QueryByIds"],
  ["CampaignManagement", "ImportResults/Query"],
  ["CampaignManagement", "ImportEntityIdsMapping/Query"],
  ["Reporting", "GenerateReport/Poll"],
  ["Bulk", "BulkDownloadStatus/Query"],
  ["Bulk", "BulkUploadStatus/Query"],
  ["AdInsight", "KeywordIdeas/Query"],
  ["AdInsight", "KeywordTrafficEstimates/Query"],
  ["AdInsight", "KeywordSuggestions/QueryByUrl"],
  ["AdInsight", "HistoricalSearchCount/Query"],
  ["AdInsight", "BidLandscape/QueryByKeywordIds"],
  ["AdInsight", "AuctionInsightData/Query"],
  ["CustomerBilling", "AccountMonthlySpend/Query"],
  ["CustomerBilling", "InsertionOrders/Search"],
  ["CustomerBilling", "BillingDocumentsInfo/Query"],
] as const satisfies readonly (readonly [ServiceName, string])[];

const RAW_READ_ALLOWLIST = new Set(
  RAW_READ_PAIRS.map(([service, path]) => `${service}\0${path}`),
);

const SENSITIVE_PATHS = new Set(["uettagauthkey/query"]);

/** Normalize the documented path form while rejecting alternate URL syntax. */
export function canonicalRawPath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith("//")) {
    throw new Error("Raw paths cannot contain duplicate slash separators.");
  }
  if (path.startsWith("/")) path = path.slice(1);
  if (!path) throw new Error("Raw path is required.");
  if (path.includes("?") || path.includes("#")) {
    throw new Error("Raw paths cannot contain a query string or fragment.");
  }
  if (path.includes("//")) {
    throw new Error("Raw paths cannot contain duplicate slash separators.");
  }
  if (path.includes("%") || path.includes("\\")) {
    throw new Error("Raw paths cannot contain encoded or backslash separators.");
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Raw paths cannot contain traversal segments.");
  }
  if (segments.some((segment) => !/^[A-Za-z][A-Za-z0-9]*$/.test(segment))) {
    throw new Error("Raw path contains a non-canonical segment.");
  }
  if (segments.some((segment, index) => index > 0 && segment === segments[index - 1])) {
    throw new Error("Raw paths cannot contain duplicate adjacent segments.");
  }
  return segments.join("/");
}

export function assertAllowedRawRead(service: ServiceName, path: string): void {
  if (SENSITIVE_PATHS.has(path.toLowerCase())) {
    throw new Error("This operation returns a reusable credential and is not public.");
  }
  if (!RAW_READ_ALLOWLIST.has(`${service}\0${path}`)) {
    throw new Error(
      `Raw read is not allowlisted for (${service}, ${path}). Use a dedicated tool or the destructively annotated msads_raw_mutation tool.`,
    );
  }
}

function assertNonSensitiveRawPath(path: string): void {
  if (SENSITIVE_PATHS.has(path.toLowerCase())) {
    throw new Error("This operation returns a reusable credential and is not public.");
  }
}

function boundRawCollections(
  response: Record<string, unknown>,
  limit: number,
): Record<string, unknown> {
  const collections = Object.entries(response).filter(
    (entry): entry is [string, unknown[]] => Array.isArray(entry[1]),
  );
  const primary = collections[0];
  if (!primary) return response;

  const [primaryKey, primaryRows] = primary;
  const bounded = { ...response };
  delete bounded[primaryKey];
  const additional: Record<string, unknown> = {};
  for (const [key, rows] of collections.slice(1)) {
    const envelope = collectionEnvelope(key, rows, { limit });
    bounded[key] = envelope[key];
    additional[key] = {
      discovered: envelope.discovered,
      showing: envelope.showing,
      truncated: envelope.truncated,
      ...(envelope.guidance ? { guidance: envelope.guidance } : {}),
    };
  }
  return {
    ...bounded,
    ...collectionEnvelope(primaryKey, primaryRows, { limit }),
    ...(Object.keys(additional).length > 0
      ? { additional_collection_bounds: additional }
      : {}),
  };
}

async function rawScope(service: ServiceName, args: Record<string, unknown>) {
  const hasExplicitScope =
    args.account_id !== undefined || args.customer_id !== undefined;
  if (!isAccountScoped(service) && !hasExplicitScope) {
    return { accountId: "", customerId: undefined };
  }
  return resolveAccount({
    accountId: args.account_id as string | undefined,
    customerId: args.customer_id as string | undefined,
  });
}

export function registerRawTools(server: McpServer): void {
  readTool(
    server,
    "msads_raw_read",
    `Call a reviewed read operation on the Microsoft Advertising REST API that this server does not expose as a dedicated tool. The service/path pair must be in the literal allowlist maintained from docs/REST-PATHS.md; naming patterns do not establish that an operation is read-only.

${PATH_GUIDE}`,
    {
      service: z
        .enum(SERVICE_NAMES as [ServiceName, ...ServiceName[]])
        .describe("Target service."),
      path: z.string().describe('Path after /v13/, e.g. "Campaigns/QueryByAccountId".'),
      body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("JSON request body. Most read operations need one."),
      account_id: z.string().optional(),
      customer_id: z.string().optional(),
      limit: COLLECTION_LIMIT,
    },
    run(async (args: Record<string, unknown>) => {
      const service = args.service as ServiceName;
      const path = canonicalRawPath(String(args.path));
      assertAllowedRawRead(service, path);
      const scope = await rawScope(service, args);

      const response = await msadsFetch<Record<string, unknown>>(service, path, {
        method: "POST",
        body: args.body ?? {},
        ...(scope.accountId ? { accountId: scope.accountId } : {}),
        ...(scope.customerId ? { customerId: scope.customerId } : {}),
        retry: "safe",
      });
      return boundRawCollections(
        response,
        Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      );
    }),
  );

  destructiveTool(
    server,
    "msads_raw_mutation",
    `⚠️ WRITE OPERATION — Call an operation that is not on the reviewed raw-read allowlist. This surface is conservatively destructive because it can create, change, or permanently delete entities and can affect live ad spend.

${PATH_GUIDE}

Batch writes half-succeed: inspect PartialErrors and null result ids before assuming success. Prefer dedicated mutation tools where available because they validate rules that Microsoft otherwise ignores silently.`,
    {
      service: z
        .enum(SERVICE_NAMES as [ServiceName, ...ServiceName[]])
        .describe("Target service."),
      path: z.string().describe('Path after /v13/, e.g. "AdExtensions".'),
      method: z
        .enum(["POST", "PUT", "DELETE"])
        .describe("POST to add/apply, PUT to update, DELETE to remove."),
      body: z.record(z.string(), z.unknown()).describe("JSON request body."),
      account_id: z.string().optional(),
      customer_id: z.string().optional(),
    },
    run(async (args: Record<string, unknown>) => {
      const service = args.service as ServiceName;
      const path = canonicalRawPath(String(args.path));
      assertNonSensitiveRawPath(path);
      const scope = await rawScope(service, args);
      const response = await msadsFetch<Record<string, unknown>>(service, path, {
        method: args.method as "POST" | "PUT" | "DELETE",
        body: args.body,
        ...(scope.accountId ? { accountId: scope.accountId } : {}),
        ...(scope.customerId ? { customerId: scope.customerId } : {}),
      });

      const partialErrors = readPartialErrors(response);
      return {
        ...(partialErrors.length > 0 && {
          partial_failure: true,
          partial_errors: partialErrors,
        }),
        response,
      };
    }),
  );

  readTool(
    server,
    "msads_api_info",
    "Show how this server reaches the Microsoft Advertising API: the resolved base URL for each service, which environment is active, and which services take account headers. Useful when constructing a reviewed msads_raw_read or destructively annotated msads_raw_mutation call, or when diagnosing an environment mismatch (error 105).",
    {},
    run(async () => ({
      environment: getEnv().MSADS_ENVIRONMENT,
      api_version: "v13",
      protocol: "REST/JSON",
      services: Object.fromEntries(
        SERVICE_NAMES.map((s) => [
          s,
          { base_url: serviceBaseUrl(s), takes_account_headers: isAccountScoped(s) },
        ]),
      ),
      notes: [
        "Raw reads accept only reviewed service/path pairs from docs/REST-PATHS.md.",
        "Reads are POST with a JSON body, not GET.",
        "64-bit ids are serialized as JSON strings.",
        "SOAP stops receiving features 2026-10-01 and is removed 2027-01-31; this server uses REST only.",
      ],
    })),
  );
}
