import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as capi from "@/services/capi";
import * as cv from "@/services/conversions";
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

export function registerConversionTools(server: McpServer): void {
  defineRead(server, {
    name: "list_uet_tags",
    title: "UET tags",
    uriTemplate: "msads://account/{accountId}/uet-tags",
    uriVars: { accountId: "account_id" },
    priority: 0.7,
    description:
      "List Universal Event Tracking tags on the account, including the tracking script for each. UET tags are what feed conversion goals and remarketing lists — without one, neither works.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      tag_ids: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Specific ids; omit for all."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const tags = await cv.getUetTags(
        scope,
        Array.isArray(args.tag_ids) ? args.tag_ids.map(String) : undefined,
      );
      return collectionEnvelope("uet_tags", tags, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  writeTool(
    server,
    "create_uet_tags",
    `${WRITE}Create UET tags. The response includes the tracking script to install on the site. Data does not begin flowing until that script is live.`,
    {
      ...ACCOUNT_ARGS,
      uet_tags: z
        .array(
          z
            .object({
              Name: z.string().max(100),
              Description: z.string().max(1000).optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.uetTags),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return cv.addUetTags(scope, args.uet_tags as Record<string, unknown>[]);
    }),
  );

  defineRead(server, {
    name: "list_conversion_goals",
    title: "Conversion goals",
    uriTemplate: "msads://account/{accountId}/conversion-goals",
    uriVars: { accountId: "account_id" },
    priority: 0.8,
    description:
      "List conversion goals with their type, attribution model, conversion window, revenue settings, and tracking status.\n\n" +
      "TrackingStatus is worth reading closely: a goal that has never recorded a conversion usually means the UET tag is missing or misconfigured, not that nothing converted.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      goal_ids: z.array(z.string()).max(MAX_COLLECTION_LIMIT).optional(),
      goal_types: z
        .array(z.enum(cv.CONVERSION_GOAL_FILTER_TYPES))
        .optional()
        .describe(
          "Filter to certain goal types. Note these differ from the Type used when CREATING a goal — Url here, UrlGoal there. " +
            "InStoreTransaction is pilot-gated and excluded by default; passing it without the pilot fails the whole call.",
        ),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const goals = await cv.getConversionGoals(
        scope,
        Array.isArray(args.goal_ids) ? args.goal_ids.map(String) : undefined,
        Array.isArray(args.goal_types) ? args.goal_types.map(String) : undefined,
      );
      return collectionEnvelope("conversion_goals", goals, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  writeTool(
    server,
    "create_conversion_goals",
    `${WRITE}Create conversion goals.

Each goal needs a Type and the TagId of the UET tag that feeds it:
- UrlGoal: fires when a URL is visited — { "Type": "UrlGoal", "Name": "Purchase", "TagId": "123", "UrlExpression": "/thank-you", "UrlOperator": "Contains" }
- EventGoal: fires on a custom UET event
- DurationGoal / PagesViewedPerVisitGoal: engagement goals
- OfflineConversionGoal: for conversions uploaded via upload_offline_conversions

Scope is immutable after creation. An OfflineConversionGoal needs about 2 hours before it will accept uploaded conversions.`,
    {
      ...ACCOUNT_ARGS,
      conversion_goals: z
        .array(
          z
            .object({
              Type: z.enum(cv.CONVERSION_GOAL_TYPES),
              Name: z.string().max(100),
              TagId: z.string().optional().describe("UET tag id feeding this goal."),
              Scope: z
                .enum(["Account", "Customer"])
                .optional()
                .describe("Immutable once set."),
              ConversionWindowInMinutes: z
                .number()
                .int()
                .min(1)
                .max(129_600)
                .optional()
                .describe("Up to 90 days."),
              CountType: z.enum(["All", "Unique"]).optional(),
              Revenue: z.record(z.string(), z.unknown()).optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.conversionGoals),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return cv.addConversionGoals(
        scope,
        args.conversion_goals as Record<string, unknown>[],
      );
    }),
  );

  writeTool(
    server,
    "update_conversion_goals",
    `${WRITE}Update conversion goals — rename them, change the conversion window, revenue value, or count type.

Each entry needs its Id and Type. Scope cannot be changed after creation.`,
    {
      ...ACCOUNT_ARGS,
      conversion_goals: z
        .array(
          z
            .object({
              Id: z.string(),
              Type: z.enum(cv.CONVERSION_GOAL_TYPES),
              Name: z.string().max(100).optional(),
              ConversionWindowInMinutes: z.number().int().min(1).max(129_600).optional(),
              CountType: z.enum(["All", "Unique"]).optional(),
              Revenue: z.record(z.string(), z.unknown()).optional(),
              Status: z.enum(["Active", "Paused"]).optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.conversionGoals),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return cv.updateConversionGoals(
        scope,
        args.conversion_goals as Record<string, unknown>[],
      );
    }),
  );

  writeTool(
    server,
    "upload_offline_conversions",
    `${WRITE}Upload conversions that happened away from the website — a phone sale, an in-store purchase, a CRM-qualified lead.

Each conversion needs an identity, and one of two things provides it:
- microsoft_click_id: the msclkid captured on the ad click. The strongest signal.
- email / phone: enhanced conversions. Pass PLAINTEXT — this server normalizes and SHA-256 hashes them before sending; they never leave the process in the clear.

conversion_name must match an existing conversion goal name EXACTLY. A mismatch is not an error — the data is accepted and silently discarded.

Timing rules: conversion_time is ISO 8601 UTC, must be after the click, and must fall within the last 90 days. A goal created less than 2 hours ago may not accept data yet, and uploaded conversions take up to 6 hours to appear in reporting.

For conversions from the last 7 days, send_conversion_events is lower-latency and gives per-event validation feedback; this tool is the right one for anything older, up to 90 days.

This operation returns no per-item confirmation. An empty error list is the only success signal there is.`,
    {
      ...ACCOUNT_ARGS,
      conversions: z
        .array(
          z.object({
            conversion_name: z
              .string()
              .describe("Must match an existing conversion goal name exactly."),
            conversion_time: z
              .string()
              .describe("ISO 8601 UTC, e.g. 2026-08-17T14:30:00Z."),
            microsoft_click_id: z
              .string()
              .optional()
              .describe("The msclkid from the click."),
            email: z.string().optional().describe("Plaintext; hashed before sending."),
            phone: z
              .string()
              .optional()
              .describe("Plaintext E.164; hashed before sending."),
            default_country_code: z
              .string()
              .optional()
              .describe("Country code for phones lacking one."),
            conversion_value: z.number().optional(),
            conversion_currency_code: z.string().optional(),
            external_attribution_credit: z
              .number()
              .optional()
              .describe("Fraction of the conversion for this click, >0 and <=1."),
            external_attribution_model: z.string().optional(),
          }),
        )
        .min(1)
        .max(BATCH_LIMITS.offlineConversions),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const conversions = (args.conversions as Array<Record<string, unknown>>).map(
        (c) => ({
          conversionName: String(c.conversion_name),
          conversionTime: String(c.conversion_time),
          ...(c.microsoft_click_id
            ? { microsoftClickId: String(c.microsoft_click_id) }
            : {}),
          ...(c.email ? { email: String(c.email) } : {}),
          ...(c.phone ? { phone: String(c.phone) } : {}),
          ...(c.default_country_code
            ? { defaultCountryCode: String(c.default_country_code) }
            : {}),
          ...(c.conversion_value !== undefined
            ? { conversionValue: Number(c.conversion_value) }
            : {}),
          ...(c.conversion_currency_code
            ? { conversionCurrencyCode: String(c.conversion_currency_code) }
            : {}),
          ...(c.external_attribution_credit !== undefined
            ? { externalAttributionCredit: Number(c.external_attribution_credit) }
            : {}),
          ...(c.external_attribution_model
            ? { externalAttributionModel: String(c.external_attribution_model) }
            : {}),
        }),
      );
      return cv.applyOfflineConversions(scope, conversions);
    }),
  );

  destructiveTool(
    server,
    "adjust_offline_conversions",
    `${WRITE}Restate or retract a conversion already uploaded — a refund, a cancelled order, or a corrected value.

Restate changes the value and requires adjustment_value. Retract cancels the conversion entirely and must NOT carry a value.

conversion_time identifies the ORIGINAL conversion; adjustment_time is when the change happened and cannot precede it.`,
    {
      ...ACCOUNT_ARGS,
      adjustments: z
        .array(
          z.object({
            conversion_name: z.string(),
            conversion_time: z
              .string()
              .describe("ISO 8601 UTC of the ORIGINAL conversion."),
            adjustment_time: z.string().describe("ISO 8601 UTC of the adjustment."),
            adjustment_type: z.enum(["Restate", "Retract"]),
            adjustment_value: z
              .number()
              .optional()
              .describe("Required for Restate only."),
            adjustment_currency_code: z.string().optional(),
            microsoft_click_id: z.string().optional(),
            email: z.string().optional().describe("Plaintext; hashed before sending."),
            phone: z.string().optional().describe("Plaintext; hashed before sending."),
            default_country_code: z.string().optional(),
          }),
        )
        .min(1)
        .max(BATCH_LIMITS.offlineConversions),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const adjustments = (args.adjustments as Array<Record<string, unknown>>).map(
        (a) => ({
          conversionName: String(a.conversion_name),
          conversionTime: String(a.conversion_time),
          adjustmentTime: String(a.adjustment_time),
          adjustmentType: a.adjustment_type as "Restate" | "Retract",
          ...(a.adjustment_value !== undefined
            ? { adjustmentValue: Number(a.adjustment_value) }
            : {}),
          ...(a.adjustment_currency_code
            ? { adjustmentCurrencyCode: String(a.adjustment_currency_code) }
            : {}),
          ...(a.microsoft_click_id
            ? { microsoftClickId: String(a.microsoft_click_id) }
            : {}),
          ...(a.email ? { email: String(a.email) } : {}),
          ...(a.phone ? { phone: String(a.phone) } : {}),
          ...(a.default_country_code
            ? { defaultCountryCode: String(a.default_country_code) }
            : {}),
        }),
      );
      return cv.applyOfflineConversionAdjustments(scope, adjustments);
    }),
  );

  writeTool(
    server,
    "send_conversion_events",
    `${WRITE}Send conversion events server-side through the Microsoft Conversions API.

This is the server-side counterpart to the UET JavaScript tag, for conversions a browser tag cannot observe. The per-tag credential is fetched internally after this server authorizes the requested account and is never exposed in MCP context.

Each event needs at least one identifier. Pass email/phone as PLAINTEXT and they are normalized and hashed here; msclkid, anonymous_id, and external_id are opaque and sent as given.

event_time is Unix SECONDS in UTC (not milliseconds) and must fall within the last 7 days. Older conversions belong in upload_offline_conversions.

If the same conversion is also sent by the UET JavaScript tag, use the same tag id, event_id, and event_name on both so they deduplicate rather than double-count.

Up to ${capi.MAX_EVENTS_PER_BATCH} events per call. A warning in the response means the event was accepted with a field silently dropped, which is partial data loss rather than success.`,
    {
      ...ACCOUNT_ARGS,
      tag_id: z.string().describe("UET tag id owned by the selected account."),
      events: z
        .array(
          z.object({
            event_type: z.enum(["pageLoad", "custom"]),
            event_name: z.string(),
            event_id: z.string().optional().describe("Stable id, for deduplication."),
            event_time: z
              .number()
              .int()
              .optional()
              .describe("Unix SECONDS UTC. Default now."),
            event_source_url: z.string().optional(),
            msclkid: z.string().optional(),
            email: z.string().optional().describe("Plaintext; hashed before sending."),
            phone: z.string().optional().describe("Plaintext; hashed before sending."),
            anonymous_id: z
              .string()
              .optional()
              .describe("Must match the ID-sync pixel VID."),
            external_id: z.string().optional(),
            client_user_agent: z.string().optional(),
            client_ip_address: z.string().optional(),
            custom_data: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'e.g. { "value": 99.5, "currency": "USD", "transactionId": "T-1" }',
              ),
          }),
        )
        .min(1)
        .max(capi.MAX_EVENTS_PER_BATCH),
      continue_on_validation_error: z
        .boolean()
        .optional()
        .describe("Default true, so one bad event does not fail the batch."),
    },
    run(async (args: Record<string, unknown>) => {
      const events: capi.CapiEvent[] = (
        args.events as Array<Record<string, unknown>>
      ).map((e) => ({
        eventType: e.event_type as capi.CapiEventType,
        eventName: String(e.event_name),
        ...(e.event_id ? { eventId: String(e.event_id) } : {}),
        ...(e.event_time !== undefined ? { eventTime: Number(e.event_time) } : {}),
        ...(e.event_source_url ? { eventSourceUrl: String(e.event_source_url) } : {}),
        userData: capi.buildUserData({
          ...(e.msclkid ? { msclkid: String(e.msclkid) } : {}),
          ...(e.email ? { email: String(e.email) } : {}),
          ...(e.phone ? { phone: String(e.phone) } : {}),
          ...(e.anonymous_id ? { anonymousId: String(e.anonymous_id) } : {}),
          ...(e.external_id ? { externalId: String(e.external_id) } : {}),
          ...(e.client_user_agent
            ? { clientUserAgent: String(e.client_user_agent) }
            : {}),
          ...(e.client_ip_address
            ? { clientIpAddress: String(e.client_ip_address) }
            : {}),
        }),
        ...(e.custom_data ? { customData: e.custom_data as capi.CapiCustomData } : {}),
      }));

      const scope = await ids(args);
      const tagId = String(args.tag_id);
      const authKey = await cv.getUetTagAuthKey(scope, tagId);
      const result = await capi.sendEvents(
        tagId,
        authKey,
        events,
        args.continue_on_validation_error !== undefined
          ? { continueOnValidationError: args.continue_on_validation_error === true }
          : {},
      );

      return {
        ...result,
        ...(result.warnings.length > 0 && {
          warning_note:
            "Events were accepted but Microsoft dropped the fields that produced warnings. Those events landed with less data than was sent.",
        }),
      };
    }),
  );
}
