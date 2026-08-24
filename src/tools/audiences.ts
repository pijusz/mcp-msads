import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as aud from "@/services/audiences";
import { ACCOUNT_ARGS, ids, WRITE } from "@/tools/_shared";
import { BATCH_LIMITS } from "@/utils/batch";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
} from "@/utils/collection";
import { defineRead } from "@/utils/define-read";
import { destructiveTool, writeTool } from "@/utils/register-tool";
import { run } from "@/utils/tool-response";

const CUSTOMER_LIST_ARGS = {
  ...ACCOUNT_ARGS,
  audience_id: z.string().describe("Id of an existing CustomerList audience."),
  emails: z
    .array(z.string())
    .min(1)
    .max(aud.CUSTOMER_LIST_MAX_ITEMS)
    .describe("Plaintext or pre-hashed email addresses."),
};

function customerListHandler(action: aud.CustomerListAction) {
  return run(async (args: Record<string, unknown>) => {
    const scope = await ids(args);
    return aud.applyCustomerList(scope, {
      audienceId: String(args.audience_id),
      action,
      emails: (args.emails as string[]).map(String),
    });
  });
}

export function registerAudienceTools(server: McpServer): void {
  defineRead(server, {
    name: "list_audiences",
    title: "Audiences",
    uriTemplate: "msads://account/{accountId}/audiences",
    uriVars: { accountId: "account_id" },
    priority: 0.8,
    description:
      "List audiences available to the account — remarketing lists, customer lists, in-market audiences, product audiences, and combined lists — with their sizes and membership durations.\n\n" +
      "SearchSize and AudienceNetworkSize tell you whether an audience is actually usable: roughly 1,000 members are needed before it can be targeted.\n\n" +
      "This is the account's audience LIBRARY. To see which audiences a campaign or ad group actually targets, use list_targeting with a criterion_type of RemarketingList, CustomAudience, or InMarketAudience.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      audience_ids: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Specific ids; omit for all."),
      type: z
        .string()
        .optional()
        .describe("Filter to one type, e.g. RemarketingList or CustomerList."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const audiences = await aud.getAudiencesByIds(
        scope,
        Array.isArray(args.audience_ids) ? args.audience_ids.map(String) : undefined,
        args.type ? String(args.type) : undefined,
      );
      return collectionEnvelope("audiences", audiences, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  writeTool(
    server,
    "create_audiences",
    `${WRITE}Create audiences — remarketing lists, customer (customer-match) lists, product audiences, combined lists, or impression-based remarketing lists.

Not every audience type can be created. In-market audiences are curated by Microsoft, similar audiences are generated from a source list, and custom audiences come from a data-management platform — those can be targeted but not created here.

A RemarketingList needs a Rule and the TagId of the UET tag that feeds it. A CustomerList is created empty; add members afterwards with add_customer_list_members.`,
    {
      ...ACCOUNT_ARGS,
      audiences: z
        .array(
          z
            .object({
              Type: z.enum(aud.CREATABLE_AUDIENCE_TYPES),
              Name: z.string().max(128),
              Description: z.string().max(1024).optional(),
              MembershipDuration: z
                .number()
                .int()
                .optional()
                .describe(
                  "Days. 1–180 for most types; 1–390 or -1 (never expires) for CustomerList.",
                ),
              Scope: z
                .enum(["Account", "Customer"])
                .optional()
                .describe(
                  "Customer scope shares it across the manager account. One-way.",
                ),
              TagId: z
                .string()
                .optional()
                .describe("UET tag id. Required for RemarketingList."),
              Rule: z
                .record(z.string(), z.unknown())
                .optional()
                .describe('Remarketing rule, e.g. { "Type": "PageVisitors", ... }'),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.audiences),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return aud.addAudiences(scope, args.audiences as Record<string, unknown>[]);
    }),
  );

  writeTool(
    server,
    "update_audiences",
    `${WRITE}Update audiences. Each entry needs its Id. Note that only remarketing lists and custom audiences can be updated; for a custom audience only Name and Description are editable.`,
    {
      ...ACCOUNT_ARGS,
      audiences: z
        .array(
          z
            .object({
              Id: z.string(),
              Type: z.enum(aud.UPDATEABLE_AUDIENCE_TYPES),
              Name: z.string().max(128).optional(),
              Description: z.string().max(1024).optional(),
              MembershipDuration: z.number().int().optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.audiences),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return aud.updateAudiences(scope, args.audiences as Record<string, unknown>[]);
    }),
  );

  destructiveTool(
    server,
    "delete_audiences",
    `${WRITE}Permanently delete audiences. Any campaign or ad group targeting them loses that targeting, and the accumulated membership cannot be recovered — a rebuilt list starts empty and takes weeks to re-accumulate.`,
    {
      ...ACCOUNT_ARGS,
      audience_ids: z.array(z.string()).min(1).max(BATCH_LIMITS.audiences),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return aud.deleteAudiences(scope, (args.audience_ids as string[]).map(String));
    }),
  );

  writeTool(
    server,
    "add_customer_list_members",
    `${WRITE}Add email addresses to a customer-match audience without removing existing members.

Emails are normalized and SHA-256 hashed inside this server before anything is sent. Only email is supported. At most ${aud.CUSTOMER_LIST_MAX_ITEMS} addresses are accepted per call; matching takes around 48 hours and roughly 1,000 matched users are needed before targeting.`,
    CUSTOMER_LIST_ARGS,
    customerListHandler("Add"),
  );

  destructiveTool(
    server,
    "remove_customer_list_members",
    `${WRITE}Remove email addresses from a customer-match audience. This permanently removes those members from the list.

Emails are normalized and SHA-256 hashed inside this server before anything is sent. At most ${aud.CUSTOMER_LIST_MAX_ITEMS} addresses are accepted per call.`,
    CUSTOMER_LIST_ARGS,
    customerListHandler("Remove"),
  );

  destructiveTool(
    server,
    "replace_customer_list_members",
    `${WRITE}Replace every member of a customer-match audience with the supplied email addresses. Existing members not present in this upload are permanently removed.

Emails are normalized and SHA-256 hashed inside this server before anything is sent. At most ${aud.CUSTOMER_LIST_MAX_ITEMS} addresses are accepted per call; matching takes around 48 hours.`,
    CUSTOMER_LIST_ARGS,
    customerListHandler("Replace"),
  );
}
