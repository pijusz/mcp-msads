import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ext from "@/services/extensions";
import { AD_EXTENSION_UPDATE_WARNING, MATCH_TYPES } from "@/services/guardrails";
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

const ASSOCIATION_TYPE = z
  .enum(["Account", "Campaign", "AdGroup"])
  .describe("What the extensions attach to.");

export function registerExtensionTools(server: McpServer): void {
  defineRead(server, {
    name: "list_ad_extensions",
    title: "Ad extensions",
    priority: 0.75,
    description:
      "List ad extensions in the account's extension library — sitelinks, callouts, structured snippets, call, image, price, promotion, and review extensions.\n\n" +
      "Extensions live at account level and do nothing until associated with a campaign or ad group. Use list_ad_extension_associations to see what is actually attached where.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      extension_type: z
        .enum(ext.AD_EXTENSION_TYPES)
        .describe("Which extension type to list."),
      extension_ids: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Specific ids; omit for all."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const type = String(args.extension_type);

      const explicit = Array.isArray(args.extension_ids)
        ? args.extension_ids.map(String)
        : null;
      if (explicit) {
        const extensions = await ext.getAdExtensionsByIds(scope, explicit, type);
        return collectionEnvelope("ad_extensions", extensions, {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        });
      }

      // Without ids the API only hands back id↔entity associations, so fetch
      // those first and then the extensions they name.
      const associations = await ext.getAdExtensionIds(scope, type);
      const foundIds = [
        ...new Set(
          associations
            .map((a) => String((a as Record<string, unknown>).AdExtensionId ?? ""))
            .filter(Boolean),
        ),
      ];
      if (foundIds.length === 0) {
        return {
          ...collectionEnvelope("ad_extensions", [], {
            limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
          }),
          note: `No ${type} extensions in this account.`,
        };
      }
      const extensions = await ext.getAdExtensionsByIds(scope, foundIds, type);
      return {
        discovered_extension_ids: foundIds.length,
        ...collectionEnvelope("ad_extensions", extensions, {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        }),
      };
    },
  });

  defineRead(server, {
    name: "list_ad_extension_associations",
    title: "Ad extension associations",
    priority: 0.6,
    description:
      "Show which ad extensions are attached to which campaigns or ad groups. An extension in the library that is not associated with anything never serves.\n\n" +
      "Worth checking for callouts specifically: between 2 and 20 must be associated before any of them appear.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      entity_ids: z
        .array(z.string())
        .min(1)
        .max(MAX_COLLECTION_LIMIT)
        .describe("Campaign or ad group ids."),
      association_type: ASSOCIATION_TYPE,
      extension_types: z.array(z.string()).optional(),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const associations = await ext.getAdExtensionAssociations(
        scope,
        (args.entity_ids as string[]).map(String),
        String(args.association_type),
        Array.isArray(args.extension_types)
          ? args.extension_types.map(String)
          : undefined,
      );
      return collectionEnvelope("associations", associations, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  writeTool(
    server,
    "create_ad_extensions",
    `${WRITE}Create ad extensions in the account library.

Creating an extension does NOT make it serve — associate it with a campaign or ad group afterwards using associate_ad_extensions.

Shapes:
- Sitelink: { "Type": "SitelinkAdExtension", "DisplayText": "Free Shipping", "FinalUrls": ["https://..."], "Description1": "...", "Description2": "..." }
- Callout:  { "Type": "CalloutAdExtension", "Text": "24/7 Support" }
- Snippet:  { "Type": "StructuredSnippetAdExtension", "Header": "Brands", "Values": ["A","B"] }
- Call:     { "Type": "CallAdExtension", "PhoneNumber": "...", "CountryCode": "US" }

Association limits: 20 sitelinks, 20 callouts (but a minimum of 2 before any serve), 25 image extensions, and exactly 1 call extension, which is campaign-level only.`,
    {
      ...ACCOUNT_ARGS,
      ad_extensions: z
        .array(
          z
            .object({ Type: z.enum(ext.AD_EXTENSION_TYPES) })
            .passthrough()
            .describe("Extension object carrying its Type discriminator."),
        )
        .min(1)
        .max(BATCH_LIMITS.adExtensions),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return ext.addAdExtensions(scope, args.ad_extensions as Record<string, unknown>[]);
    }),
  );

  writeTool(
    server,
    "update_ad_extensions",
    `${WRITE}Update ad extensions.

${AD_EXTENSION_UPDATE_WARNING}

This is unlike almost every other entity in this API, which does support partial update. Call list_ad_extensions first and resend the complete object with your change applied.`,
    {
      ...ACCOUNT_ARGS,
      ad_extensions: z
        .array(z.object({ Id: z.string(), Type: z.string() }).passthrough())
        .min(1)
        .max(BATCH_LIMITS.adExtensions)
        .describe("Complete extension objects — omitted optional fields are CLEARED."),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const result = await ext.updateAdExtensions(
        scope,
        args.ad_extensions as Record<string, unknown>[],
      );
      return { ...result, warning: AD_EXTENSION_UPDATE_WARNING };
    }),
  );

  destructiveTool(
    server,
    "delete_ad_extensions",
    `${WRITE}Permanently delete ad extensions from the account library, removing them from every campaign and ad group they were associated with. To stop one serving in a single place while keeping it in the library, use remove_ad_extension_associations instead.`,
    {
      ...ACCOUNT_ARGS,
      extension_ids: z.array(z.string()).min(1).max(BATCH_LIMITS.adExtensions),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return ext.deleteAdExtensions(scope, (args.extension_ids as string[]).map(String));
    }),
  );

  writeTool(
    server,
    "associate_ad_extensions",
    `${WRITE}Attach ad extensions to campaigns or ad groups, which is what makes them serve.

Each association pairs an extension id with an entity id:
[{ "AdExtensionId": "123", "EntityId": "456" }]`,
    {
      ...ACCOUNT_ARGS,
      associations: z
        .array(
          z.object({ AdExtensionId: z.string(), EntityId: z.string() }).passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.adExtensions),
      association_type: ASSOCIATION_TYPE,
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return ext.setAdExtensionAssociations(
        scope,
        args.associations as Record<string, unknown>[],
        String(args.association_type),
      );
    }),
  );

  defineRead(server, {
    name: "list_negative_keywords",
    title: "Negative keywords",
    priority: 0.75,
    description:
      "List negative keywords set directly on campaigns or ad groups.\n\n" +
      "These are separate from shared negative keyword lists, which are managed independently. To find keywords being blocked by your own negatives, run the negative_keyword_conflicts report instead.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      entity_ids: z
        .array(z.string())
        .min(1)
        .max(1000)
        .describe(
          "Campaign ids, or exactly one ad group id when entity_type is AdGroup.",
        ),
      entity_type: z.enum(["Campaign", "AdGroup"]),
      parent_campaign_id: z
        .string()
        .optional()
        .describe("Required for AdGroup: the id of its containing campaign."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const result = await ext.getNegativeKeywords(
        scope,
        (args.entity_ids as string[]).map(String),
        args.entity_type as "Campaign" | "AdGroup",
        args.parent_campaign_id ? String(args.parent_campaign_id) : undefined,
      );
      return collectionEnvelope("entity_negative_keywords", result, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  destructiveTool(
    server,
    "delete_negative_keywords",
    `${WRITE}Remove negative keywords from a campaign or ad group.

Removing a negative WIDENS what the ads can show on, so it can increase spend. Take the ids from list_negative_keywords — an over-broad negative throttling good traffic is a common cause of sudden volume loss.`,
    {
      ...ACCOUNT_ARGS,
      entity_id: z.string().describe("Campaign or ad group id."),
      entity_type: z.enum(["Campaign", "AdGroup"]),
      keyword_ids: z
        .array(z.string())
        .min(1)
        .describe("Negative keyword ids from list_negative_keywords."),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return ext.deleteNegativeKeywords(
        scope,
        String(args.entity_id),
        args.entity_type as "Campaign" | "AdGroup",
        (args.keyword_ids as string[]).map(String),
      );
    }),
  );

  destructiveTool(
    server,
    "remove_ad_extension_associations",
    `${WRITE}Detach ad extensions from campaigns or ad groups WITHOUT deleting them.

This is what delete_ad_extensions points at: use this to stop an extension serving in one place while leaving it in the account library and attached elsewhere.`,
    {
      ...ACCOUNT_ARGS,
      associations: z
        .array(
          z.object({ AdExtensionId: z.string(), EntityId: z.string() }).passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.adExtensions),
      association_type: ASSOCIATION_TYPE,
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return ext.deleteAdExtensionAssociations(
        scope,
        args.associations as Record<string, unknown>[],
        String(args.association_type),
      );
    }),
  );

  defineRead(server, {
    name: "list_labels",
    title: "Labels",
    priority: 0.55,
    description:
      "List labels in the account. Labels tag campaigns, ad groups, ads, and keywords for grouping and reporting — a common way to mark entities as belonging to one client, product line, or test.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      label_ids: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Specific ids; omit for all."),
      page_index: z.number().int().min(0).optional().describe("Zero-based page."),
      page_size: z.number().int().min(1).max(1000).optional().describe("Default 200."),
    },
    handler: async (args) => {
      const scope = await ids(args);
      const pageIndex = Number(args.page_index ?? 0);
      const pageSize = Number(args.page_size ?? DEFAULT_COLLECTION_LIMIT);
      const labels = await ext.getLabels(
        scope,
        Array.isArray(args.label_ids) ? args.label_ids.map(String) : undefined,
        pageIndex,
        pageSize,
      );
      return {
        page_index: pageIndex,
        ...collectionEnvelope("labels", labels, {
          limit: pageSize,
          truncated: labels.length === pageSize,
          guidance: `Request page_index ${pageIndex + 1} to continue.`,
        }),
      };
    },
  });

  writeTool(
    server,
    "create_labels",
    `${WRITE}Create labels. Names are case-sensitive and must be unique within the account (1–80 characters).`,
    {
      ...ACCOUNT_ARGS,
      labels: z
        .array(
          z
            .object({
              Name: z.string().min(1).max(80),
              Description: z.string().max(200).optional(),
              ColorCode: z.string().optional().describe('Hex colour, e.g. "#FF0000".'),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.labels),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return ext.addLabels(scope, args.labels as Record<string, unknown>[]);
    }),
  );

  writeTool(
    server,
    "apply_labels",
    `${WRITE}Attach labels to campaigns, ad groups, ads, or keywords.

Each association pairs a label with an entity: [{ "LabelId": "1", "EntityId": "900001" }]`,
    {
      ...ACCOUNT_ARGS,
      associations: z
        .array(z.object({ LabelId: z.string(), EntityId: z.string() }).passthrough())
        .min(1)
        .max(BATCH_LIMITS.labels),
      entity_type: z
        .enum(["Campaign", "AdGroup", "Ad", "Keyword"])
        .describe("What the entity ids refer to."),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return ext.setLabelAssociations(
        scope,
        args.associations as Record<string, unknown>[],
        String(args.entity_type),
      );
    }),
  );

  writeTool(
    server,
    "add_negative_keywords",
    `${WRITE}Add negative keywords to one campaign or ad group, stopping ads from showing on those searches.

Match types are Broad, Phrase, and Exact. A phrase negative usually covers a whole cluster of unwanted searches where individual exact negatives would not.

Limits: up to ${ext.NEGATIVE_KEYWORD_LIMIT} per entity. Campaign-level negatives apply to every ad group beneath.`,
    {
      ...ACCOUNT_ARGS,
      entity_id: z.string().describe("Campaign or ad group id."),
      entity_type: z.enum(["Campaign", "AdGroup"]),
      keywords: z
        .array(
          z.object({
            Text: z.string().max(100),
            MatchType: z.enum(MATCH_TYPES),
          }),
        )
        .min(1)
        .max(ext.NEGATIVE_KEYWORD_LIMIT),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return ext.addNegativeKeywords(
        scope,
        String(args.entity_id),
        args.entity_type as "Campaign" | "AdGroup",
        args.keywords as Array<{ Text: string; MatchType: string }>,
      );
    }),
  );
}
